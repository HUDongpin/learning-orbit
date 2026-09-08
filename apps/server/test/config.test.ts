import { describe, expect, it } from "vitest";

import { loadServerConfig } from "../src/config.js";

const pepperV1 = Buffer.alloc(32, 0x51).toString("base64url");
const pepperV2 = Buffer.alloc(32, 0x52).toString("base64url");
// A salt is required of every deployment, so a fixture without one describes
// an environment that cannot boot; each case below varies exactly one setting
// and leaves the rest valid.  What the salt itself refuses is pinned in
// `audit-salt-boot.test.ts`.
const auditSalt = Buffer.alloc(32, 0x53).toString("base64url");
const base = {
  LO_AUDIT_SALT: auditSalt,
  DATABASE_URL: "postgres://user:password@localhost/db",
  LO_PUBLIC_BASE_ORIGIN: "https://app.learning-orbit.test",
  LO_ALLOWED_ORIGINS: "https://app.learning-orbit.test",
  LO_STORAGE_BROWSER_ORIGINS: "https://storage.learning-orbit.test",
  LO_SMTP_HOST: "127.0.0.1",
  LO_SMTP_PORT: "1025",
  LO_SMTP_FROM: "no-reply@learning-orbit.test",
  LO_SERVICE_ASSERTION_TRUST_FILE: "/run/learning-orbit/trust.json",
  ROOM_CODE_PEPPER_CURRENT_VERSION: "1",
  ROOM_CODE_PEPPER_V1: pepperV1,
};

describe("server configuration", () => {
  it("reads only its supplied environment and fails closed for missing or malformed security settings", () => {
    expect(loadServerConfig(base)).toMatchObject({
      allowedOrigins: ["https://app.learning-orbit.test"], trustedProxyCidrs: [],
      storageBrowserOrigins: ["https://storage.learning-orbit.test"],
      roomCodePepperCurrentVersion: 1,
    });
    expect(() => loadServerConfig({ ...base, LO_SMTP_PORT: "not-a-port" })).toThrow("LO_SMTP_CONFIG_REQUIRED");
    expect(() => loadServerConfig({ ...base, LO_TRUSTED_PROXY_CIDRS: "not-cidr" })).toThrow("LO_TRUSTED_PROXY_CIDRS_INVALID");
    expect(() => loadServerConfig({ ...base, LO_SERVICE_ASSERTION_TRUST_FILE: "relative.json" })).toThrow("LO_SERVICE_ASSERTION_TRUST_FILE_REQUIRED");
    expect(() => loadServerConfig({ ...base, LO_ALLOWED_ORIGINS: "" })).toThrow("LO_ALLOWED_ORIGINS_REQUIRED");
    expect(() => loadServerConfig({ ...base, LO_STORAGE_BROWSER_ORIGINS: "http://storage.example" }))
      .toThrow("LO_STORAGE_BROWSER_ORIGINS_INVALID");
    expect(() => loadServerConfig({ ...base, LO_STORAGE_BROWSER_ORIGINS: "https://storage.example/path" }))
      .toThrow("LO_STORAGE_BROWSER_ORIGINS_INVALID");
  });

  it("fails closed for missing, malformed, short, duplicate, or unselected room-code peppers", () => {
    const without = (name: keyof typeof base) => {
      const copy: Record<string, string> = { ...base };
      delete copy[name];
      return copy;
    };
    expect(() => loadServerConfig(without("ROOM_CODE_PEPPER_CURRENT_VERSION")))
      .toThrow("ROOM_CODE_PEPPER_CURRENT_VERSION_REQUIRED");
    expect(() => loadServerConfig({ ...base, ROOM_CODE_PEPPER_CURRENT_VERSION: "0" }))
      .toThrow("ROOM_CODE_PEPPER_VERSION_INVALID");
    expect(() => loadServerConfig({ ...base, ROOM_CODE_PEPPER_CURRENT_VERSION: "2" }))
      .toThrow("CODE_PEPPER_NOT_CONFIGURED");
    expect(() => loadServerConfig({ ...base, ROOM_CODE_PEPPER_V1: `${pepperV1}=` }))
      .toThrow("CODE_PEPPER_BASE64URL_INVALID");
    expect(() => loadServerConfig({ ...base, ROOM_CODE_PEPPER_V1: "abc+def" }))
      .toThrow("CODE_PEPPER_BASE64URL_INVALID");
    expect(() => loadServerConfig({ ...base, ROOM_CODE_PEPPER_V1: Buffer.alloc(31).toString("base64url") }))
      .toThrow("CODE_PEPPER_TOO_SHORT");
    expect(() => loadServerConfig({
      ...base, ROOM_CODE_PEPPER_CURRENT_VERSION: "2", ROOM_CODE_PEPPER_V2: pepperV1,
    })).toThrow("CODE_PEPPER_DUPLICATE");
    expect(() => loadServerConfig({ ...base, ROOM_CODE_PEPPER_V0: pepperV2 }))
      .toThrow("CODE_PEPPER_VERSION_INVALID");
  });

  it("loads all configured old-read/new-write versions", () => {
    const config = loadServerConfig({
      ...base, ROOM_CODE_PEPPER_CURRENT_VERSION: "2", ROOM_CODE_PEPPER_V2: pepperV2,
    });
    expect(config.roomCodePepperCurrentVersion).toBe(2);
    expect([...config.roomCodePeppers.keys()]).toEqual([1, 2]);
  });
});

