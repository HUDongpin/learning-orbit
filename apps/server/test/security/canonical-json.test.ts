import { describe, expect, it } from "vitest";

import { canonicalJson, parseCanonicalJson } from "../../src/modules/security/canonical-json.js";

const text = (value: unknown): string => Buffer.from(canonicalJson(value)).toString("utf8");

describe("canonical JSON", () => {
  it("orders nested object keys by UTF-16 code units without changing array order", () => {
    expect(text({ z: [3, { b: true, a: "雪" }], a: null, "\uD83D\uDE00": 1 })).toBe(
      '{"a":null,"z":[3,{"a":"雪","b":true}],"😀":1}',
    );
  });

  it("accepts only safe integer boundaries", () => {
    expect(text({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER })).toBe(
      '{"max":9007199254740991,"min":-9007199254740991}',
    );
  });

  it.each([
    [undefined], [() => undefined], [1.5], [-0], [Number.NaN], [Number.POSITIVE_INFINITY], [1n], [Buffer.from("x")], [new Date()],
    [new Map()], [new Set()], [Symbol("x")], [Object.create({ inherited: true })], [{ get x() { return 1; } }],
    [Object.defineProperty({ x: 1 }, "hidden", { value: 2, enumerable: false })],
    [Object.defineProperty([], "x", { value: 2, enumerable: false })], [{ "\uD800": "x" }],
  ])("rejects unsupported assertion value %#", (value) => {
    expect(() => canonicalJson(value)).toThrow("CANONICAL_JSON_INVALID");
  });

  it("rejects duplicate decoded keys, malformed input, deep input and oversized input", () => {
    expect(() => parseCanonicalJson('{"a":1,"\\u0061":2}')).toThrow("CANONICAL_JSON_INVALID");
    expect(() => parseCanonicalJson('{"a":')).toThrow("CANONICAL_JSON_INVALID");
    expect(() => parseCanonicalJson(`${"[".repeat(65)}0${"]".repeat(65)}`)).toThrow("CANONICAL_JSON_INVALID");
    expect(() => parseCanonicalJson(`"${"x".repeat(16_385)}"`)).toThrow("CANONICAL_JSON_INVALID");
  });

  it("rejects arrays with custom prototypes or properties and oversized canonical output", () => {
    const customPrototypeArray = [1];
    Object.setPrototypeOf(customPrototypeArray, {});
    expect(() => canonicalJson(customPrototypeArray)).toThrow("CANONICAL_JSON_INVALID");
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, 0, { enumerable: true, get: () => 1 });
    expect(() => canonicalJson(accessorArray)).toThrow("CANONICAL_JSON_INVALID");
    const overLimit = Array.from({ length: 65 }, () => "x".repeat(16_384));
    expect(() => canonicalJson(overLimit)).toThrow("CANONICAL_JSON_INVALID");
  });
});
