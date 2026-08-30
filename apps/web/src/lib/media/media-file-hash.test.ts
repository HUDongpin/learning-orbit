import { describe, expect, it } from "vitest";

import { sha256Blob } from "./media-file-hash.js";

describe("bounded browser media hashing", () => {
  it("returns the exact SHA-256 hex and base64 encodings", async () => {
    await expect(sha256Blob(new Blob(["abc"]), new AbortController().signal)).resolves.toEqual({
      hex: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      base64: "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
    });
  });

  it("rejects pre/post digest abort and the frozen 25 MiB ceiling", async () => {
    const before = new AbortController();
    before.abort();
    await expect(sha256Blob(new Blob(["abc"]), before.signal)).rejects.toMatchObject({ name: "AbortError" });
    const after = new AbortController();
    let finish!: (value: ArrayBuffer) => void;
    const delayed = { size: 3, arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }) } as Blob;
    const pending = sha256Blob(delayed, after.signal);
    after.abort();
    finish(new TextEncoder().encode("abc").buffer as ArrayBuffer);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(sha256Blob(new Blob([new Uint8Array(25 * 1024 * 1024 + 1)]), new AbortController().signal))
      .rejects.toThrow("MEDIA_SIZE_OUT_OF_RANGE");
  });
});
