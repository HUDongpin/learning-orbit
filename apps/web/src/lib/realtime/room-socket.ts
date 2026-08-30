import {
  realtimeContract,
  routes,
  type RoomCommand,
  type RoomEventEnvelope,
  type ServerFrame,
} from "@learning-orbit/contracts";
import { isRoomId } from "../session/room-route";

export interface SocketLike {
  readonly readyState?: number;
  send(data: string): void;
  close?(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (event: { data?: unknown; code?: number }) => void): void;
}

export interface RoomSocketOptions {
  readonly retryDelaysMs?: readonly number[];
  readonly storageKeyPrefix?: string;
  readonly clientId?: string;
  readonly now?: () => number;
  readonly onSessionExpired?: () => void;
  readonly onRoomUnavailable?: (code: 4403 | 4410) => void;
  readonly onConnectionChange?: (connected: boolean) => void;
  readonly onProtocolError?: () => void;
}

type EventSink = (event: RoomEventEnvelope) => void;
type ControlSink = (frame: ServerFrame) => void;
type ConnectFactory = () => SocketLike;

const OPEN = 1;
const MAX_PENDING_COMMANDS = 100;

export function roomWebSocketUrl(
  roomId: string,
  location: Readonly<{ protocol: string; host: string }> = globalThis.location,
): string {
  if (!isRoomId(roomId)) throw new Error("INVALID_ROOM_ID");
  if (location.protocol !== "https:" && location.protocol !== "http:") throw new Error("INVALID_PUBLIC_ORIGIN");
  if (!location.host || /[/?#@\\]/u.test(location.host)) throw new Error("INVALID_PUBLIC_ORIGIN");
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${routes.rooms.websocket(roomId)}`;
}

function makeClientId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  // This fallback is only for older test environments; it is not an identity.
  return "00000000-0000-4000-8000-000000000000";
}

function isOpen(socket: SocketLike): boolean {
  return socket.readyState === undefined || socket.readyState === OPEN;
}

/**
 * Small, transport-agnostic browser state machine for at-least-once room WS.
 * It stores only the last durable room sequence and pending command envelopes;
 * projections and ephemeral frames are deliberately left to the caller.
 */
export class RoomSocket {
  readonly clientId: string;
  lastRoomSeq: number;

  #readonlyRoomId: string;
  #storage: Storage;
  #storageKey: string;
  #sink: EventSink;
  #controlSink: ControlSink;
  #pending = new Map<string, RoomCommand>();
  #retryDelays: readonly number[];
  #retryIndex = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectGate: Promise<void> | undefined;
  #socket: SocketLike | undefined;
  #connectFactory: ConnectFactory | undefined;
  #closed = false;
  #resumeReady = false;
  #now: () => number;
  #onSessionExpired: () => void;
  #onRoomUnavailable: (code: 4403 | 4410) => void;
  #onConnectionChange: (connected: boolean) => void;
  #onProtocolError: () => void;

  constructor(
    roomId: string,
    storage: Storage,
    sink: EventSink,
    options: RoomSocketOptions = {},
    controlSink: ControlSink = () => undefined,
  ) {
    this.#readonlyRoomId = roomId;
    this.#storage = storage;
    this.#storageKey = `${options.storageKeyPrefix ?? "lo"}:${roomId}:seq`;
    this.#sink = sink;
    this.#controlSink = controlSink;
    this.#retryDelays = options.retryDelaysMs ?? [500, 1_000, 2_000, 4_000, 8_000];
    this.#now = options.now ?? Date.now;
    this.#onSessionExpired = options.onSessionExpired ?? (() => undefined);
    this.#onRoomUnavailable = options.onRoomUnavailable ?? (() => undefined);
    this.#onConnectionChange = options.onConnectionChange ?? (() => undefined);
    this.#onProtocolError = options.onProtocolError ?? (() => undefined);
    this.clientId = options.clientId ?? makeClientId();
    const saved = Number(storage.getItem(this.#storageKey) ?? "0");
    this.lastRoomSeq = Number.isSafeInteger(saved) && saved >= 0 ? saved : 0;
  }

  get roomId(): string {
    return this.#readonlyRoomId;
  }

  hello(): { type: "hello"; clientId: string; resumeFrom: number } {
    return { type: "hello", clientId: this.clientId, resumeFrom: this.lastRoomSeq };
  }

  pendingCommandIds(): string[] {
    return [...this.#pending.keys()];
  }

  /**
   * Prevent a replacement socket from sending an obsolete resume cursor while
   * an authenticated RoomEvent page recovery is still in flight.
   */
  deferReconnectUntil(recovery: Promise<void>): void {
    this.#reconnectGate = recovery;
  }

  send(command: RoomCommand, socket: SocketLike = this.#socket ?? { send: () => undefined }): void {
    // Validate before storing so forged or malformed commands never become
    // automatic reconnect retries.
    const encoded = realtimeContract.encodeRoomCommand(command);
    const existing = this.#pending.get(command.commandId);
    if (existing && realtimeContract.encodeRoomCommand(existing) !== encoded) throw new Error("COMMAND_ID_CONFLICT");
    if (!existing && this.#pending.size >= MAX_PENDING_COMMANDS) throw new Error("PENDING_COMMAND_LIMIT");
    const stable = existing ?? command;
    if (!existing) this.#pending.set(command.commandId, stable);
    if (this.#resumeReady && isOpen(socket)) {
      try {
        socket.send(realtimeContract.encodeClientFrame({ type: "command", command: stable }));
      } catch {
        try { socket.close?.(1011, "command send failed"); } catch { /* reconnect below */ }
        if (this.#socket === socket) this.onClose();
      }
    }
  }

  onFrame(value: unknown, socket: SocketLike = this.#socket ?? { send: () => undefined }): void {
    const frame = realtimeContract.parseServerFrame(value);
    if (frame.type === "event") {
      this.#acceptEvent(frame.event);
    } else if (frame.type === "resume_complete") {
      if (frame.throughRoomSeq !== this.lastRoomSeq) {
        this.#controlSink({
          type: "snapshot_required",
          afterSeq: this.lastRoomSeq,
          throughRoomSeq: Math.max(this.lastRoomSeq, frame.throughRoomSeq),
        });
        return;
      }
      this.#retryIndex = 0;
      this.#resumeReady = true;
      this.#onConnectionChange(true);
      this.#flushPending(socket);
      this.#controlSink(frame);
    } else if (frame.type === "snapshot_required") {
      // The caller must fetch an authorized snapshot. We still expose this
      // control frame and do not mutate the durable cursor optimistically.
      this.#controlSink(frame);
    } else if (frame.type === "ack") {
      this.#pending.delete(frame.commandId);
      // An acknowledgement is not a durable event delivery. Advancing the
      // replay cursor here could skip an event that is still in flight; only a
      // contiguous `event` frame is allowed to move lastRoomSeq.
      this.#controlSink(frame);
    } else if (frame.type === "reject") {
      if (frame.commandId && !frame.retryable) this.#pending.delete(frame.commandId);
      this.#controlSink(frame);
    } else {
      this.#controlSink(frame);
    }
  }

  connect(factory: ConnectFactory): SocketLike {
    this.#closed = false;
    this.#resumeReady = false;
    this.#connectFactory = factory;
    this.#clearRetry();
    this.#onConnectionChange(false);
    const socket = factory();
    this.#socket = socket;
    socket.addEventListener?.("open", () => {
      if (!this.#closed && this.#socket === socket) {
        this.#sendHello(socket);
      }
    });
    socket.addEventListener?.("message", (event) => {
      if (this.#closed || this.#socket !== socket) return;
      try {
        const value = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        this.onFrame(value, socket);
      } catch {
        this.#protocolFailure(socket);
      }
    });
    socket.addEventListener?.("close", (event) => {
      if (this.#socket === socket) this.onClose(event.code);
    });
    if (isOpen(socket)) {
      this.#sendHello(socket);
    }
    return socket;
  }

  onClose(code?: number): void {
    if (this.#closed) return;
    this.#socket = undefined;
    this.#resumeReady = false;
    this.#onConnectionChange(false);
    if (code === 4400) {
      this.#closed = true;
      this.#clearRetry();
      this.#onProtocolError();
      return;
    }
    if (code === 4401) {
      this.#closed = true;
      this.#clearRetry();
      this.#onSessionExpired();
      return;
    }
    if (code === 4403 || code === 4410) {
      this.#closed = true;
      this.#clearRetry();
      this.#onRoomUnavailable(code);
      return;
    }
    if (code === 4409 && !this.#reconnectGate) {
      this.#closed = true;
      this.#clearRetry();
      this.#onProtocolError();
      return;
    }
    const gate = this.#reconnectGate;
    if (gate) {
      void gate.then(
        () => {
          if (this.#reconnectGate === gate) this.#reconnectGate = undefined;
          this.#scheduleReconnect();
        },
        () => {
          if (this.#reconnectGate === gate) this.#reconnectGate = undefined;
        },
      );
      return;
    }
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#closed || !this.#connectFactory || this.#retryTimer) return;
    const delay = this.#retryDelays[Math.min(this.#retryIndex, this.#retryDelays.length - 1)];
    if (delay === undefined) return;
    this.#retryIndex += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (!this.#closed && this.#connectFactory) this.connect(this.#connectFactory);
    }, Math.max(0, delay));
  }

  close(): void {
    this.#closed = true;
    this.#resumeReady = false;
    this.#clearRetry();
    this.#socket?.close?.(1000, "client closed");
    this.#socket = undefined;
    this.#onConnectionChange(false);
  }

  destroy(): void {
    this.close();
    this.#pending.clear();
    this.#storage.removeItem(this.#storageKey);
    this.#readonlyRoomId = "";
    this.#storageKey = "";
    this.lastRoomSeq = 0;
    this.#reconnectGate = undefined;
    this.#connectFactory = undefined;
  }

  #flushPending(socket: SocketLike): void {
    for (const command of this.#pending.values()) this.send(command, socket);
  }

  #sendHello(socket: SocketLike): void {
    socket.send(realtimeContract.encodeClientFrame(this.hello()));
  }

  #protocolFailure(socket: SocketLike): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearRetry();
    if (this.#socket === socket) this.#socket = undefined;
    this.#onConnectionChange(false);
    socket.close?.(4400, "invalid server frame");
    this.#onProtocolError();
  }

  #acceptEvent(event: RoomEventEnvelope): void {
    if (event.roomId !== this.#readonlyRoomId || event.roomSeq <= this.lastRoomSeq) return;
    // A server replay must be monotonic. If a gap arrives, expose it to the
    // caller without jumping the cursor; the next resume will repair it.
    if (event.roomSeq !== this.lastRoomSeq + 1) {
      this.#controlSink({ type: "snapshot_required", afterSeq: this.lastRoomSeq, throughRoomSeq: event.roomSeq - 1 });
      return;
    }
    this.#acceptCursor(event.roomSeq);
    this.#sink(event);
  }

  #acceptCursor(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < this.lastRoomSeq) return;
    this.lastRoomSeq = seq;
    this.#storage.setItem(this.#storageKey, String(seq));
  }

  #clearRetry(): void {
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }
}