describe("object store configuration", () => {
  const base = {
    LO_AUDIT_SALT: auditSalt,
    LO_PUBLIC_BASE_ORIGIN: "https://app.learning-orbit.test",
    LO_ALLOWED_ORIGINS: "https://app.learning-orbit.test",
    DATABASE_URL: "postgres://user:pass@127.0.0.1:55432/db",
    LO_SMTP_HOST: "127.0.0.1",
    LO_SMTP_PORT: "1025",
    LO_SMTP_FROM: "no-reply@learning-orbit.local",
    LO_SERVICE_ASSERTION_TRUST_FILE: "/run/learning-orbit/trust.json",
    ROOM_CODE_PEPPER_CURRENT_VERSION: "1",
    ROOM_CODE_PEPPER_V1: Buffer.alloc(32, 7).toString("base64url"),
  } as NodeJS.ProcessEnv;
  const transport = {
    LO_STORAGE_BROWSER_ORIGINS: "http://127.0.0.1:59000",
    LO_STORAGE_ENDPOINT: "http://127.0.0.1:59000",
    LO_STORAGE_BUCKET: "learning-orbit-media",
    LO_STORAGE_ACCESS_KEY_ID: "local-key",
    LO_STORAGE_SECRET_ACCESS_KEY: "local-secret",
  } as NodeJS.ProcessEnv;

  it("treats an absent store as the documented no-provider boundary", () => {
    // Media routes then answer a stable 503 and write nothing; refusing to
    // start would make the boundary unusable rather than fail-closed.
    expect(loadServerConfig({ ...base }).storage).toBeUndefined();
    expect(loadServerConfig({
      ...base,
      LO_STORAGE_BROWSER_ORIGINS: "http://127.0.0.1:59000",
    }).storage).toBeUndefined();
  });

  it("accepts a complete transport and keeps its secret out of the browser allowlist", () => {
    const config = loadServerConfig({ ...base, ...transport });
    expect(config.storage).toEqual({
      endpoint: "http://127.0.0.1:59000",
      bucket: "learning-orbit-media",
      region: "us-east-1",
      accessKeyId: "local-key",
      secretAccessKey: "local-secret",
    });
    expect(config.storageBrowserOrigins).toEqual(["http://127.0.0.1:59000"]);
  });

  it("refuses a half-supplied or unreachable transport", () => {
    for (const missing of [
      "LO_STORAGE_ENDPOINT", "LO_STORAGE_BUCKET",
      "LO_STORAGE_ACCESS_KEY_ID", "LO_STORAGE_SECRET_ACCESS_KEY",
    ]) {
      expect(() => loadServerConfig({ ...base, ...transport, [missing]: "" }))
        .toThrow("LO_STORAGE_TRANSPORT_INCOMPLETE");
    }
    expect(() => loadServerConfig({ ...base, ...transport, LO_STORAGE_BROWSER_ORIGINS: "" }))
      .toThrow("LO_STORAGE_BROWSER_ORIGINS_REQUIRED");
    expect(() => loadServerConfig({ ...base, ...transport, LO_STORAGE_ENDPOINT: "http://127.0.0.1:59000/bucket" }))
      .toThrow("LO_STORAGE_ENDPOINT_INVALID");
    expect(() => loadServerConfig({ ...base, ...transport, LO_STORAGE_BUCKET: "Media" }))
      .toThrow("LO_STORAGE_BUCKET_INVALID");
    expect(() => loadServerConfig({ ...base, ...transport, LO_STORAGE_REGION: "US East" }))
      .toThrow("LO_STORAGE_REGION_INVALID");
  });
});
