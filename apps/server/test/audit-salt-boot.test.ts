import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";

const ORIGIN = "https://app.learning-orbit.test";
const ROOM_ID = "a0000000-0000-4000-8000-000000000010";
const SALT = Buffer.alloc(32, 0x41).toString("base64url");

const base = {
  DATABASE_URL: "postgres://user:password@localhost/db",
  LO_PUBLIC_BASE_ORIGIN: ORIGIN,
  LO_ALLOWED_ORIGINS: ORIGIN,
  LO_SMTP_HOST: "127.0.0.1",
  LO_SMTP_PORT: "1025",
  LO_SMTP_FROM: "no-reply@learning-orbit.test",
  LO_SERVICE_ASSERTION_TRUST_FILE: "/run/learning-orbit/trust.json",
  ROOM_CODE_PEPPER_CURRENT_VERSION: "1",
  ROOM_CODE_PEPPER_V1: Buffer.alloc(32, 0x51).toString("base64url"),
  LO_AUDIT_SALT: SALT,
} as NodeJS.ProcessEnv;

const sessions = {
  get: async () => null,
  getSessionId: async () => null,
  revoke: async () => undefined,
};

const fakePool = () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  connect: vi.fn(async () => { throw new Error("NO_TRANSACTION_IN_THIS_TEST"); }),
  end: vi.fn(async () => undefined),
  on: vi.fn(),
});

/** Did this app register the teacher-owned lifecycle boundary at all? */
async function deletionRouteStatus(auditSalt: string | undefined): Promise<number> {
  const app = await buildApp({
    pool: fakePool() as never,
    config: {
      allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN,
      ...(auditSalt === undefined ? {} : { auditSalt }),
    },
    sessions: sessions as never,
  });
  try {
    const response = await app.inject({
      method: "DELETE", url: `/v1/rooms/${ROOM_ID}`, headers: { origin: ORIGIN },
    });
    return response.statusCode;
  } finally {
    await app.close();
  }
}

describe("audit salt at boot", () => {
  const previous = process.env.LO_AUDIT_SALT;
  afterEach(() => {
    if (previous === undefined) delete process.env.LO_AUDIT_SALT;
    else process.env.LO_AUDIT_SALT = previous;
  });

  it("refuses a deployment whose audit salt is absent, blank, padded or too short", () => {
    const without = { ...base };
    delete without.LO_AUDIT_SALT;
    expect(() => loadServerConfig(without)).toThrow("LO_AUDIT_SALT_REQUIRED");
    expect(() => loadServerConfig({ ...base, LO_AUDIT_SALT: "" })).toThrow("LO_AUDIT_SALT_REQUIRED");
    expect(() => loadServerConfig({ ...base, LO_AUDIT_SALT: `${SALT}\n` })).toThrow("LO_AUDIT_SALT_INVALID");
    expect(() => loadServerConfig({ ...base, LO_AUDIT_SALT: " " })).toThrow("LO_AUDIT_SALT_INVALID");
    expect(() => loadServerConfig({ ...base, LO_AUDIT_SALT: "a".repeat(31) })).toThrow("LO_AUDIT_SALT_TOO_SHORT");
    expect(loadServerConfig({ ...base, LO_AUDIT_SALT: "a".repeat(32) }).auditSalt).toBe("a".repeat(32));
    expect(loadServerConfig(base).auditSalt).toBe(SALT);
  });

  it("is required without displacing the code an older misconfiguration already reports", () => {
    // The salt is read after every validator that predates it, so a deployment
    // that is also missing something older is still told about that one. Both
    // refuse the boot; only which bounded code comes back differs.
    const without = { ...base };
    delete without.LO_AUDIT_SALT;
    expect(() => loadServerConfig({
      ...without,
      LO_STORAGE_BROWSER_ORIGINS: "http://127.0.0.1:59000",
      LO_STORAGE_ENDPOINT: "http://127.0.0.1:59000",
      LO_STORAGE_BUCKET: "learning-orbit-media",
      LO_STORAGE_ACCESS_KEY_ID: "local-key",
    })).toThrow("LO_STORAGE_TRANSPORT_INCOMPLETE");
    const withoutPepper = { ...without };
    delete withoutPepper.ROOM_CODE_PEPPER_CURRENT_VERSION;
    expect(() => loadServerConfig(withoutPepper)).toThrow("ROOM_CODE_PEPPER_CURRENT_VERSION_REQUIRED");
    // And once those are supplied, the missing salt is what stops the boot.
    expect(() => loadServerConfig(without)).toThrow("LO_AUDIT_SALT_REQUIRED");
  });

  it("keeps governance off the raw environment so a blank value cannot silently disable it", async () => {
    // Before, `process.env.LO_AUDIT_SALT &&` removed the security audit log,
    // the retention scheduler and every governance route at once. The salt is
    // now read once, validated, and carried on the config.
    process.env.LO_AUDIT_SALT = SALT;
    expect(await deletionRouteStatus(undefined)).toBe(404);
    process.env.LO_AUDIT_SALT = "";
    expect(await deletionRouteStatus(SALT)).toBe(401);
  });
});
