import {
  realtimeContract,
  type AgentCurrentState,
  type AgentStatusFrame,
  type AnalyticsTimelineResponse,
  type AuthSession,
  type MediaStatusFrame,
  type RoomDetails,
  type RoomEventEnvelope,
  type ServerFrame,
  type ServerPresence,
  type ServerTyping,
  type ProjectionFrame,
} from "@learning-orbit/contracts";

import { RoomSocket, roomWebSocketUrl, type SocketLike } from "../realtime/room-socket";
import { EventLedger, type LedgerMessage } from "./event-ledger";
import { ProjectionSync, type ProjectionAcceptResult } from "./projection-sync";
import { makeSessionCommandBus, type RoomCommandIntent, type SessionCommandBus } from "./session-command-bus";
import { assertRoomRosterIntegrity, assertStudentRoomIdentity } from "./room-identity";
import {
  SessionGatewayError,
  type EchoProjectionKey,
  type ProjectionKey,
  type SessionGateway,
} from "./session-gateway";
import { createSessionState, sessionReducer, type SessionState } from "./session-store";

type EventGateway = Pick<SessionGateway, "getRoomEvents"> & Partial<Pick<
  SessionGateway,
  "getAgentCurrent" | "getProjectionLatest" | "getProjectionPatches" | "getConceptTimeline"
>>;
type AckFrame = Extract<ServerFrame, { type: "ack" }>;
type RejectFrame = Extract<ServerFrame, { type: "reject" }>;
type DegradedFrame = Extract<ServerFrame, { type: "degraded" }>;
const MAX_ACK_HISTORY = 500;
const MAX_REJECT_HISTORY = 100;
const MAX_MEDIA_STATUS_HISTORY = 500;
const TERMINAL_MEDIA_STATES = new Set<MediaStatusFrame["state"]>(["quarantined", "failed", "deleted"]);
const TERMINAL_AGENT_STATES = new Set<AgentStatusFrame["state"]>(["completed", "blocked_by_policy", "cancelled", "failed"]);
const AGENT_PROGRESS_RANK: Readonly<Partial<Record<AgentStatusFrame["state"], number>>> = {
  queued: 0,
  running: 1,
  streaming: 2,
};
const AGENT_HEALTH_RANK: Readonly<Record<AgentStatusFrame["serviceHealth"], number>> = {
  healthy: 0,
  degraded: 1,
  unavailable: 2,
};
const DEFAULT_AGENT_STATUS_TIMEOUT_MS = 1_500;
const PROJECTION_AUTHORITY_LOSS_CODES = new Set([
  "PROJECTION_FORBIDDEN",
  "RETENTION_POLICY_EXPIRED",
  "ROOM_DELETION_IN_PROGRESS",
]);

function agentFrameIdentityIsValid(frame: AgentStatusFrame): boolean {
  return frame.state === "idle"
    ? frame.agentRunId === null && frame.failureCode === null
    : frame.agentRunId !== null;
}

function acceptAgentRunTransition(
  previous: AgentStatusFrame,
  next: AgentStatusFrame,
  previousTime: number | undefined,
  nextTime: number,
  authoritativeReplacement: boolean,
): boolean {
  if (previous.agentRunId === null) {
    return next.agentRunId !== null && previousTime !== undefined && nextTime > previousTime;
  }
  if (next.agentRunId === null || previousTime === undefined || nextTime < previousTime) return false;
  if (previous.agentRunId !== next.agentRunId) {
    return nextTime > previousTime
      && (authoritativeReplacement || TERMINAL_AGENT_STATES.has(previous.state));
  }
  if (previous.state === next.state) return nextTime > previousTime;
  if (TERMINAL_AGENT_STATES.has(previous.state)) return false;
  if (TERMINAL_AGENT_STATES.has(next.state)) return true;
  return (AGENT_PROGRESS_RANK[next.state] ?? -1) > (AGENT_PROGRESS_RANK[previous.state] ?? -1);
}

