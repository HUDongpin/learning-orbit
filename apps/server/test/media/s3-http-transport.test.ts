import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { S3HttpTransport } from "../../src/modules/media/s3-http-transport.js";
import type { StoreCallControl } from "../../src/modules/media/media-store.js";

const CREDENTIALS = {
  accessKeyId: "local-key",
  secretAccessKey: "local-secret",
  region: "us-east-1",
};

const control = (): StoreCallControl => ({
  signal: new AbortController().signal,
  deadline: new Date(Date.now() + 30_000),
});

interface StoredObject {
  bytes: Buffer;
  mime: string;
}

/**
 * A deliberately literal S3 double: it answers only what MinIO answers, and it
 * reproduces the one behaviour that broke the first implementation - a copy
 * overwrites even under If-None-Match.
 */
function fakeStore(initial: Record<string, StoredObject> = {}) {
  const objects = new Map(Object.entries(initial));
  const requests: Array<{ method: string; key: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const key = decodeURIComponent(parsed.pathname.replace("/media/", ""));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>)
        .map(([name, value]) => [name.toLowerCase(), value]),
    );
    requests.push({ method, key, headers });
    const existing = objects.get(key);
    const respond = (status: number, extra: Record<string, string> = {}, body?: Buffer) =>
      new Response(status === 204 || method === "HEAD" ? null : (body ?? null), {
        status,
        headers: extra,
      });

    if (method === "HEAD" || method === "GET") {
      if (!existing) return respond(404);
      if (headers["if-match"] && headers["if-match"] !== etagOf(existing)) return respond(412);
      const digest = createHash("sha256").update(existing.bytes).digest();
      return respond(200, {
        "content-length": String(existing.bytes.length),
        "content-type": existing.mime,
        etag: `"${etagOf(existing)}"`,
        "x-amz-checksum-sha256": digest.toString("base64"),
      }, existing.bytes);
    }
    if (method === "PUT") {
      if (headers["if-none-match"] === "*" && existing) return respond(412);
      const body = Buffer.from((init?.body as Uint8Array | undefined) ?? Buffer.alloc(0));
      objects.set(key, { bytes: body, mime: headers["content-type"] ?? "application/octet-stream" });
      return respond(200);
    }
    if (method === "DELETE") {
      objects.delete(key);
      return respond(204);
    }
    return respond(405);
  }) as unknown as typeof globalThis.fetch;

  const etagOf = (object: StoredObject) => createHash("md5").update(object.bytes).digest("hex");
  const transport = new S3HttpTransport({
    endpoint: "http://127.0.0.1:59000",
    bucket: "media",
    credentials: CREDENTIALS,
    fetch: fetchImpl,
  });
  return { transport, objects, requests, etagOf };
}

const LEAF = Buffer.from("leaf bytes");
const LEAF_SHA = createHash("sha256").update(LEAF).digest("hex");
const OTHER = Buffer.from("other bytes");
const OTHER_SHA = createHash("sha256").update(OTHER).digest("hex");

