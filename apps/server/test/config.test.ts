import { describe, expect, it } from "vitest";

import { loadServerConfig } from "../src/config.js";

const base = {
  DATABASE_URL: "postgres://user:password@localhost/db",
  LO_PUBLIC_BASE_ORIGIN: "https://app.learning-orbit.test",
  LO_ALLOWED_ORIGINS: "https://app.learning-orbit.test",
  LO_SMTP_HOST: "127.0.0.1",
  LO_SMTP_PORT: "1025",
  LO_SMTP_FROM: "no-reply@learning-orbit.test",
  LO_SERVICE_ASSERTION_TRUST_FILE: "/run/learning-orbit/trust.json",
};

describe("server configuration", () => {
  it("reads only its supplied environment and fails closed for missing or malformed security settings", () => {
    expect(loadServerConfig(base)).toMatchObject({ allowedOrigins: ["https://app.learning-orbit.test"], trustedProxyCidrs: [] });
    expect(() => loadServerConfig({ ...base, LO_SMTP_PORT: "not-a-port" })).toThrow("LO_SMTP_CONFIG_REQUIRED");
    expect(() => loadServerConfig({ ...base, LO_TRUSTED_PROXY_CIDRS: "not-cidr" })).toThrow("LO_TRUSTED_PROXY_CIDRS_INVALID");
    expect(() => loadServerConfig({ ...base, LO_SERVICE_ASSERTION_TRUST_FILE: "relative.json" })).toThrow("LO_SERVICE_ASSERTION_TRUST_FILE_REQUIRED");
    expect(() => loadServerConfig({ ...base, LO_ALLOWED_ORIGINS: "" })).toThrow("LO_ALLOWED_ORIGINS_REQUIRED");
  });
});
