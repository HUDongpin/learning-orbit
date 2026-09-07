export const PROJECTION_SURFACES = ["chatLedger", "concept", "sna"] as const;

export type ProjectionSurface = (typeof PROJECTION_SURFACES)[number];
export type SurfaceAvailability = "enabled" | "not_available_by_policy";

export interface StagedProjection<T = unknown> {
  readonly projectionVersion: number;
  readonly completeThroughRoomSeq: number;
  readonly value: T;
}

export interface CoherentBatch {
  readonly status: "ready";
  readonly completeThroughRoomSeq: number;
  readonly projectionVersions: Readonly<Partial<Record<ProjectionSurface, number>>>;
  readonly unavailableByPolicy: readonly ProjectionSurface[];
  readonly chatLedger: unknown;
  readonly concept: unknown;
  readonly sna: unknown;
}

/**
 * Publish the panels together, or not at all.
 *
 * Each projection arrives on its own schedule, and each carries its own
 * version and its own room-sequence cursor. Rendering them as they land shows
 * a concept map built from more of the conversation than the chat beside it -
 * a teacher reading the two together would see a claim the transcript does not
 * support yet, with nothing on screen saying so.
 *
 * So a batch is published only when every *enabled* surface has reached the
 * same `completeThroughRoomSeq`. A surface withheld by policy is excluded from
 * the agreement entirely rather than being given a cursor it never had:
 * inventing one would let a promoted panel appear complete because an
 * unpromoted one was assumed to be.
 */
export class ProjectionCoordinator {
  readonly #staged = new Map<ProjectionSurface, StagedProjection>();
  readonly #availability = new Map<ProjectionSurface, SurfaceAvailability>(
    PROJECTION_SURFACES.map((surface) => [surface, "enabled"]),
  );
  #lastPublished: number | undefined;

  constructor(private readonly publish: (batch: CoherentBatch) => void) {}

  setAvailability(surface: ProjectionSurface, availability: SurfaceAvailability): void {
    this.#availability.set(surface, availability);
    if (availability === "not_available_by_policy") this.#staged.delete(surface);
    this.#publishWhenCoherent();
  }

  stage<T>(surface: ProjectionSurface, projection: StagedProjection<T>): void {
    if (this.#availability.get(surface) === "not_available_by_policy") return;
    if (!Number.isSafeInteger(projection.projectionVersion) || projection.projectionVersion < 0) return;
    if (!Number.isSafeInteger(projection.completeThroughRoomSeq) || projection.completeThroughRoomSeq < 0) return;
    this.#staged.set(surface, projection);
    this.#publishWhenCoherent();
  }

  /** The cursor every enabled surface agrees on, or undefined while they differ. */
  coherentCursor(): number | undefined {
    const enabled = PROJECTION_SURFACES.filter(
      (surface) => this.#availability.get(surface) === "enabled",
    );
    if (enabled.length === 0) return undefined;
    const staged = enabled.map((surface) => this.#staged.get(surface));
    if (staged.some((projection) => projection === undefined)) return undefined;
    const cursors = new Set(staged.map((projection) => projection!.completeThroughRoomSeq));
    return cursors.size === 1 ? [...cursors][0] : undefined;
  }

  #publishWhenCoherent(): void {
    const cursor = this.coherentCursor();
    if (cursor === undefined) return;
    // A cursor that has not advanced is the same batch; republishing it would
    // make a re-render look like new classroom activity.
    if (this.#lastPublished === cursor) return;
    this.#lastPublished = cursor;

    const projectionVersions: Partial<Record<ProjectionSurface, number>> = {};
    for (const surface of PROJECTION_SURFACES) {
      const staged = this.#staged.get(surface);
      if (staged) projectionVersions[surface] = staged.projectionVersion;
    }
    this.publish(Object.freeze({
      status: "ready",
      completeThroughRoomSeq: cursor,
      projectionVersions: Object.freeze(projectionVersions),
      unavailableByPolicy: Object.freeze(PROJECTION_SURFACES.filter(
        (surface) => this.#availability.get(surface) === "not_available_by_policy",
      )),
      chatLedger: this.#staged.get("chatLedger")?.value ?? null,
      concept: this.#staged.get("concept")?.value ?? null,
      sna: this.#staged.get("sna")?.value ?? null,
    }));
  }
}

const SURFACE_COPY: Readonly<Record<ProjectionSurface, string>> = {
  chatLedger: "聊天投影",
  concept: "概念投影",
  sna: "SNA 投影",
};

/**
 * Say what is on screen, in the terms a reader can check.
 *
 * The room sequence and each projection version are named explicitly, so a
 * teacher can tell a stale panel from a quiet classroom rather than guessing.
 */
export function formatProjectionReadyStatus(batch: CoherentBatch): string {
  const versions = PROJECTION_SURFACES
    .filter((surface) => batch.projectionVersions[surface] !== undefined)
    .map((surface) => `${SURFACE_COPY[surface]} ${batch.projectionVersions[surface]}`)
    .join("、");
  return `已同步至房間序號 ${batch.completeThroughRoomSeq}（${versions}）`;
}