export type HydratedSessionOptions = Readonly<{
  session: AuthSession;
  room: RoomDetails;
  gateway: EventGateway;
  pageLimit?: number;
  retryDelaysMs?: readonly number[];
  onSessionExpired?: () => void;
  onRoomUnavailable?: () => void;
  commandClock?: () => Date;
  commandUuid?: () => string;
  agentCurrent?: AgentCurrentState;
  agentServiceUnavailable?: boolean;
  agentStatusTimeoutMs?: number;
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
  agentServiceUnavailable = false;
  agentStatusPending = false;
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
  #agentRunUpdatedAt: number | undefined;
  #agentMetaUpdatedAt: number | undefined;
  #agentRefresh: Promise<void> | undefined;
  #agentRefreshAbort: AbortController | undefined;
  #agentRefreshGeneration = 0;
  #agentLiveVersion = 0;
  #agentStatusTimeoutMs: number;
  readonly #projectionRefreshes = new Map<ProjectionKey, Promise<void>>();
  readonly #projectionRefreshAbort = new Map<ProjectionKey, AbortController>();
  readonly #projectionRefreshGeneration = new Map<ProjectionKey, number>();
  readonly #timelineRequests = new Map<EchoProjectionKey, Readonly<{
    controller: AbortController;
    task: Promise<AnalyticsTimelineResponse>;
  }>>();
  readonly #listeners = new Set<() => void>();
  #session: AuthSession | undefined;
  #room: RoomDetails | undefined;
  readonly #commands: SessionCommandBus;

  private constructor(
    session: AuthSession,
    room: RoomDetails,
    private readonly gateway: EventGateway,
    options: Pick<HydratedSessionOptions, "pageLimit" | "retryDelaysMs" | "onSessionExpired" | "onRoomUnavailable" | "commandClock" | "commandUuid" | "agentCurrent" | "agentServiceUnavailable" | "agentStatusTimeoutMs">,
  ) {
    try { assertRoomRosterIntegrity(room); }
    catch { throw new Error("HYDRATED_ROOM_ROSTER_INVALID"); }
    if (room.roomId !== (session.role === "student" ? session.roomId : room.roomId)) {
      throw new Error("HYDRATED_SESSION_ROOM_MISMATCH");
    }
    if (session.role === "student") {
      try { assertStudentRoomIdentity(session, room); }
      catch { throw new Error("HYDRATED_SESSION_IDENTITY_MISMATCH"); }
    }
    this.#session = session;
    this.#room = room;
    this.#pageLimit = options.pageLimit ?? 500;
    if (!Number.isSafeInteger(this.#pageLimit) || this.#pageLimit < 1 || this.#pageLimit > 500) {
      throw new Error("HYDRATED_PAGE_LIMIT_INVALID");
    }
    this.#onSessionExpired = options.onSessionExpired ?? (() => undefined);
    this.#onRoomUnavailable = options.onRoomUnavailable ?? (() => undefined);
    this.#agentStatusTimeoutMs = options.agentStatusTimeoutMs ?? DEFAULT_AGENT_STATUS_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#agentStatusTimeoutMs) || this.#agentStatusTimeoutMs < 1 || this.#agentStatusTimeoutMs > 30_000) {
      throw new Error("AGENT_STATUS_TIMEOUT_INVALID");
    }
    this.#state = createSessionState(room.roomId, room.status, room.startsAt, room.closesAt);
    if (options.agentCurrent) {
      this.#mergeAgentCurrent(options.agentCurrent);
    } else {
      this.agentServiceUnavailable = options.agentServiceUnavailable === true;
    }
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
    this.#commands = makeSessionCommandBus({
      roomId: room.roomId,
      clock: options.commandClock ?? (() => new Date()),
      uuid: options.commandUuid ?? (() => {
        if (!globalThis.crypto?.randomUUID) throw new Error("COMMAND_UUID_UNAVAILABLE");
        return globalThis.crypto.randomUUID();
      }),
      transport: {
        send: (command) => {
          this.socket.send(command);
          return command.commandId;
        },
      },
    });
  }

  static async create(options: HydratedSessionOptions): Promise<HydratedSessionState> {
    const hydrated = new HydratedSessionState(options.session, options.room, options.gateway, options);
    await hydrated.recoverEvents();
    void hydrated.refreshProjections();
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

  messages(): LedgerMessage[] { return this.ledger.messages(); }
  pendingCommandIds(): string[] { return this.socket.pendingCommandIds(); }

  /**
   * Ephemeral signals carry their own `expiresAt` and the server only sweeps
   * them when the *sending* connection next heartbeats, so a lapsed signal can
   * sit in these maps for several seconds after it stopped being true. Both
   * readers below re-check the deadline against the caller's clock; nothing
   * renders a seat state the server did not still vouch for.
   *
   * "unknown" is a real, distinct answer — an unreported seat must never be
   * drawn as present.
   */
  presenceStateOf(actorId: string, now: number = Date.now()): "active" | "away" | "unknown" {
    const frame = this.presence.get(actorId);
    if (!frame || !(Date.parse(frame.expiresAt) > now)) return "unknown";
    return frame.state;
  }

  /** Actors currently composing, excluding this seat: nobody needs to be told they are typing. */
  typingActorIds(now: number = Date.now()): string[] {
    const ownActorId = this.#session?.actorId;
    const composing: string[] = [];
    for (const [actorId, frame] of this.typing) {
      if (!frame.active || actorId === ownActorId) continue;
      if (Date.parse(frame.expiresAt) > now) composing.push(actorId);
    }
    return composing;
  }

  /** Best-effort seat signals. They are dropped while disconnected rather than queued. */
  signalPresence(state: "active" | "away"): void {
    if (this.#expired || this.#roomUnavailable) return;
    this.socket.sendPresence(state);
  }

  signalTyping(active: boolean): void {
    if (this.#expired || this.#roomUnavailable) return;
    this.socket.sendTyping(active);
  }

  sendIntent(intent: RoomCommandIntent): string {
    if (this.#expired) throw new Error("SESSION_EXPIRED");
    if (this.#roomUnavailable) throw new Error("ROOM_UNAVAILABLE");
    if (this.recoveryError) throw new Error("SESSION_SYNC_FAILED");
    const session = this.session;
    const isMessage = intent.type.startsWith("message.");
    if (isMessage && this.#state.status !== "open") throw new Error("ROOM_NOT_OPEN");
    if (session.role === "student" && !isMessage) throw new Error("COMMAND_ROLE_FORBIDDEN");
    if (session.role === "teacher" && (intent.type === "message.add" || intent.type === "message.revise")) {
      throw new Error("COMMAND_ROLE_FORBIDDEN");
    }
    const commandId = this.#commands.send(intent);
    this.#notify();
    return commandId;
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
    let refresh = this.#agentRefresh;
    while (refresh) {
      await refresh;
      if (this.#agentRefresh === refresh) break;
      refresh = this.#agentRefresh;
    }
    for (;;) {
      const projectionTasks = [...this.#projectionRefreshes.values()];
      if (projectionTasks.length === 0) break;
      await Promise.all(projectionTasks);
      if (projectionTasks.every((task) => ![...this.#projectionRefreshes.values()].includes(task))) continue;
    }
  }

  refreshAgentCurrent(): Promise<void> {
    return this.#refreshAgentCurrent();
  }

  refreshProjections(): Promise<void> {
    if (!this.gateway.getProjectionLatest || !this.#room) return Promise.resolve();
    return Promise.all(this.projections.allowedKeys().map((key) => this.#refreshProjectionLatest(key))).then(() => undefined);
  }

  refreshProjection(key: ProjectionKey): Promise<void> {
    if (!this.projections.allowedKeys().includes(key)) return Promise.reject(new Error("PROJECTION_ROLE_FORBIDDEN"));
    return this.#refreshProjectionLatest(key);
  }

  loadConceptTimeline(key: EchoProjectionKey, limit = 50): Promise<AnalyticsTimelineResponse> {
    if (!this.projections.allowedKeys().includes(key)) return Promise.reject(new Error("PROJECTION_ROLE_FORBIDDEN"));
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      return Promise.reject(new Error("ANALYTICS_TIMELINE_LIMIT_INVALID"));
    }
    if (!this.gateway.getConceptTimeline || !this.#room || !this.#session) {
      return Promise.reject(new Error("ANALYTICS_TIMELINE_UNAVAILABLE"));
    }
    const snapshot = this.projections.slot(key).snapshot;
    if (!snapshot || snapshot.projectionKey !== key) {
      return Promise.reject(new Error("ANALYTICS_TIMELINE_BASE_MISSING"));
    }
    this.#timelineRequests.get(key)?.controller.abort();
    const controller = new AbortController();
    const roomId = this.#room.roomId;
    const analysisEpoch = snapshot.analysisEpoch;
    let task!: Promise<AnalyticsTimelineResponse>;
    task = (async () => {
      try {
        const result = await this.gateway.getConceptTimeline!(
          roomId,
          key,
          { analysisEpoch, limit },
          { signal: controller.signal },
        );
        const active = this.#timelineRequests.get(key);
        if (active?.task !== task || !this.#room || !this.#session) {
          throw new Error("ANALYTICS_TIMELINE_STALE");
        }
        const current = this.projections.slot(key).snapshot;
        if (!current || current.projectionKey !== key || current.analysisEpoch !== result.analysisEpoch) {
          throw new Error("ANALYTICS_TIMELINE_EPOCH_CHANGED");
        }
        return result;
      } catch (error) {
        if (error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED") {
          this.clearForSessionExpiry();
        } else if (error instanceof SessionGatewayError && error.code === "ROOM_NOT_FOUND") {
          this.clearForRoomUnavailable();
        } else if (error instanceof SessionGatewayError && error.code === "STUDENT_ANALYTICS_NOT_PROMOTED"
          && this.#room && this.#session) {
          this.#cancelTimelineRequest(key);
          this.projections.markPolicyUnavailable(key);
          this.#notify();
        } else if (error instanceof SessionGatewayError && PROJECTION_AUTHORITY_LOSS_CODES.has(error.code)
          && this.#room && this.#session) {
          this.#cancelTimelineRequest(key);
          this.projections.markAuthorityUnavailable(key, error.code);
          this.#notify();
        }
        throw error;
      } finally {
        if (this.#timelineRequests.get(key)?.task === task) this.#timelineRequests.delete(key);
      }
    })();
    this.#timelineRequests.set(key, { controller, task });
    return task;
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
    const activeMediaIds = this.ledger.activeMediaIds();
    for (const mediaId of this.mediaStatuses.keys()) {
      if (!activeMediaIds.has(mediaId)) this.mediaStatuses.delete(mediaId);
    }
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
      if (frame.type === "resume_complete") {
        // Only now will the server accept a non-hello frame, so this is the
        // first and only safe moment to claim the seat -- and it re-runs on
        // every reconnect, which is what re-announces us after a drop.
        this.socket.sendPresence("active");
        void this.#refreshAgentCurrent();
        void this.refreshProjections();
        return;
      }
      if (frame.type === "ack") {
        this.acks.set(frame.commandId, frame);
        if (this.acks.size > MAX_ACK_HISTORY) this.acks.delete(this.acks.keys().next().value!);
        return;
      }
      if (frame.type === "reject") {
        this.rejects.push(frame);
        if (this.rejects.length > MAX_REJECT_HISTORY) this.rejects.splice(0, this.rejects.length - MAX_REJECT_HISTORY);
        return;
      }
      if (frame.type === "presence" && "actorId" in frame) { this.presence.set(frame.actorId, frame); return; }
      if (frame.type === "typing" && "actorId" in frame) { this.typing.set(frame.actorId, frame); return; }
      if (frame.type === "media_status") {
        if (!this.ledger.activeMediaIds().has(frame.mediaId)) return;
        const previous = this.mediaStatuses.get(frame.mediaId);
        if (previous) {
          const previousTime = Date.parse(previous.updatedAt);
          const nextTime = Date.parse(frame.updatedAt);
          if (nextTime < previousTime
            || (TERMINAL_MEDIA_STATES.has(previous.state) && !TERMINAL_MEDIA_STATES.has(frame.state))
            || (nextTime === previousTime && previous.state !== frame.state
              && !(TERMINAL_MEDIA_STATES.has(frame.state) && !TERMINAL_MEDIA_STATES.has(previous.state)))) return;
        }
        if (!this.mediaStatuses.has(frame.mediaId) && this.mediaStatuses.size >= MAX_MEDIA_STATUS_HISTORY) {
          this.mediaStatuses.delete(this.mediaStatuses.keys().next().value!);
        }
        this.mediaStatuses.set(frame.mediaId, frame);
        return;
      }
      if (frame.type === "agent_status") {
        if (frame.roomId !== this.room.roomId) throw new Error("AGENT_STATUS_ROOM_MISMATCH");
        if (this.#mergeAgentFrame(frame, Date.parse(frame.updatedAt), Date.parse(frame.updatedAt))) {
          this.#agentLiveVersion += 1;
          this.agentServiceUnavailable = false;
        }
        return;
      }
      if (frame.type === "projection") {
        this.lastProjectionResult = this.projections.accept(frame);
        if (this.lastProjectionResult === "epoch_changed") this.#cancelTimelineRequest(frame.projectionKey);
        if (this.lastProjectionResult !== "duplicate" && this.lastProjectionResult !== "stale") {
          void this.#reconcileProjectionFrame(frame, this.lastProjectionResult);
        }
        return;
      }
      if (frame.type === "degraded") {
        this.degraded.set(`${frame.scope}:${frame.projectionKey ?? "all"}`, frame);
        this.degraded.set(frame.scope, frame);
        if (frame.scope === "analytics" && frame.code === "STUDENT_ANALYTICS_NOT_PROMOTED" && frame.projectionKey) {
          this.#cancelProjectionRefresh(frame.projectionKey);
          this.#cancelTimelineRequest(frame.projectionKey);
          this.projections.markPolicyUnavailable(frame.projectionKey);
        }
        return;
      }
      if (frame.type === "heartbeat" && "serverTime" in frame) this.lastServerTime = frame.serverTime;
    } finally {
      this.#notify();
    }
  }

  #clearState(notify: boolean): void {
    this.#agentRefreshGeneration += 1;
    this.#agentRefreshAbort?.abort();
    this.#agentRefreshAbort = undefined;
    this.#agentRefresh = undefined;
    for (const key of this.projections.allowedKeys()) this.#cancelProjectionRefresh(key);
    for (const request of this.#timelineRequests.values()) request.controller.abort();
    this.#timelineRequests.clear();
    this.#projectionRefreshes.clear();
    this.#projectionRefreshAbort.clear();
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
    this.agentServiceUnavailable = false;
    this.agentStatusPending = false;
    this.#agentRunUpdatedAt = undefined;
    this.#agentMetaUpdatedAt = undefined;
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

  #mergeAgentCurrent(current: AgentCurrentState): void {
    if (current.roomId !== this.room.roomId) throw new Error("AGENT_CURRENT_ROOM_MISMATCH");
    const frame = realtimeContract.parseServerFrame({
      type: "agent_status",
      roomId: current.roomId,
      agentRunId: current.run?.agentRunId ?? null,
      state: current.run?.state ?? "idle",
      serviceHealth: current.serviceHealth,
      agentEnabled: current.agentEnabled,
      updatedAt: current.updatedAt,
      failureCode: current.run?.failureCode ?? null,
    });
    if (frame.type !== "agent_status") throw new Error("AGENT_CURRENT_FRAME_INVALID");
    this.#mergeAgentFrame(
      frame,
      current.run ? Date.parse(current.run.updatedAt) : Date.parse(current.updatedAt),
      Date.parse(current.updatedAt),
      true,
    );
  }

  #mergeAgentFrame(
    frame: AgentStatusFrame,
    runTime: number,
    metaTime: number,
    authoritativeReplacement = false,
  ): boolean {
    if (!agentFrameIdentityIsValid(frame) || !Number.isFinite(runTime) || !Number.isFinite(metaTime)) {
      throw new Error("AGENT_STATUS_INVALID");
    }
    const previous = this.agentStatus;
    if (!previous) {
      this.#agentRunUpdatedAt = runTime;
      this.#agentMetaUpdatedAt = metaTime;
      this.agentStatus = {
        ...frame,
        updatedAt: new Date(Math.max(runTime, metaTime)).toISOString(),
      };
      return true;
    }

    const acceptRun = acceptAgentRunTransition(
      previous,
      frame,
      this.#agentRunUpdatedAt,
      runTime,
      authoritativeReplacement,
    );
    const previousMetaTime = this.#agentMetaUpdatedAt;
    const newerMeta = previousMetaTime === undefined || metaTime > previousMetaTime;
    const sameMeta = previousMetaTime !== undefined && metaTime === previousMetaTime;
    const acceptHealth = newerMeta || (sameMeta
      && AGENT_HEALTH_RANK[frame.serviceHealth] > AGENT_HEALTH_RANK[previous.serviceHealth]);
    const acceptEnabled = newerMeta || (sameMeta && previous.agentEnabled && !frame.agentEnabled);

    if (acceptRun) this.#agentRunUpdatedAt = runTime;
    if (newerMeta) this.#agentMetaUpdatedAt = metaTime;
    const combinedTime = Math.max(this.#agentRunUpdatedAt ?? Number.NEGATIVE_INFINITY, this.#agentMetaUpdatedAt ?? Number.NEGATIVE_INFINITY);
    this.agentStatus = {
      ...previous,
      ...(acceptRun ? {
        agentRunId: frame.agentRunId,
        state: frame.state,
        failureCode: frame.failureCode,
      } : {}),
      ...(acceptHealth ? { serviceHealth: frame.serviceHealth } : {}),
      ...(acceptEnabled ? { agentEnabled: frame.agentEnabled } : {}),
      updatedAt: new Date(combinedTime).toISOString(),
    };
    return acceptRun || acceptHealth || acceptEnabled;
  }

  #refreshAgentCurrent(): Promise<void> {
    if (!this.gateway.getAgentCurrent || !this.#room) return Promise.resolve();
    const generation = this.#agentRefreshGeneration + 1;
    const liveVersion = this.#agentLiveVersion;
    this.#agentRefreshGeneration = generation;
    this.#agentRefreshAbort?.abort();
    this.agentStatusPending = true;
    this.#notify();
    const controller = new AbortController();
    this.#agentRefreshAbort = controller;
    const roomId = this.#room.roomId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("AGENT_STATUS_TIMEOUT"));
      }, this.#agentStatusTimeoutMs);
    });
    let removeAbortListener: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new Error("AGENT_STATUS_ABORTED"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
    });
    const task = (async () => {
      try {
        const current = await Promise.race([
          this.gateway.getAgentCurrent!(roomId, { signal: controller.signal }),
          timeout,
          aborted,
        ]);
        if (generation !== this.#agentRefreshGeneration || !this.#room) return;
        this.#mergeAgentCurrent(current);
        this.agentServiceUnavailable = false;
        this.#notify();
      } catch (error) {
        if (generation !== this.#agentRefreshGeneration || !this.#room) return;
        if (error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED") {
          this.clearForSessionExpiry();
        } else if (error instanceof SessionGatewayError && (error.code === "FORBIDDEN" || error.code === "ROOM_NOT_FOUND")) {
          this.clearForRoomUnavailable();
        } else if (liveVersion !== this.#agentLiveVersion) {
          return;
        } else {
          this.agentServiceUnavailable = true;
          this.#notify();
        }
      } finally {
        removeAbortListener();
        if (timer !== undefined) clearTimeout(timer);
        if (generation === this.#agentRefreshGeneration) {
          this.agentStatusPending = false;
          this.#agentRefreshAbort = undefined;
          this.#agentRefresh = undefined;
          this.#notify();
        }
      }
    })();
    this.#agentRefresh = task;
    return task;
  }

  #cancelProjectionRefresh(key: ProjectionKey): void {
    this.#projectionRefreshGeneration.set(key, (this.#projectionRefreshGeneration.get(key) ?? 0) + 1);
    this.#projectionRefreshAbort.get(key)?.abort();
    this.#projectionRefreshAbort.delete(key);
    this.#projectionRefreshes.delete(key);
  }

  #cancelTimelineRequest(key: ProjectionKey): void {
    if (!key.startsWith("echo.")) return;
    const request = this.#timelineRequests.get(key as EchoProjectionKey);
    request?.controller.abort();
    this.#timelineRequests.delete(key as EchoProjectionKey);
  }

  #projectionTask(
    key: ProjectionKey,
    work: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (!this.#room || !this.#session) return Promise.resolve();
    const generation = (this.#projectionRefreshGeneration.get(key) ?? 0) + 1;
    this.#projectionRefreshGeneration.set(key, generation);
    this.#projectionRefreshAbort.get(key)?.abort();
    const controller = new AbortController();
    this.#projectionRefreshAbort.set(key, controller);
    this.projections.markLoading(key);
    this.#notify();
    let task!: Promise<void>;
    task = (async () => {
      try {
        await work(controller.signal);
        if (generation !== this.#projectionRefreshGeneration.get(key) || !this.#room || !this.#session) return;
        this.#notify();
      } catch (error) {
        if (generation !== this.#projectionRefreshGeneration.get(key) || !this.#room || !this.#session) return;
        if (error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED") {
          this.clearForSessionExpiry();
          return;
        }
        if (error instanceof SessionGatewayError && error.code === "ROOM_NOT_FOUND") {
          this.clearForRoomUnavailable();
          return;
        }
        if (error instanceof SessionGatewayError && error.code === "STUDENT_ANALYTICS_NOT_PROMOTED") {
          this.#cancelTimelineRequest(key);
          this.projections.markPolicyUnavailable(key);
        } else if (error instanceof SessionGatewayError && error.code === "ANALYTICS_NOT_READY") {
          this.projections.markNotReady(key);
        } else if (error instanceof SessionGatewayError && PROJECTION_AUTHORITY_LOSS_CODES.has(error.code)) {
          this.#cancelTimelineRequest(key);
          this.projections.markAuthorityUnavailable(key, error.code);
        } else {
          const code = error instanceof SessionGatewayError
            ? error.code
            : error instanceof Error && /^[A-Z0-9_]{1,80}$/u.test(error.message)
              ? error.message
              : "PROJECTION_SYNC_FAILED";
          this.projections.markFailed(key, code);
        }
        this.#notify();
      } finally {
        if (generation === this.#projectionRefreshGeneration.get(key)) {
          this.#projectionRefreshAbort.delete(key);
          if (this.#projectionRefreshes.get(key) === task) this.#projectionRefreshes.delete(key);
        }
      }
    })();
    this.#projectionRefreshes.set(key, task);
    return task;
  }

  #refreshProjectionLatest(key: ProjectionKey): Promise<void> {
    if (!this.gateway.getProjectionLatest || !this.#room) return Promise.resolve();
    const roomId = this.#room.roomId;
    return this.#projectionTask(key, async (signal) => {
      const previous = this.projections.slot(key).snapshot;
      const snapshot = await this.gateway.getProjectionLatest!(roomId, key, { signal });
      if (previous && previous.analysisEpoch !== snapshot.analysisEpoch) this.#cancelTimelineRequest(key);
      this.projections.replaceSnapshot(snapshot);
    });
  }

  #reconcileProjectionFrame(frame: ProjectionFrame, result: ProjectionAcceptResult): Promise<void> {
    if (!this.gateway.getProjectionLatest || !this.#room) return Promise.resolve();
    const key = frame.projectionKey;
    const roomId = this.#room.roomId;
    return this.#projectionTask(key, async (signal) => {
      const slot = this.projections.slot(key);
      const current = slot.snapshot;
      if (result === "accepted" && key.startsWith("echo.") && this.gateway.getProjectionPatches
        && current && current.projectionKey === key
        && current.analysisEpoch === frame.analysisEpoch
        && current.projectionVersion + 1 === frame.projectionVersion) {
        try {
          const page = await this.gateway.getProjectionPatches(
            roomId,
            key as EchoProjectionKey,
            { analysisEpoch: frame.analysisEpoch, afterProjectionVersion: current.projectionVersion },
            { signal },
          );
          this.projections.applyEchoPatches(key as EchoProjectionKey, page.patches, frame);
          return;
        } catch (error) {
          if (error instanceof SessionGatewayError && [
            "AUTH_REQUIRED", "ROOM_NOT_FOUND", "STUDENT_ANALYTICS_NOT_PROMOTED",
          ].includes(error.code)) throw error;
          // A 409, malformed window, reducer baseline mismatch, replay marker,
          // or incomplete cursor always falls back to the already validated
          // canonical latest route for this exact room and key.
        }
      }
      const snapshot = await this.gateway.getProjectionLatest!(roomId, key, { signal });
      if (snapshot.analysisEpoch === frame.analysisEpoch
        && (snapshot.projectionVersion < frame.projectionVersion
          || snapshot.completeThroughRoomSeq < frame.completeThroughRoomSeq)) {
        throw new Error("PROJECTION_SNAPSHOT_BEHIND_FRAME");
      }
      this.projections.replaceSnapshot(snapshot);
    });
  }
}
