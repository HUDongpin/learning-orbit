import {
  analyticsContract,
  routes,
  type AuthSession,
  type ConceptMapPatch,
  type ConceptMapSnapshot,
  type ProjectionFrame,
  type SnaProjectionBundle,
} from "@learning-orbit/contracts";
import { applyConceptPatch } from "../analytics/concept-reducer";

export type ProjectionAcceptResult = "accepted" | "epoch_changed" | "duplicate" | "stale" | "gap";
type ProjectionKey = ProjectionFrame["projectionKey"];
export type ProjectionAvailability = "loading" | "ready" | "not_available_by_policy" | "not_ready" | "failed";
export type ProjectionSnapshot = ConceptMapSnapshot | SnaProjectionBundle;
export type ProjectionSlot = Readonly<{
  availability: ProjectionAvailability;
  snapshot?: ProjectionSnapshot;
  errorCode?: string;
}>;

const STUDENT_KEYS = new Set<ProjectionKey>(["echo.student_approved", "trace.student_bundle"]);
const TEACHER_KEYS = new Set<ProjectionKey>(["echo.teacher_shadow", "trace.teacher_bundle"]);

export class ProjectionSync {
  readonly #references = new Map<ProjectionKey, ProjectionFrame>();
  readonly #slots = new Map<ProjectionKey, ProjectionSlot>();
  readonly #allowed: readonly ProjectionKey[];
  #role: AuthSession["role"] | undefined;
  #roomId: string;

  constructor(
    roomId: string,
    session: AuthSession,
  ) {
    this.#roomId = roomId;
    this.#role = session.role;
    this.#allowed = session.role === "teacher"
      ? ["echo.teacher_shadow", "trace.teacher_bundle"]
      : ["echo.student_approved", "trace.student_bundle"];
    for (const key of this.#allowed) this.#slots.set(key, { availability: "loading" });
  }

  get roomId(): string { return this.#roomId; }

  allowedKeys(): ProjectionKey[] { return [...this.#allowed]; }

  /** Whether this role holds the projection at all, without throwing. */
  holds(key: ProjectionKey): boolean {
    if (this.#role === undefined) return false;
    return (this.#role === "teacher" ? TEACHER_KEYS : STUDENT_KEYS).has(key);
  }

  #assertAllowed(key: ProjectionKey): void {
    if (this.#role === undefined) throw new Error("PROJECTION_AUTHORITY_CLEARED");
    const allowed = this.#role === "teacher" ? TEACHER_KEYS : STUDENT_KEYS;
    if (!allowed.has(key)) throw new Error("PROJECTION_ROLE_FORBIDDEN");
  }

  #assertFrame(frame: ProjectionFrame): void {
    this.#assertAllowed(frame.projectionKey);
    if (frame.roomId !== this.#roomId) throw new Error("PROJECTION_ROOM_MISMATCH");
    if (frame.snapshotUrl !== routes.analytics.latest(this.#roomId, frame.projectionKey)) {
      throw new Error("PROJECTION_SNAPSHOT_URL_INVALID");
    }
  }

  accept(frame: ProjectionFrame): ProjectionAcceptResult {
    this.#assertFrame(frame);

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

  slot(key: ProjectionKey): ProjectionSlot {
    this.#assertAllowed(key);
    return { ...(this.#slots.get(key) ?? { availability: "loading" }) };
  }

  replaceSnapshot(candidate: ProjectionSnapshot): void {
    this.#assertAllowed(candidate.projectionKey);
    if (candidate.roomId !== this.#roomId) throw new Error("PROJECTION_ROOM_MISMATCH");
    let snapshot: ProjectionSnapshot;
    if (candidate.projectionKey === "echo.student_approved") snapshot = analyticsContract.parseStudentEchoSnapshot(candidate);
    else if (candidate.projectionKey === "echo.teacher_shadow") snapshot = analyticsContract.parseTeacherEchoSnapshot(candidate);
    else snapshot = analyticsContract.parseTrace(candidate);
    if (snapshot.requiresReplay || snapshot.evidenceStatus !== "active") {
      throw new Error("PROJECTION_REPLAY_REQUIRED");
    }
    this.#references.set(snapshot.projectionKey, {
      type: "projection",
      roomId: snapshot.roomId,
      projectionKey: snapshot.projectionKey,
      analysisEpoch: snapshot.analysisEpoch,
      projectionVersion: snapshot.projectionVersion,
      completeThroughRoomSeq: snapshot.completeThroughRoomSeq,
      snapshotUrl: routes.analytics.latest(snapshot.roomId, snapshot.projectionKey),
    });
    this.#slots.set(snapshot.projectionKey, { availability: "ready", snapshot });
  }

  applyEchoPatches(
    key: Extract<ProjectionKey, `echo.${string}`>,
    patches: readonly ConceptMapPatch[],
    target: ProjectionFrame,
  ): void {
    this.#assertAllowed(key);
    this.#assertFrame(target);
    if (target.projectionKey !== key) throw new Error("PROJECTION_PATCH_TARGET_MISMATCH");
    const current = this.#slots.get(key)?.snapshot;
    if (!current || (current.projectionKey !== "echo.student_approved" && current.projectionKey !== "echo.teacher_shadow")) {
      throw new Error("PROJECTION_PATCH_BASE_MISSING");
    }
    let next: ConceptMapSnapshot = current;
    for (const patch of patches) next = applyConceptPatch(next, patch);
    if (next.analysisEpoch !== target.analysisEpoch
      || next.projectionVersion !== target.projectionVersion
      || next.completeThroughRoomSeq !== target.completeThroughRoomSeq) {
      throw new Error("PROJECTION_PATCH_TARGET_NOT_REACHED");
    }
    this.#references.set(key, target);
    this.#slots.set(key, { availability: "ready", snapshot: next });
  }

  markLoading(key: ProjectionKey): void {
    this.#assertAllowed(key);
    const current = this.#slots.get(key);
    this.#slots.set(key, { availability: "loading", ...(current?.snapshot ? { snapshot: current.snapshot } : {}) });
  }

  markPolicyUnavailable(key: ProjectionKey): void {
    this.#assertAllowed(key);
    this.#references.delete(key);
    this.#slots.set(key, { availability: "not_available_by_policy" });
  }

  markNotReady(key: ProjectionKey): void {
    this.#assertAllowed(key);
    this.#references.delete(key);
    this.#slots.set(key, { availability: "not_ready" });
  }

  markFailed(key: ProjectionKey, errorCode: string): void {
    this.#assertAllowed(key);
    const current = this.#slots.get(key);
    this.#slots.set(key, {
      availability: "failed",
      ...(current?.snapshot ? { snapshot: current.snapshot } : {}),
      errorCode,
    });
  }

  markAuthorityUnavailable(key: ProjectionKey, errorCode: string): void {
    this.#assertAllowed(key);
    this.#references.delete(key);
    this.#slots.set(key, { availability: "failed", errorCode });
  }

  references(): ProjectionFrame[] {
    return [...this.#references.values()].sort((left, right) => left.projectionKey.localeCompare(right.projectionKey));
  }

  reset(): void {
    this.#references.clear();
    this.#slots.clear();
    if (this.#role !== undefined) {
      for (const key of this.#allowed) this.#slots.set(key, { availability: "loading" });
    }
  }

  clearAuthority(): void {
    this.reset();
    this.#role = undefined;
    this.#roomId = "";
    this.#slots.clear();
  }
}
