import { describe, expect, it } from "vitest";

import { loadServerConfig } from "../src/config.js";

const pepperV1 = Buffer.alloc(32, 0x51).toString("base64url");
const pepperV2 = Buffer.alloc(32, 0x52).toString("base64url");
const base = {
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
