import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { canonicalJson } from "../../src/modules/security/canonical-json.js";

export type FixtureAssertion = Readonly<{
  raw: string;
  envelope: Readonly<Record<string, string>>;
}>;

export class ServiceAssertionFixtureIssuer {
  readonly issuer = "learning-orbit-test-worker";
  readonly keyId = "test-ed25519-1";

  readonly #privateKey: KeyObject;
  readonly publicKeyPem: string;

  constructor() {
    const pair = generateKeyPairSync("ed25519");
    this.#privateKey = pair.privateKey;
    this.publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  }

  sign(input: Readonly<{
    subject: string;
    audience: string;
    body: unknown;
    now: Date;
    lifetimeSeconds?: number;
    issuer?: string;
    keyId?: string;
  }>): FixtureAssertion {
    const lifetimeSeconds = input.lifetimeSeconds ?? 60;
    const issuedAt = input.now.toISOString();
    const expiresAt = new Date(input.now.getTime() + (lifetimeSeconds * 1_000)).toISOString();
    const protectedFields = {
      alg: "Ed25519",
      keyId: input.keyId ?? this.keyId,
      issuer: input.issuer ?? this.issuer,
      subject: input.subject,
      audience: input.audience,
      issuedAt,
      expiresAt,
      bodySha256: "",
    };
    protectedFields.bodySha256 = createHash("sha256").update(canonicalJson(input.body)).digest("hex");
    const signature = sign(null, canonicalJson(protectedFields), this.#privateKey).toString("base64url");
    const envelope = { ...protectedFields, signature };
    return {
      raw: Buffer.from(canonicalJson(envelope)).toString("base64url"),
      envelope,
    };
  }
}
