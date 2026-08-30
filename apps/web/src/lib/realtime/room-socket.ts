import {
  realtimeContract,
  type RoomCommand,
  type RoomEventEnvelope,
  type RealtimeFrame,
} from "@learning-orbit/contracts";

export interface SocketLike {
  readonly readyState?: number;
  send(data: string): void;
  close?(code?: number, reason?: string): void;
}

export interface RoomSocketOptions {
  readonly retryDelaysMs?: readonly number[];
  readonly storageKeyPrefix?: string;
  readonly clientId?: string;
  readonly now?: () => number;
}

type EventSink = (event: RoomEventEnvelope) => void;
type ControlSink = (frame: RealtimeFrame) => void;
type ConnectFactory = () => SocketLike;

const OPEN = 1;

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
  #seen = new Set<string>();
  #retryDelays: readonly number[];
  #retryIndex = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #socket: SocketLike | undefined;
  #connectFactory: ConnectFactory | undefined;
  #closed = false;
  #now: () => number;

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

  send(command: RoomCommand, socket: SocketLike = this.#socket ?? { send: () => undefined }): void {
    // Validate before storing so forged or malformed commands never become
    // automatic reconnect retries.
    const encoded = realtimeContract.encodeRoomCommand(command);
    this.#pending.set(command.commandId, command);
    if (isOpen(socket)) socket.send(JSON.stringify({ type: "command", command: JSON.parse(encoded) }));
  }

  onFrame(value: unknown, socket: SocketLike = this.#socket ?? { send: () => undefined }): void {
    const frame = realtimeContract.parseRealtimeFrame(value);
    if (frame.type === "event") {
      this.#acceptEvent(frame.event);
    } else if (frame.type === "resume_complete") {
      this.#retryIndex = 0;
      this.#flushPending(socket);
    } else if (frame.type === "snapshot_required") {
      // The caller must fetch an authorized snapshot. We still expose this
      // control frame and do not mutate the durable cursor optimistically.
      this.#controlSink(frame);
    } else if (frame.type === "ack") {
      this.#pending.delete(frame.commandId);
      // An acknowledgement is not a durable event delivery. Advancing the
      // replay cursor here could skip an event that is still in flight; only a
      // contiguous `event` frame is allowed to move lastRoomSeq.
    } else if (frame.type === "reject") {
      if (frame.commandId && !frame.retryable) this.#pending.delete(frame.commandId);
      this.#controlSink(frame);
    } else {
      this.#controlSink(frame);
    }
  }

  connect(factory: ConnectFactory): SocketLike {
    this.#closed = false;
    this.#connectFactory = factory;
    this.#clearRetry();
    const socket = factory();
    this.#socket = socket;
    if (isOpen(socket)) {
      socket.send(JSON.stringify(this.hello()));
    }
    return socket;
  }

  onClose(): void {
    this.#socket = undefined;
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
    this.#clearRetry();
    this.#socket?.close?.(1000, "client closed");
    this.#socket = undefined;
  }

  #flushPending(socket: SocketLike): void {
    for (const command of this.#pending.values()) this.send(command, socket);
  }

  #acceptEvent(event: RoomEventEnvelope): void {
    if (event.roomId !== this.#readonlyRoomId || this.#seen.has(event.eventId)) return;
    if (event.roomSeq <= this.lastRoomSeq) {
      this.#seen.add(event.eventId);
      return;
    }
    // A server replay must be monotonic. If a gap arrives, expose it to the
    // caller without jumping the cursor; the next resume will repair it.
    if (event.roomSeq !== this.lastRoomSeq + 1) {
      this.#controlSink({ type: "snapshot_required", afterSeq: this.lastRoomSeq, throughRoomSeq: event.roomSeq - 1 });
      return;
    }
    this.#seen.add(event.eventId);
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
