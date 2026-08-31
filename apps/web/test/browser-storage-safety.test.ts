import { beforeEach, describe, expect, it } from "vitest";

import { browserStorageHasNoCredentialArtifacts } from "../e2e/browser-storage-safety.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const ACTOR_ID = "00000000-0000-4000-8000-000000000011";

function encodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function storeDebugChunks(...values: string[]): void {
  sessionStorage.setItem(
    "__next_debug_channel:pilot",
    JSON.stringify(values.map(encodeUtf8)),
  );
}

describe("browser storage credential boundary", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("accepts empty storage and bounded canonical Next debug chunks containing only an allowed room id", () => {
    expect(browserStorageHasNoCredentialArtifacts()).toBe(true);
    storeDebugChunks("<!doctype html><p>Learning Orbit ", `${ROOM_ID}</p>`);
    expect(browserStorageHasNoCredentialArtifacts({ allowedUuids: [ROOM_ID] })).toBe(true);
  });

  it("rejects credentials hidden across Base64 chunks, identity UUIDs, and exact forbidden values", () => {
    storeDebugChunks("/v1/auth/teacher/magic-link/con", "sume?token=opaque-test-token");
    expect(browserStorageHasNoCredentialArtifacts()).toBe(false);

    sessionStorage.clear();
    storeDebugChunks(String.raw`{\"token\":\"opaque-test-token\"}`);
    expect(browserStorageHasNoCredentialArtifacts()).toBe(false);

    sessionStorage.clear();
    storeDebugChunks(String.raw`{\"role\":\"teacher\"}`);
    expect(browserStorageHasNoCredentialArtifacts()).toBe(false);

    sessionStorage.clear();
    storeDebugChunks(String.raw`{\"actorId\":\"00000000-0000-4000-8000-000000000011\"}`);
    expect(browserStorageHasNoCredentialArtifacts({ allowedUuids: [ACTOR_ID] })).toBe(false);

    sessionStorage.clear();
    storeDebugChunks(`{\"actorId\":\"${ACTOR_ID}\"}`);
    expect(browserStorageHasNoCredentialArtifacts({ allowedUuids: [ROOM_ID] })).toBe(false);

    sessionStorage.clear();
    storeDebugChunks(`safe-prefix:${ACTOR_ID}:safe-suffix`);
    expect(browserStorageHasNoCredentialArtifacts({ allowedUuids: [ROOM_ID] })).toBe(false);

    sessionStorage.clear();
    storeDebugChunks("one-time-code:ABC2345678");
    expect(browserStorageHasNoCredentialArtifacts({
      forbiddenValues: ["ABC2345678"],
    })).toBe(false);

    sessionStorage.clear();
    storeDebugChunks("one-time-code:abc2345678");
    expect(browserStorageHasNoCredentialArtifacts({
      forbiddenValues: ["ABC2345678"],
    })).toBe(false);
  });

  it("fails closed for local storage, unknown keys, malformed JSON, and non-canonical Base64", () => {
    localStorage.setItem("theme", "light");
    expect(browserStorageHasNoCredentialArtifacts()).toBe(false);

    localStorage.clear();
    sessionStorage.setItem("unexpected", "[]");
    expect(browserStorageHasNoCredentialArtifacts()).toBe(false);

    sessionStorage.clear();
    sessionStorage.setItem("__next_debug_channel:pilot", "{}");
    expect(browserStorageHasNoCredentialArtifacts()).toBe(false);

    sessionStorage.setItem("__next_debug_channel:pilot", '[ "YQ==" ]');
    expect(browserStorageHasNoCredentialArtifacts()).toBe(false);

    sessionStorage.setItem("__next_debug_channel:pilot", JSON.stringify(["YQ"]));
    expect(browserStorageHasNoCredentialArtifacts()).toBe(false);

    sessionStorage.clear();
    Reflect.set(self, "__next_r", "current");
    try {
      expect(browserStorageHasNoCredentialArtifacts()).toBe(false);
      sessionStorage.setItem("__next_debug_channel:current", JSON.stringify([encodeUtf8("safe")]));
      expect(browserStorageHasNoCredentialArtifacts()).toBe(true);
    } finally {
      Reflect.deleteProperty(self, "__next_r");
    }
  });
});
