import { describe, expect, it } from "vitest";

import { redactLog } from "../../src/observability/redaction.js";

describe("redacted observability fields", () => {
  it("removes student content, signed URLs, cookies, and provider secrets", () => {
    const output = redactLog({
      roomId: "room-1",
      eventId: "event-1",
      text: "學生原文",
      cookie: "session=secret",
      uploadUrl: "https://store/object?X-Amz-Signature=secret",
      apiKey: "provider-secret",
    });
    expect(output).toEqual({
      roomId: "room-1",
      eventId: "event-1",
      text: "[REDACTED_CONTENT]",
      cookie: "[REDACTED_SECRET]",
      uploadUrl: "[REDACTED_URL]",
      apiKey: "[REDACTED_SECRET]",
    });
  });

  it("keeps only bounded correlation metadata and recursively redacts objects", () => {
    const output = redactLog({
      correlationId: "corr-1",
      durationMs: 12,
      nested: { prompt: "秘密", roomSeq: 4 },
      authorization: "Bearer secret",
    });
    expect(output).toEqual({
      correlationId: "corr-1",
      durationMs: 12,
      nested: "[REDACTED_CONTENT]",
      authorization: "[REDACTED_SECRET]",
    });
  });
});
