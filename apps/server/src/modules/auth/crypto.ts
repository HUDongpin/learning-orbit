import { createHash, randomBytes } from "node:crypto";

export function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
