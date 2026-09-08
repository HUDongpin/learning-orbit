import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Clock } from "../../src/clock.js";
import { MediaStoreSurfaceEraser } from "../../src/modules/media/media-surface-eraser.js";
import type { StoreCallControl } from "../../src/modules/media/media-store.js";
import { MemoryMediaStore } from "../../src/modules/media/s3-media-store.js";

/** Frozen: nothing here should depend on how long the suite itself takes. */
class FixedClock implements Clock {
  constructor(private readonly value = new Date("2026-08-30T08:00:00.000Z")) {}
  now(): Date { return new Date(this.value); }
}

/** A real store that also remembers how it was called. */
class RecordingStore extends MemoryMediaStore {
  readonly calls: { keys: string[]; deadline: Date }[] = [];
  failure: string | null = null;

  override async deleteObjects(objectKeys: string[], control: StoreCallControl): Promise<void> {
    this.calls.push({ keys: [...objectKeys], deadline: control.deadline });
    if (this.failure) throw new Error(this.failure);
    await super.deleteObjects(objectKeys, control);
  }
}

const bytes = (value: string) => new TextEncoder().encode(value);

function eraserOver(store: RecordingStore, clock: Clock = new FixedClock()) {
  return new MediaStoreSurfaceEraser(store, clock);
}

