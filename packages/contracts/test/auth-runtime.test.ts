import { describe, expect, it } from "vitest";

import { authContract } from "../src/index.js";

const uuid = "11111111-1111-4111-8111-111111111111";

describe("auth runtime contract", () => {
  it("parses the closed request, accepted response, and both session branches", () => {
    expect(authContract.parseTeacherMagicLinkRequest({ email: "teacher@example.edu" })).toEqual({
      email: "teacher@example.edu",
    });
    expect(authContract.parseTeacherMagicLinkRequest({ email: " Teacher@Example.edu " })).toEqual({
      email: "teacher@example.edu",
    });
    expect(() => authContract.parseTeacherMagicLinkRequest({ email: "bad", extra: true }))
      .toThrow("INVALID_TEACHER_MAGIC_LINK_REQUEST");
    expect(authContract.encodeTeacherMagicLinkAccepted({ accepted: true })).toBe('{"accepted":true}');
    expect(() => authContract.encodeTeacherMagicLinkAccepted({ accepted: false }))
      .toThrow("INVALID_TEACHER_MAGIC_LINK_ACCEPTED");
    expect(authContract.encodeSession({ role: "teacher", teacherId: uuid, actorId: uuid }))
      .toContain('"role":"teacher"');
  });
});
