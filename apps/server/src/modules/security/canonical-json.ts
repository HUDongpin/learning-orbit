const MAX_INPUT_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_DEPTH = 64;
const MAX_NODES = 10_000;
const MAX_STRING_LENGTH = 16_384;

export type CanonicalJsonValue =
  | null
  | boolean
  | string
  | number
  | CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function invalid(): never {
  throw new Error("CANONICAL_JSON_INVALID");
}

function assertWellFormedString(value: string): void {
  if (value.length > MAX_STRING_LENGTH) invalid();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      invalid();
    }
  }
}

function assertCanonicalValue(value: unknown, stack: Set<object>, depth: number, state: { nodes: number }): asserts value is CanonicalJsonValue {
  if (depth > MAX_DEPTH || ++state.nodes > MAX_NODES) invalid();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertWellFormedString(value);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid();
    return;
  }
  if (typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) invalid();
  if (stack.has(value)) invalid();
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) invalid();
      if (Object.getOwnPropertySymbols(value).length !== 0) invalid();
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1 || !names.includes("length")) invalid();
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
        assertCanonicalValue(descriptor.value, stack, depth + 1, state);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    if (Object.getOwnPropertySymbols(value).length !== 0) invalid();
    for (const key of Object.getOwnPropertyNames(value)) {
      assertWellFormedString(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
      assertCanonicalValue(descriptor.value, stack, depth + 1, state);
    }
  } finally {
    stack.delete(value);
  }
}

function encodeString(value: string): string {
  assertWellFormedString(value);
  return JSON.stringify(value);
}

