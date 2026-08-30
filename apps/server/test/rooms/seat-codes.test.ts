import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CodeHasher,
  makeRoomCode,
  makeSeatCode,
} from "../../src/modules/rooms/seat-codes.js";

describe("room and seat code primitives", () => {
  it("generates codes only from the unambiguous product alphabet", () => {
    const roomCodes = Array.from({ length: 64 }, makeRoomCode);
    const seatCodes = Array.from({ length: 64 }, makeSeatCode);

    expect(roomCodes.every((code) => /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code)))
      .toBe(true);
    expect(seatCodes.every((code) => /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/.test(code)))
      .toBe(true);
  });

  it("stores a versioned HMAC, normalizes input, and never falls back to plain SHA-256", () => {
    const pepper = Buffer.alloc(32, 0x41);
    const hasher = new CodeHasher(7, new Map([[7, pepper]]));
    const stored = hasher.hash(" abcd23 ");

    expect(stored).toHaveLength(34);
    expect(stored.readUInt16BE(0)).toBe(7);
    expect(hasher.verify("ABCD23", stored)).toBe(true);
    expect(hasher.verify("wrong2", stored)).toBe(false);
    expect(stored.subarray(2).equals(createHash("sha256").update("ABCD23").digest())).toBe(false);
  });

  it("reads old versions, writes only the current version, and returns every configured candidate", () => {
    const v1 = Buffer.alloc(32, 0x11);
    const v2 = Buffer.alloc(32, 0x22);
    const oldHasher = new CodeHasher(1, new Map([[1, v1]]));
    const rotatingHasher = new CodeHasher(2, new Map([[2, v2], [1, v1]]));
    const oldStored = oldHasher.hash("ABC234");
    const candidates = rotatingHasher.candidateHashes("ABC234");

    expect(rotatingHasher.verify("ABC234", oldStored)).toBe(true);
    expect(rotatingHasher.hash("ABC234").readUInt16BE(0)).toBe(2);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.readUInt16BE(0))).toEqual([1, 2]);
    expect(candidates.some((candidate) => candidate.equals(oldStored))).toBe(true);
  });

  it("fails closed for unknown stored versions and for a dictionary without the deployment pepper", () => {
    const real = new CodeHasher(1, new Map([[1, Buffer.alloc(32, 0x71)]]));
    const attacker = new CodeHasher(1, new Map([[1, Buffer.alloc(32, 0x72)]]));
    const stored = real.hash("ABC234");
    const unknownVersion = Buffer.from(stored);
    unknownVersion.writeUInt16BE(9, 0);

    expect(attacker.verify("ABC234", stored)).toBe(false);
    expect(real.verify("ABC234", unknownVersion)).toBe(false);
    expect(real.verify("ABC234", Buffer.alloc(33))).toBe(false);
  });

  it("fails closed for invalid versions, missing, short, or repeated peppers", () => {
    const valid = Buffer.alloc(32, 0x33);
    expect(() => new CodeHasher(0, new Map([[1, valid]]))).toThrow("CODE_PEPPER_VERSION_INVALID");
    expect(() => new CodeHasher(1, new Map([[2, valid]]))).toThrow("CODE_PEPPER_NOT_CONFIGURED");
    expect(() => new CodeHasher(1, new Map([[1, Buffer.alloc(31)]])))
      .toThrow("CODE_PEPPER_TOO_SHORT");
    expect(() => new CodeHasher(2, new Map([[1, valid], [2, Buffer.from(valid)]])))
      .toThrow("CODE_PEPPER_DUPLICATE");
  });
});
