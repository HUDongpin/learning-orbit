import { describe, expect, it, vi } from "vitest";

import { MediaAttachmentLimitError, MediaSlotReservations } from "./media-slot-reservations.js";

describe("central media slot reservations", () => {
  it("lets only one concurrent upload claim the final slot before either grant starts", async () => {
    const slots = new MediaSlotReservations(4, ["m1", "m2", "m3"]);
    let resolveFirst!: (value: { mediaId: string }) => void;
    const firstWork = vi.fn(() => new Promise<{ mediaId: string }>((resolve) => { resolveFirst = resolve; }));
    const secondWork = vi.fn(async () => ({ mediaId: "m5" }));

    const first = slots.run(firstWork);
    await expect(slots.run(secondWork)).rejects.toBeInstanceOf(MediaAttachmentLimitError);
    expect(secondWork).not.toHaveBeenCalled();
    resolveFirst({ mediaId: "m4" });
    await expect(first).resolves.toEqual({ mediaId: "m4" });
    expect(slots.occupied).toBe(4);
  });

  it("releases a failed reservation and rejects duplicate completed identifiers", async () => {
    const slots = new MediaSlotReservations(2);
    await expect(slots.run(async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await expect(slots.run(async () => ({ mediaId: "m1" }))).resolves.toEqual({ mediaId: "m1" });
    await expect(slots.run(async () => ({ mediaId: "m1" }))).rejects.toThrow("MEDIA_ID_DUPLICATE");
    slots.remove("m1");
    await expect(slots.run(async () => ({ mediaId: "m1" }))).resolves.toEqual({ mediaId: "m1" });
  });
});
