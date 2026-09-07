import { describe, expect, it } from "vitest";

import {
  amzTimestamps,
  authorizationHeaders,
  canonicalQueryString,
  presignUrl,
  rfc3986,
  EMPTY_PAYLOAD_SHA256,
} from "../../src/modules/media/s3-signature.js";

// The two published AWS vectors for the shapes this pipeline actually uses:
// a presigned GET a browser follows, and a signed PUT the server makes.
const AWS_EXAMPLE = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
};

describe("S3 signature version 4", () => {
  it("reproduces the published presigned GET vector exactly", () => {
    const { url } = presignUrl({
      method: "GET",
      endpoint: "https://examplebucket.s3.amazonaws.com",
      bucket: "",
      objectKey: "test.txt",
      expiresSeconds: 86_400,
      credentials: AWS_EXAMPLE,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toContain(
      "X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
    expect(url).toContain("X-Amz-Expires=86400");
    expect(url).toContain("X-Amz-SignedHeaders=host");
  });

  it("reproduces the published signed PUT vector exactly", () => {
    const headers = authorizationHeaders({
      method: "PUT",
      endpoint: "https://examplebucket.s3.amazonaws.com",
      path: "/test$file.text",
      headers: {
        date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payloadSha256: "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
      credentials: AWS_EXAMPLE,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(headers.authorization).toContain(
      "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
  });

  it("binds a required header into the signature", () => {
    const base = {
      method: "PUT" as const,
      endpoint: "http://127.0.0.1:59000",
      bucket: "media",
      objectKey: "staging/a",
      expiresSeconds: 300,
      credentials: AWS_EXAMPLE,
      now: new Date("2026-08-30T08:00:00Z"),
    };
    const one = presignUrl({ ...base, signedHeaders: { "x-amz-checksum-sha256": "AAA=" } });
    const other = presignUrl({ ...base, signedHeaders: { "x-amz-checksum-sha256": "BBB=" } });
    // A grant issued for one checksum cannot be replayed for different bytes.
    expect(one.url).not.toBe(other.url);
    expect(one.url).toContain("X-Amz-SignedHeaders=host%3Bx-amz-checksum-sha256");
  });

  it("encodes paths and queries by the rules S3 signs against", () => {
    expect(rfc3986("a b~c!")).toBe("a%20b~c%21");
    expect(rfc3986("rooms/1/media", true)).toBe("rooms/1/media");
    expect(rfc3986("rooms/1/media")).toBe("rooms%2F1%2Fmedia");
    expect(canonicalQueryString({ b: "2", a: "1" })).toBe("a=1&b=2");
    expect(amzTimestamps(new Date("2026-09-07T19:30:00.123Z")))
      .toEqual({ amzDate: "20260907T193000Z", dateStamp: "20260907" });
  });

  it("refuses an unusable expiry or signing time", () => {
    const base = {
      method: "GET" as const,
      endpoint: "http://127.0.0.1:59000",
      bucket: "media",
      objectKey: "a",
      credentials: AWS_EXAMPLE,
      now: new Date("2026-08-30T08:00:00Z"),
    };
    for (const expiresSeconds of [0, -1, 604_801, 1.5]) {
      expect(() => presignUrl({ ...base, expiresSeconds })).toThrow("INVALID_PRESIGN_EXPIRY");
    }
    expect(() => authorizationHeaders({
      method: "GET",
      endpoint: "http://127.0.0.1:59000",
      path: "/media/a",
      payloadSha256: EMPTY_PAYLOAD_SHA256,
      credentials: AWS_EXAMPLE,
      now: new Date("not a date"),
    })).toThrow("INVALID_SIGNING_TIME");
  });
});
