import type {
  AgentStatusFrame,
  AuthSession,
  MediaStatusFrame,
  RoomDetails,
  RoomEventEnvelope,
  ServerFrame,
  ServerPresence,
  ServerTyping,
} from "@learning-orbit/contracts";

import { RoomSocket, roomWebSocketUrl, type SocketLike } from "../realtime/room-socket";
import { EventLedger } from "./event-ledger";
import { ProjectionSync, type ProjectionAcceptResult } from "./projection-sync";
import { SessionGatewayError, type SessionGateway } from "./session-gateway";
import { createSessionState, sessionReducer, type SessionState } from "./session-store";

type EventGateway = Pick<SessionGateway, "getRoomEvents">;
type AckFrame = Extract<ServerFrame, { type: "ack" }>;
type RejectFrame = Extract<ServerFrame, { type: "reject" }>;
type DegradedFrame = Extract<ServerFrame, { type: "degraded" }>;

export type HydratedSessionOptions = Readonly<{
  session: AuthSession;
  room: RoomDetails;
  gateway: EventGateway;
  pageLimit?: number;
  retryDelaysMs?: readonly number[];
  onSessionExpired?: () => void;
  onRoomUnavailable?: () => void;
}>;

class VolatileCursorStorage implements Storage {
  readonly #values = new Map<string, string>();
  get length(): number { return this.#values.size; }
  clear(): void { this.#values.clear(); }
  getItem(key: string): string | null { return this.#values.get(key) ?? null; }
  key(index: number): string | null { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string): void { this.#values.delete(key); }
  setItem(key: string, value: string): void { this.#values.set(key, value); }
}

function statusFromEvent(type: string): RoomDetails["status"] | undefined {
  if (type === "room.opened" || type === "room.resumed") return "open";
  if (type === "room.paused") return "paused";
  if (type === "room.closed") return "closed";
  return undefined;
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  return value;
}

export class HydratedSessionState {
  readonly ledger: EventLedger;
  readonly projections: ProjectionSync;
  readonly socket: RoomSocket;
  readonly acks = new Map<string, AckFrame>();
  readonly rejects: RejectFrame[] = [];
  readonly presence = new Map<string, ServerPresence>();
  readonly typing = new Map<string, ServerTyping>();
  readonly mediaStatuses = new Map<string, MediaStatusFrame>();
  readonly degraded = new Map<string, DegradedFrame>();
  agentStatus: AgentStatusFrame | undefined;
  lastProjectionResult: ProjectionAcceptResult | undefined;
  lastServerTime: string | undefined;
  recoveryError: string | undefined;

  #state: SessionState;
  #expired = false;
  #roomUnavailable = false;
  #recovery: Promise<void> | undefined;
  #onSessionExpired: () => void;
  #onRoomUnavailable: () => void;
  #pageLimit: number;
  #requiredThroughSeq = 0;
  readonly #listeners = new Set<() => void>();
  #session: AuthSession | undefined;
  #room: RoomDetails | undefined;

  private constructor(
    session: AuthSession,
    room: RoomDetails,
    private readonly gateway: EventGateway,
    options: Pick<HydratedSessionOptions, "pageLimit" | "retryDelaysMs" | "onSessionExpired" | "onRoomUnavailable">,
  ) {
    if (room.roomId !== (session.role === "student" ? session.roomId : room.roomId)) {
      throw new Error("HYDRATED_SESSION_ROOM_MISMATCH");
    }
    this.#session = session;
    this.#room = room;
    this.#pageLimit = options.pageLimit ?? 500;
    if (!Number.isSafeInteger(this.#pageLimit) || this.#pageLimit < 1 || this.#pageLimit > 500) {
      throw new Error("HYDRATED_PAGE_LIMIT_INVALID");
    }
    this.#onSessionExpired = options.onSessionExpired ?? (() => undefined);
    this.#onRoomUnavailable = options.onRoomUnavailable ?? (() => undefined);
    this.#state = createSessionState(room.roomId, room.status, room.startsAt, room.closesAt);
    this.ledger = new EventLedger(room.roomId);
    this.projections = new ProjectionSync(room.roomId, session);
    this.socket = new RoomSocket(
      room.roomId,
      new VolatileCursorStorage(),
      (event) => this.#acceptEvent(event),
      {
        ...(options.retryDelaysMs === undefined ? {} : { retryDelaysMs: options.retryDelaysMs }),
        onSessionExpired: () => this.clearForSessionExpiry(),
        onRoomUnavailable: () => this.clearForRoomUnavailable(),
        onConnectionChange: (connected) => {
          this.#state = sessionReducer(this.#state, { type: "connection", connected });
          this.#notify();
        },
        onProtocolError: () => this.#failRecovery("REALTIME_PROTOCOL_ERROR"),
      },
      (frame) => this.#acceptControl(frame),
    );
  }

  static async create(options: HydratedSessionOptions): Promise<HydratedSessionState> {
    const hydrated = new HydratedSessionState(options.session, options.room, options.gateway, options);
    await hydrated.recoverEvents();
    return hydrated;
  }

  get sessionState(): SessionState { return this.#state; }
  get expired(): boolean { return this.#expired; }
  get roomUnavailable(): boolean { return this.#roomUnavailable; }
  get session(): AuthSession {
    if (!this.#session) throw new Error("SESSION_STATE_CLEARED");
    return this.#session;
  }
  get room(): RoomDetails {
    if (!this.#room) throw new Error("SESSION_STATE_CLEARED");
    return this.#room;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  receiveFrame(value: unknown): void {
    if (this.#expired || this.#roomUnavailable || this.recoveryError) return;
    try {
      this.socket.onFrame(value);
    } catch {
      this.#failRecovery("REALTIME_PROTOCOL_ERROR");
    }
  }

  connect(factory: () => SocketLike): SocketLike {
    if (this.#expired) throw new Error("SESSION_EXPIRED");
    if (this.#roomUnavailable) throw new Error("ROOM_UNAVAILABLE");
    if (this.recoveryError) throw new Error("SESSION_SYNC_FAILED");
    return this.socket.connect(factory);
  }

  connectNative(
    location: Readonly<{ protocol: string; host: string }> = globalThis.location,
    WebSocketConstructor: new (url: string) => SocketLike = globalThis.WebSocket as unknown as new (url: string) => SocketLike,
  ): SocketLike {
    if (typeof WebSocketConstructor !== "function") throw new Error("WEBSOCKET_UNAVAILABLE");
    const url = roomWebSocketUrl(this.room.roomId, location);
    return this.connect(() => new WebSocketConstructor(url));
  }

  recoverEvents(requiredThroughSeq = this.ledger.lastRoomSeq): Promise<void> {
    if (this.#expired) return Promise.reject(new Error("SESSION_EXPIRED"));
    if (this.#roomUnavailable) return Promise.reject(new Error("ROOM_UNAVAILABLE"));
    if (this.recoveryError) return Promise.reject(new Error("SESSION_SYNC_FAILED"));
    if (!Number.isSafeInteger(requiredThroughSeq) || requiredThroughSeq < 0) {
      return Promise.reject(new Error("ROOM_EVENT_RECOVERY_TARGET_INVALID"));
    }
    this.#requiredThroughSeq = Math.max(this.#requiredThroughSeq, requiredThroughSeq);
    if (this.#recovery) return this.#recovery;
    const task = this.#recoverLoop().then(
      () => {
        if (this.#recovery === task) this.#recovery = undefined;
        this.#requiredThroughSeq = this.ledger.lastRoomSeq;
      },
      (error: unknown) => {
        if (this.#recovery === task) this.#recovery = undefined;
        if (error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED") {
          this.clearForSessionExpiry();
        } else if (error instanceof SessionGatewayError && (error.code === "FORBIDDEN" || error.code === "ROOM_NOT_FOUND")) {
          this.clearForRoomUnavailable();
        }
        throw error;
      },
    );
    this.#recovery = task;
    return task;
  }

  async whenIdle(): Promise<void> {
    await (this.#recovery ?? Promise.resolve());
  }

  progress(now: number): Readonly<{ elapsedSeconds: number; ratio: number }> {
    const startsAt = this.#state.startsAt === null ? Number.NaN : Date.parse(this.#state.startsAt);
    const closesAt = this.#state.closesAt === null ? Number.NaN : Date.parse(this.#state.closesAt);
    if (!Number.isFinite(startsAt) || !Number.isFinite(closesAt) || closesAt <= startsAt) {
      return { elapsedSeconds: 0, ratio: 0 };
    }
    const elapsedMs = Math.min(Math.max(0, now - startsAt), closesAt - startsAt);
    return {
      elapsedSeconds: Math.floor(elapsedMs / 1_000),
      ratio: elapsedMs / (closesAt - startsAt),
    };
  }

  clearForSessionExpiry(): void {
    if (this.#expired || this.#roomUnavailable) return;
    this.#expired = true;
    this.#clearState(false);
    this.#onSessionExpired();
    this.#notify();
  }

  clearForRoomUnavailable(): void {
    if (this.#expired || this.#roomUnavailable) return;
    this.#roomUnavailable = true;
    this.#clearState(false);
    this.#onRoomUnavailable();
    this.#notify();
  }

  dispose(): void {
    this.#clearState(false);
  }

  async #recoverLoop(): Promise<void> {
    let cursor = this.ledger.lastRoomSeq;
    for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
      const page = await this.gateway.getRoomEvents(this.room.roomId, cursor, this.#pageLimit);
      if (this.#expired) throw new Error("SESSION_EXPIRED");
      if (this.#roomUnavailable) throw new Error("ROOM_UNAVAILABLE");
      for (const event of page.events) {
        if (event.roomSeq !== cursor + 1) throw new Error("ROOM_EVENT_PAGE_GAP");
        this.socket.onFrame({ type: "event", event });
        if (this.ledger.lastRoomSeq !== event.roomSeq) throw new Error("ROOM_EVENT_PAGE_REJECTED");
        cursor = event.roomSeq;
      }
      if (page.throughRoomSeq !== cursor) throw new Error("ROOM_EVENT_PAGE_CURSOR_MISMATCH");
      if (page.nextAfterSeq === undefined) {
        if (cursor < this.#requiredThroughSeq) throw new Error("ROOM_EVENT_RECOVERY_INCOMPLETE");
        return;
      }
      if (page.nextAfterSeq !== cursor || page.events.length === 0) throw new Error("ROOM_EVENT_PAGE_CURSOR_INVALID");
    }
    throw new Error("ROOM_EVENT_PAGE_LIMIT_EXCEEDED");
  }

  #acceptEvent(event: RoomEventEnvelope): void {
    const result = this.ledger.append(event);
    if (result !== "appended") throw new Error(`ROOM_EVENT_LEDGER_${result.toUpperCase()}`);
    this.#state = sessionReducer(this.#state, { type: "cursor", roomSeq: event.roomSeq });
    const status = statusFromEvent(event.type);
    if (status !== undefined) this.#state = sessionReducer(this.#state, { type: "status", status });
    if (event.type === "room.opened") {
      this.#state = sessionReducer(this.#state, {
        type: "timing",
        startsAt: requiredString(event.payload.startsAt, "ROOM_START_INVALID"),
        closesAt: requiredString(event.payload.closesAt, "ROOM_CLOSE_INVALID"),
      });
    }
    this.#notify();
  }

  #acceptControl(frame: ServerFrame): void {
    try {
      if (frame.type === "welcome") {
        if (frame.roomId !== this.room.roomId) throw new Error("WELCOME_ROOM_MISMATCH");
        this.lastServerTime = frame.serverTime;
        this.#state = sessionReducer(this.#state, { type: "connection", connected: true });
        this.#state = sessionReducer(this.#state, { type: "status", status: frame.status });
        return;
      }
      if (frame.type === "snapshot_required") {
        if (frame.afterSeq !== this.ledger.lastRoomSeq || frame.throughRoomSeq < frame.afterSeq) {
          throw new Error("ROOM_EVENT_RECOVERY_RANGE_INVALID");
        }
        const recovery = this.recoverEvents(frame.throughRoomSeq);
        this.socket.deferReconnectUntil(recovery);
        void recovery.catch(() => this.#failRecovery("ROOM_EVENT_RECOVERY_FAILED"));
        return;
      }
      if (frame.type === "ack") { this.acks.set(frame.commandId, frame); return; }
      if (frame.type === "reject") { this.rejects.push(frame); return; }
      if (frame.type === "presence" && "actorId" in frame) { this.presence.set(frame.actorId, frame); return; }
      if (frame.type === "typing" && "actorId" in frame) { this.typing.set(frame.actorId, frame); return; }
      if (frame.type === "media_status") { this.mediaStatuses.set(frame.mediaId, frame); return; }
      if (frame.type === "agent_status") {
        if (frame.roomId !== this.room.roomId) throw new Error("AGENT_STATUS_ROOM_MISMATCH");
        this.agentStatus = frame;
        return;
      }
      if (frame.type === "projection") { this.lastProjectionResult = this.projections.accept(frame); return; }
      if (frame.type === "degraded") {
        this.degraded.set(`${frame.scope}:${frame.projectionKey ?? "all"}`, frame);
        this.degraded.set(frame.scope, frame);
        return;
      }
      if (frame.type === "heartbeat" && "serverTime" in frame) this.lastServerTime = frame.serverTime;
    } finally {
      this.#notify();
    }
  }

  #clearState(notify: boolean): void {
    this.socket.destroy();
    this.ledger.destroy();
    this.projections.clearAuthority();
    this.acks.clear();
    this.rejects.splice(0);
    this.presence.clear();
    this.typing.clear();
    this.mediaStatuses.clear();
    this.degraded.clear();
    this.agentStatus = undefined;
    this.lastProjectionResult = undefined;
    this.lastServerTime = undefined;
    this.recoveryError = undefined;
    this.#session = undefined;
    this.#room = undefined;
    this.#state = createSessionState("");
    this.#requiredThroughSeq = 0;
    if (notify) this.#notify();
  }

  #failRecovery(code: "REALTIME_PROTOCOL_ERROR" | "ROOM_EVENT_RECOVERY_FAILED"): void {
    if (this.#expired || this.#roomUnavailable || this.recoveryError) return;
    this.recoveryError = code;
    this.socket.close();
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
