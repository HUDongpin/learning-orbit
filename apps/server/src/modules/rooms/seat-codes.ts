import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const VERSION_BYTES = 2;
const DIGEST_BYTES = 32;
const STORED_HASH_BYTES = VERSION_BYTES + DIGEST_BYTES;
const MINIMUM_PEPPER_BYTES = 32;

function code(length: number): string {
  return Array.from(
    { length },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]!,
  ).join("");
}

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1 || version > 65_535) {
    throw new Error("CODE_PEPPER_VERSION_INVALID");
  }
}

export function makeRoomCode(): string {
  return code(6);
}

export function makeSeatCode(): string {
  return code(10);
}

export class CodeHasher {
  readonly #currentVersion: number;
  readonly #peppers: ReadonlyMap<number, Buffer>;
  readonly #versions: readonly number[];

  constructor(currentVersion: number, peppers: ReadonlyMap<number, Buffer>) {
    assertVersion(currentVersion);
    const ownedPeppers = new Map<number, Buffer>();
    const fingerprints = new Set<string>();
    for (const [version, pepper] of peppers) {
      assertVersion(version);
      if (pepper.length < MINIMUM_PEPPER_BYTES) throw new Error("CODE_PEPPER_TOO_SHORT");
      const owned = Buffer.from(pepper);
      const fingerprint = owned.toString("hex");
      if (fingerprints.has(fingerprint)) throw new Error("CODE_PEPPER_DUPLICATE");
      fingerprints.add(fingerprint);
      ownedPeppers.set(version, owned);
    }
    if (!ownedPeppers.has(currentVersion)) throw new Error("CODE_PEPPER_NOT_CONFIGURED");
    this.#currentVersion = currentVersion;
    this.#peppers = ownedPeppers;
    this.#versions = [...ownedPeppers.keys()].sort((left, right) => left - right);
  }

  hash(value: string): Buffer {
    return this.#hashWith(this.#currentVersion, value);
  }

  candidateHashes(value: string): readonly Buffer[] {
    return this.#versions.map((version) => this.#hashWith(version, value));
  }

  verify(value: string, stored: Buffer): boolean {
    if (stored.length !== STORED_HASH_BYTES) return false;
    const version = stored.readUInt16BE(0);
    if (!this.#peppers.has(version)) return false;
    return timingSafeEqual(stored, this.#hashWith(version, value));
  }

  #hashWith(version: number, value: string): Buffer {
    const pepper = this.#peppers.get(version);
    if (!pepper) throw new Error("CODE_PEPPER_NOT_CONFIGURED");
    const versionBytes = Buffer.alloc(VERSION_BYTES);
    versionBytes.writeUInt16BE(version);
    const digest = createHmac("sha256", pepper)
      .update(value.trim().toUpperCase())
      .digest();
    return Buffer.concat([versionBytes, digest]);
  }
}
