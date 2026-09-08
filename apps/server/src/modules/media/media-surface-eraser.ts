import type { Clock } from "../../clock.js";
import type { MediaSurfaceEraser } from "../lifecycle/internal-media-surface-route.js";
import type { MediaStore, StoreCallControl } from "./media-store.js";

/** Room ids reach this from `deletion_job.room_id`; nothing else can scope a key. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * `MediaStore.deleteObjects` spends two round trips per key - the delete, then
 * the HEAD that proves absence - so a batch is sized to finish inside one
 * store timeout rather than sized to be large.
 */
const BATCH_SIZE = 25;
const BATCH_TIMEOUT_MS = 15_000;
/**
 * The surface route erases inside its room-locked transaction, so one attempt
 * is bounded rather than allowed to run until an arbitrarily large room is
 * finished. An exhausted budget is a failure and never a partial success: the
 * route turns it back into a retryable outcome, and the next attempt gets
 * further because an object already removed answers its second delete without
 * transferring anything.
 */
const ATTEMPT_BUDGET_MS = 30_000;
/** S3 caps a key at 1024 bytes; a longer one cannot be an object we wrote. */
const MAX_OBJECT_KEY_BYTES = 1_024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/**
 * The physical half of media deletion, backed by the same `MediaStore` the
 * upload path writes through.
 *
 * Three decisions, all of them load-bearing:
 *
 * Scope. The keys arrive from a frozen deletion-surface manifest, read out of
 * `media_asset`, `media_upload_grant` (both its staging key and its promotion
 * destination) and `media_derivative` for one room, and every key this system
 * writes is built as `rooms/{roomId}/...` - staging, original and derivative
 * alike. That makes the room prefix an
 * invariant this can re-derive rather than trust: a key that does not sit
 * under the room being deleted is refused for the whole call, before any
 * delete is issued, so a mislabelled or tampered row can never be turned into
 * a delete against a different classroom's objects. The comparison is exact -
 * both sides come from the same Postgres uuid rendering - and a `..` segment
 * is refused because path-style addressing would let one escape the prefix
 * that was just checked.
 *
 * Batching. Keys go to the store in small groups, each with its own call
 * control, so a room with many objects cannot silently exceed one store
 * timeout. Partial progress is durable and safe: nothing is written back until
 * every batch has resolved.
 *
 * Idempotency. A second erase of an object that is already gone is success,
 * not failure - `S3HttpTransport.deleteObjects` accepts a 404 from the DELETE
 * and then requires 404 from its verifying HEAD, and `MemoryMediaStore` drops
 * an absent key without complaint. That is what makes a retried deletion saga
 * converge instead of dead-lettering on its own earlier progress.
 *
 * What it never does is resolve on anything less than proven absence. Every
 * failure path throws, and the route's only reading of a throw is "retryable".
 */
export class MediaStoreSurfaceEraser implements MediaSurfaceEraser {
  constructor(
    private readonly store: MediaStore,
    private readonly clock: Clock,
  ) {
    // A store that cannot delete must not be dressed up as an eraser: an
    // eraser that exists is the route's whole evidence that deletion can be
    // performed at all.
    if (typeof store?.deleteObjects !== "function" || typeof clock?.now !== "function") {
      throw new Error("MEDIA_SURFACE_ERASER_UNCONFIGURED");
    }
  }

  async eraseRoomObjects(roomId: string, objectKeys: readonly string[]): Promise<void> {
    const keys = this.#roomScopedKeys(roomId, objectKeys);
    if (keys.length === 0) return;
    const startedAt = this.#now();
    for (let index = 0; index < keys.length; index += BATCH_SIZE) {
      const remainingMs = ATTEMPT_BUDGET_MS - (this.#now().getTime() - startedAt.getTime());
      if (remainingMs <= 0) throw new Error("MEDIA_SURFACE_ERASE_INCOMPLETE");
      await this.store.deleteObjects(
        keys.slice(index, index + BATCH_SIZE),
        this.#control(Math.min(BATCH_TIMEOUT_MS, remainingMs)),
      );
    }
  }

  /**
   * Every key, proven to address this room, deduplicated and in a stable
   * order. Throws on the first key that does not - a manifest that names an
   * object outside the room is a manifest this refuses as a whole, because
   * erasing the rest of it would still let the surface report a deletion it
   * had no authority to perform.
   */
  #roomScopedKeys(roomId: string, objectKeys: readonly string[]): string[] {
    if (typeof roomId !== "string" || !UUID.test(roomId)) {
      throw new Error("MEDIA_SURFACE_ROOM_IDENTITY_INVALID");
    }
    if (!Array.isArray(objectKeys)) throw new Error("MEDIA_SURFACE_KEY_OUT_OF_ROOM");
    const prefix = `rooms/${roomId}/`;
    const seen = new Set<string>();
    const scoped: string[] = [];
    for (const key of objectKeys) {
      if (typeof key !== "string"
        || key.length <= prefix.length
        || !key.startsWith(prefix)
        || key.includes("..")
        || CONTROL_CHARACTERS.test(key)
        || Buffer.byteLength(key, "utf8") > MAX_OBJECT_KEY_BYTES) {
        throw new Error("MEDIA_SURFACE_KEY_OUT_OF_ROOM");
      }
      if (seen.has(key)) continue;
      seen.add(key);
      scoped.push(key);
    }
    return scoped;
  }

  #now(): Date {
    const value = this.clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("MEDIA_SURFACE_ERASER_CLOCK_INVALID");
    }
    return value;
  }

  #control(timeoutMs: number): StoreCallControl {
    const startedAt = this.#now();
    return {
      signal: AbortSignal.timeout(timeoutMs),
      deadline: new Date(startedAt.getTime() + timeoutMs),
      now: () => this.#now(),
    };
  }
}