function serialize(value: CanonicalJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return encodeString(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${encodeString(key)}:${serialize(value[key]!)}`).join(",")}}`;
}

function assertOutputWithinLimit(value: CanonicalJsonValue): void {
  let total = 0;
  const add = (text: string): void => {
    total += Buffer.byteLength(text, "utf8");
    if (total > MAX_OUTPUT_BYTES) invalid();
  };
  const visit = (current: CanonicalJsonValue): void => {
    if (current === null) return add("null");
    if (typeof current === "boolean") return add(current ? "true" : "false");
    if (typeof current === "string") return add(encodeString(current));
    if (typeof current === "number") return add(String(current));
    if (Array.isArray(current)) {
      add("[");
      current.forEach((item, index) => {
        if (index > 0) add(",");
        visit(item);
      });
      return add("]");
    }
    add("{");
    Object.keys(current).sort().forEach((key, index) => {
      if (index > 0) add(",");
      add(encodeString(key));
      add(":");
      visit(current[key]!);
    });
    add("}");
  };
  visit(value);
}

export function canonicalJson(value: unknown): Uint8Array {
  try {
    assertCanonicalValue(value, new Set(), 0, { nodes: 0 });
    assertOutputWithinLimit(value);
    const encoded = Buffer.from(serialize(value), "utf8");
    return encoded;
  } catch {
    return invalid();
  }
}

class JsonParser {
  #index = 0;
  #nodes = 0;
  readonly #input: string;

  constructor(input: string) {
    this.#input = input;
    if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) invalid();
  }

  parse(): CanonicalJsonValue {
    this.skipWhitespace();
    const value = this.value(0);
    this.skipWhitespace();
    if (this.#index !== this.#input.length) invalid();
    return value;
  }

  private value(depth: number): CanonicalJsonValue {
    if (depth > MAX_DEPTH || ++this.#nodes > MAX_NODES) invalid();
    const next = this.#input[this.#index];
    if (next === "{") return this.object(depth + 1);
    if (next === "[") return this.array(depth + 1);
    if (next === '"') return this.string();
    if (next === "t" && this.take("true")) return true;
    if (next === "f" && this.take("false")) return false;
    if (next === "n" && this.take("null")) return null;
    if (next === "-" || (next !== undefined && next >= "0" && next <= "9")) return this.integer();
    return invalid();
  }

  private object(depth: number): { readonly [key: string]: CanonicalJsonValue } {
    this.#index += 1;
    this.skipWhitespace();
    const result: Record<string, CanonicalJsonValue> = {};
    const keys = new Set<string>();
    if (this.#input[this.#index] === "}") {
      this.#index += 1;
      return result;
    }
    while (true) {
      if (this.#input[this.#index] !== '"') invalid();
      const key = this.string();
      if (keys.has(key)) invalid();
      keys.add(key);
      this.skipWhitespace();
      if (this.#input[this.#index] !== ":") invalid();
      this.#index += 1;
      this.skipWhitespace();
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: this.value(depth),
        writable: true,
      });
      this.skipWhitespace();
      const delimiter = this.#input[this.#index];
      if (delimiter === "}") {
        this.#index += 1;
        return result;
      }
      if (delimiter !== ",") invalid();
      this.#index += 1;
      this.skipWhitespace();
    }
  }

  private array(depth: number): CanonicalJsonValue[] {
    this.#index += 1;
    this.skipWhitespace();
    const result: CanonicalJsonValue[] = [];
    if (this.#input[this.#index] === "]") {
      this.#index += 1;
      return result;
    }
    while (true) {
      result.push(this.value(depth));
      this.skipWhitespace();
      const delimiter = this.#input[this.#index];
      if (delimiter === "]") {
        this.#index += 1;
        return result;
      }
      if (delimiter !== ",") invalid();
      this.#index += 1;
      this.skipWhitespace();
    }
  }

  private string(): string {
    this.#index += 1;
    let result = "";
    while (this.#index < this.#input.length) {
      const current = this.#input[this.#index++]!;
      if (current === '"') {
        assertWellFormedString(result);
        return result;
      }
      if (current === "\\") {
        const escaped = this.#input[this.#index++];
        const simple = escaped === '"' || escaped === "\\" || escaped === "/" ? escaped : undefined;
        if (simple !== undefined) {
          result += simple;
        } else if (escaped === "b") result += "\b";
        else if (escaped === "f") result += "\f";
        else if (escaped === "n") result += "\n";
        else if (escaped === "r") result += "\r";
        else if (escaped === "t") result += "\t";
        else if (escaped === "u") result += this.hexCodeUnit();
        else invalid();
      } else {
        if (current.charCodeAt(0) <= 0x1f) invalid();
        result += current;
      }
      if (result.length > MAX_STRING_LENGTH) invalid();
    }
    return invalid();
  }

  private hexCodeUnit(): string {
    const hex = this.#input.slice(this.#index, this.#index + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) invalid();
    this.#index += 4;
    return String.fromCharCode(Number.parseInt(hex, 16));
  }

  private integer(): number {
    const start = this.#index;
    if (this.#input[this.#index] === "-") this.#index += 1;
    const first = this.#input[this.#index];
    if (first === "0") this.#index += 1;
    else if (first !== undefined && first >= "1" && first <= "9") {
      this.#index += 1;
      while (/^[0-9]$/.test(this.#input[this.#index] ?? "")) this.#index += 1;
    } else invalid();
    if (this.#input[this.#index] === "." || this.#input[this.#index] === "e" || this.#input[this.#index] === "E") invalid();
    const parsed = Number(this.#input.slice(start, this.#index));
    if (!Number.isSafeInteger(parsed) || Object.is(parsed, -0)) invalid();
    return parsed;
  }

  private take(value: string): boolean {
    if (this.#input.slice(this.#index, this.#index + value.length) !== value) return false;
    this.#index += value.length;
    return true;
  }

  private skipWhitespace(): void {
    while (/^[ \t\r\n]$/.test(this.#input[this.#index] ?? "")) this.#index += 1;
  }
}

export function parseCanonicalJson(input: string | Uint8Array): CanonicalJsonValue {
  let text: string;
  try {
    text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return invalid();
  }
  return new JsonParser(text).parse();
}