describe("S3 HTTP transport", () => {
  it("refuses a configuration that cannot address one exact bucket", () => {
    for (const options of [
      { endpoint: "http://127.0.0.1:59000/media", bucket: "media" },
      { endpoint: "http://127.0.0.1:59000?x=1", bucket: "media" },
      { endpoint: "http://127.0.0.1:59000", bucket: "Media" },
      { endpoint: "http://127.0.0.1:59000", bucket: "a" },
    ]) {
      expect(() => new S3HttpTransport({ ...options, credentials: CREDENTIALS }))
        .toThrow("STORAGE_TRANSPORT_CONFIG_INVALID");
    }
  });

  it("promotes once and answers a retry from the destination that already holds those bytes", async () => {
    const store = fakeStore({ "staging/a": { bytes: LEAF, mime: "image/png" } });
    const source = await store.transport.stat("staging/a", control());
    expect(source.sha256).toBe(LEAF_SHA);

    const first = await store.transport.promoteStagingObject({
      stagingKey: "staging/a", destinationKey: "rooms/r/media/m",
      sourceEtag: source.etag, expectedSha256: LEAF_SHA, ifDestinationAbsent: true,
    }, control());
    const retry = await store.transport.promoteStagingObject({
      stagingKey: "staging/a", destinationKey: "rooms/r/media/m",
      sourceEtag: source.etag, expectedSha256: LEAF_SHA, ifDestinationAbsent: true,
    }, control());

    expect([first, retry]).toEqual(["created", "already_present_same_hash"]);
    expect(store.objects.get("rooms/r/media/m")?.bytes.equals(LEAF)).toBe(true);
    // The destination is written with the precondition, never copied: a copy is
    // silently overwriting on the store this runs against.
    const destinationPuts = store.requests.filter(
      ({ method, key }) => method === "PUT" && key === "rooms/r/media/m",
    );
    expect(destinationPuts).toHaveLength(1);
    expect(destinationPuts[0]!.headers["if-none-match"]).toBe("*");
    expect(store.requests.some(({ headers }) => "x-amz-copy-source" in headers)).toBe(false);
  });

  it("refuses to overwrite a destination that holds different bytes", async () => {
    const store = fakeStore({
      "staging/b": { bytes: OTHER, mime: "image/png" },
      "rooms/r/media/m": { bytes: LEAF, mime: "image/png" },
    });
    const source = await store.transport.stat("staging/b", control());

    await expect(store.transport.promoteStagingObject({
      stagingKey: "staging/b", destinationKey: "rooms/r/media/m",
      sourceEtag: source.etag, expectedSha256: OTHER_SHA, ifDestinationAbsent: true,
    }, control())).rejects.toThrow("OBJECT_PROMOTION_MISMATCH");
    expect(store.objects.get("rooms/r/media/m")?.bytes.equals(LEAF)).toBe(true);
  });

  it("refuses a source whose identity changed under the grant", async () => {
    const store = fakeStore({ "staging/c": { bytes: LEAF, mime: "image/png" } });

    await expect(store.transport.promoteStagingObject({
      stagingKey: "staging/c", destinationKey: "rooms/r/media/n",
      sourceEtag: "0".repeat(32), expectedSha256: LEAF_SHA, ifDestinationAbsent: true,
    }, control())).rejects.toThrow("OBJECT_IDENTITY_CHANGED");
    expect(store.objects.has("rooms/r/media/n")).toBe(false);
  });

  it("treats a stored object with no checksum as unusable rather than trusting its etag", async () => {
    const transport = new S3HttpTransport({
      endpoint: "http://127.0.0.1:59000",
      bucket: "media",
      credentials: CREDENTIALS,
      fetch: (async () => new Response(null, {
        status: 200,
        headers: { "content-length": "10", etag: '"abc"' },
      })) as unknown as typeof globalThis.fetch,
    });
    await expect(transport.stat("rooms/r/media/m", control()))
      .rejects.toThrow("OBJECT_CHECKSUM_UNAVAILABLE");
  });

  it("proves absence after deleting instead of trusting the delete status", async () => {
    const store = fakeStore({ "rooms/r/media/m": { bytes: LEAF, mime: "image/png" } });
    await store.transport.deleteObjects(["rooms/r/media/m"], control());
    expect(store.objects.size).toBe(0);
    expect(store.requests.filter(({ method }) => method === "HEAD")).toHaveLength(1);

    const stubborn = new S3HttpTransport({
      endpoint: "http://127.0.0.1:59000",
      bucket: "media",
      credentials: CREDENTIALS,
      fetch: (async (_url: string, init?: RequestInit) => (
        (init?.method ?? "GET") === "DELETE"
          ? new Response(null, { status: 204 })
          : new Response(null, {
            status: 200,
            headers: { "content-length": "1", etag: '"a"', "x-amz-checksum-sha256": Buffer.from(LEAF_SHA, "hex").toString("base64") },
          })
      )) as unknown as typeof globalThis.fetch,
    });
    await expect(stubborn.deleteObjects(["rooms/r/media/m"], control()))
      .rejects.toThrow("STORAGE_DELETE_UNVERIFIED");
  });

  it("issues a presigned upload that pins the checksum the client must send", async () => {
    const store = fakeStore();
    const grant = await store.transport.createUploadUrl({
      objectKey: "staging/d",
      mime: "image/png",
      sizeBytes: LEAF.length,
      checksumSha256Base64: Buffer.from(LEAF_SHA, "hex").toString("base64"),
      expiresSeconds: 300,
    }, control());
    expect(grant.requiredHeaders["x-amz-checksum-sha256"])
      .toBe(Buffer.from(LEAF_SHA, "hex").toString("base64"));
    expect(grant.url).toContain("X-Amz-SignedHeaders=host%3Bx-amz-checksum-sha256");
    expect(grant.expiresAt.getTime() - grant.signedAt.getTime()).toBe(300_000);
  });
});
