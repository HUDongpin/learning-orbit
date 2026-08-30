import { routes, type AuthSession, type ProjectionFrame } from "@learning-orbit/contracts";

export type ProjectionAcceptResult = "accepted" | "epoch_changed" | "duplicate" | "stale" | "gap";
type ProjectionKey = ProjectionFrame["projectionKey"];

const STUDENT_KEYS = new Set<ProjectionKey>(["echo.student_approved", "trace.student_bundle"]);
const TEACHER_KEYS = new Set<ProjectionKey>(["echo.teacher_shadow", "trace.teacher_bundle"]);

export class ProjectionSync {
  readonly #references = new Map<ProjectionKey, ProjectionFrame>();
  #role: AuthSession["role"] | undefined;
  #roomId: string;

  constructor(
    roomId: string,
    session: AuthSession,
  ) { this.#roomId = roomId; this.#role = session.role; }

  get roomId(): string { return this.#roomId; }

  accept(frame: ProjectionFrame): ProjectionAcceptResult {
    if (this.#role === undefined) throw new Error("PROJECTION_AUTHORITY_CLEARED");
    if (frame.roomId !== this.#roomId) throw new Error("PROJECTION_ROOM_MISMATCH");
    const allowed = this.#role === "teacher" ? TEACHER_KEYS : STUDENT_KEYS;
    if (!allowed.has(frame.projectionKey)) throw new Error("PROJECTION_ROLE_FORBIDDEN");
    if (frame.snapshotUrl !== routes.analytics.latest(this.#roomId, frame.projectionKey)) {
      throw new Error("PROJECTION_SNAPSHOT_URL_INVALID");
    }

    const current = this.#references.get(frame.projectionKey);
    if (!current) {
      this.#references.set(frame.projectionKey, frame);
      return "accepted";
    }
    if (frame.analysisEpoch !== current.analysisEpoch) {
      this.#references.set(frame.projectionKey, frame);
      return "epoch_changed";
    }
    if (frame.projectionVersion === current.projectionVersion) return "duplicate";
    if (frame.projectionVersion < current.projectionVersion) return "stale";
    if (frame.projectionVersion !== current.projectionVersion + 1) return "gap";
    if (frame.completeThroughRoomSeq < current.completeThroughRoomSeq) {
      throw new Error("PROJECTION_CURSOR_REGRESSION");
    }
    this.#references.set(frame.projectionKey, frame);
    return "accepted";
  }

  current(key: ProjectionKey): ProjectionFrame | undefined {
    return this.#references.get(key);
  }

  references(): ProjectionFrame[] {
    return [...this.#references.values()].sort((left, right) => left.projectionKey.localeCompare(right.projectionKey));
  }

  reset(): void {
    this.#references.clear();
  }

  clearAuthority(): void {
    this.reset();
    this.#role = undefined;
    this.#roomId = "";
  }
}