describe("media surface eraser", () => {
  it("removes exactly the room's objects and leaves every other room's alone", async () => {
    const roomId = randomUUID();
    const otherRoomId = randomUUID();
    const mediaId = randomUUID();
    const original = `rooms/${roomId}/original/${mediaId}`;
    const derivative = `rooms/${roomId}/derivative/${mediaId}/sanitized_image`;
    const neighbour = `rooms/${otherRoomId}/original/${randomUUID()}`;
    const store = new RecordingStore();
    store.put(original, bytes("leaf"));
    store.put(derivative, bytes("leaf-small"));
    store.put(neighbour, bytes("another classroom"));

    await eraserOver(store).eraseRoomObjects(roomId, [original, derivative]);

    expect([...store.objects.keys()]).toEqual([neighbour]);
    expect(store.calls.map(({ keys }) => keys)).toEqual([[original, derivative]]);
  });

  it("refuses a key that addresses another room, before deleting anything", async () => {
    const roomId = randomUUID();
    const otherRoomId = randomUUID();
    const own = `rooms/${roomId}/original/${randomUUID()}`;
    const foreign = `rooms/${otherRoomId}/original/${randomUUID()}`;
    const store = new RecordingStore();
    store.put(own, bytes("mine"));
    store.put(foreign, bytes("not mine"));

    await expect(eraserOver(store).eraseRoomObjects(roomId, [own, foreign]))
      .rejects.toThrow("MEDIA_SURFACE_KEY_OUT_OF_ROOM");

    // The refusal is for the whole call: the store was never reached, so the
    // room's own object also survives and the surface stays incomplete.
    expect(store.calls).toEqual([]);
    expect([...store.objects.keys()].sort()).toEqual([own, foreign].sort());
  });

  it("refuses a traversal that would escape the room prefix it just checked", async () => {
    const roomId = randomUUID();
    const otherRoomId = randomUUID();
    const store = new RecordingStore();

    await expect(eraserOver(store).eraseRoomObjects(
      roomId,
      [`rooms/${roomId}/../${otherRoomId}/original/${randomUUID()}`],
    )).rejects.toThrow("MEDIA_SURFACE_KEY_OUT_OF_ROOM");
    await expect(eraserOver(store).eraseRoomObjects(roomId, [`rooms/${roomId}/`]))
      .rejects.toThrow("MEDIA_SURFACE_KEY_OUT_OF_ROOM");
    await expect(eraserOver(store).eraseRoomObjects("room-one", [`rooms/room-one/original/x`]))
      .rejects.toThrow("MEDIA_SURFACE_ROOM_IDENTITY_INVALID");
    expect(store.calls).toEqual([]);
  });

  it("treats an object that is already gone as erased, so a retried saga converges", async () => {
    const roomId = randomUUID();
    const key = `rooms/${roomId}/original/${randomUUID()}`;
    const store = new RecordingStore();
    store.put(key, bytes("leaf"));
    const eraser = eraserOver(store);

    await eraser.eraseRoomObjects(roomId, [key]);
    await expect(eraser.eraseRoomObjects(roomId, [key])).resolves.toBeUndefined();

    expect(store.objects.size).toBe(0);
    expect(store.calls).toHaveLength(2);
  });

  it("erases in bounded batches, each with its own bounded call control", async () => {
    const roomId = randomUUID();
    const keys = Array.from({ length: 60 }, () => `rooms/${roomId}/original/${randomUUID()}`);
    const store = new RecordingStore();
    keys.forEach((key) => { store.put(key, bytes("leaf")); });
    const clock = new FixedClock();

    await eraserOver(store, clock).eraseRoomObjects(roomId, keys);

    expect(store.calls.map(({ keys: batch }) => batch.length)).toEqual([25, 25, 10]);
    expect(store.calls.flatMap(({ keys: batch }) => batch)).toEqual(keys);
    for (const { deadline } of store.calls) {
      const budgetMs = deadline.getTime() - clock.now().getTime();
      expect(budgetMs).toBeGreaterThan(0);
      expect(budgetMs).toBeLessThanOrEqual(30_000);
    }
    expect(store.objects.size).toBe(0);
  });

  it("deduplicates keys rather than issuing the same delete twice", async () => {
    const roomId = randomUUID();
    const key = `rooms/${roomId}/original/${randomUUID()}`;
    const store = new RecordingStore();
    store.put(key, bytes("leaf"));

    await eraserOver(store).eraseRoomObjects(roomId, [key, key, key]);

    expect(store.calls.map(({ keys }) => keys)).toEqual([[key]]);
  });

  it("accepts a grant's staging key and promotion destination under the room prefix", async () => {
    const roomId = randomUUID();
    const mediaId = randomUUID();
    // The two shapes `media_upload_grant` carries. Both are built as
    // `rooms/{roomId}/...` at write time, so the room-prefix rule holds for
    // them without being loosened for a grant.
    const staging = `rooms/${roomId}/staging/${randomUUID()}`;
    const original = `rooms/${roomId}/original/${mediaId}`;
    const store = new RecordingStore();
    store.put(staging, bytes("a student's upload"));
    store.put(original, bytes("a student's upload"));

    await eraserOver(store).eraseRoomObjects(roomId, [original, staging]);

    expect(store.objects.size).toBe(0);
    expect(store.calls.map(({ keys }) => keys)).toEqual([[original, staging]]);
  });

  it("propagates a store failure rather than resolving as if the bytes were gone", async () => {
    const roomId = randomUUID();
    const key = `rooms/${roomId}/original/${randomUUID()}`;
    const store = new RecordingStore();
    store.put(key, bytes("leaf"));
    store.failure = "STORAGE_PROVIDER_UNAVAILABLE";

    await expect(eraserOver(store).eraseRoomObjects(roomId, [key]))
      .rejects.toThrow("STORAGE_PROVIDER_UNAVAILABLE");
    expect(store.objects.has(key)).toBe(true);
  });

  it("refuses to be built over a store that cannot delete", () => {
    expect(() => new MediaStoreSurfaceEraser(
      { capabilities: new MemoryMediaStore().capabilities } as never,
      new FixedClock(),
    )).toThrow("MEDIA_SURFACE_ERASER_UNCONFIGURED");
  });

  it("resolves an empty key list without calling the store", async () => {
    const store = new RecordingStore();

    await expect(eraserOver(store).eraseRoomObjects(randomUUID(), [])).resolves.toBeUndefined();

    expect(store.calls).toEqual([]);
  });
});
