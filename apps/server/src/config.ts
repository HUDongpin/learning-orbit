import { isIP } from "node:net";
import { isAbsolute } from "node:path";

export interface ServerConfig {
  databaseUrl?: string | undefined;
  publicBaseOrigin: string;
  allowedOrigins: readonly string[];
  trustedProxyCidrs: readonly string[];
  trustProxy: false | readonly string[];
  smtpHost?: string | undefined;
  smtpPort?: number | undefined;
  smtpFrom?: string | undefined;
  serviceAssertionTrustFile?: string | undefined;
  workerAssertionPrivateKeyFile?: string | undefined;
}

function csv(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function origin(value: string, code: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.origin !== value || !["http:", "https:"].includes(parsed.protocol)) throw new Error();
    return parsed.origin;
  } catch { throw new Error(code); }
}

function cidr(value: string): string {
  const [address, length, ...rest] = value.split("/");
  const family = address ? isIP(address) : 0;
  if (rest.length || !address || !length || !/^\d{1,3}$/.test(length)) throw new Error("LO_TRUSTED_PROXY_CIDRS_INVALID");
  const prefix = Number(length);
  if (!family || prefix < 0 || prefix > (family === 4 ? 32 : 128)) throw new Error("LO_TRUSTED_PROXY_CIDRS_INVALID");
  return value;
}

function externalPath(value: string | undefined, code: string, required = false): string | undefined {
  if (!value) {
    if (required) throw new Error(code);
    return undefined;
  }
  if (!isAbsolute(value)) throw new Error(code);
  return value;
}

export function loadServerConfig(env = process.env): ServerConfig {
  const publicBaseOrigin = origin(env.LO_PUBLIC_BASE_ORIGIN ?? "", "LO_PUBLIC_BASE_ORIGIN_REQUIRED");
  const allowedOrigins = csv(env, "LO_ALLOWED_ORIGINS").map((value) => origin(value, "LO_ALLOWED_ORIGINS_INVALID"));
  if (!allowedOrigins.length) throw new Error("LO_ALLOWED_ORIGINS_REQUIRED");
  const trustedProxyCidrs = csv(env, "LO_TRUSTED_PROXY_CIDRS").map(cidr);
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
  const smtpHost = env.LO_SMTP_HOST;
  const smtpPortText = env.LO_SMTP_PORT;
  const smtpPort = smtpPortText ? Number(smtpPortText) : NaN;
  const smtpFrom = env.LO_SMTP_FROM;
  if (!smtpHost || !Number.isSafeInteger(smtpPort) || smtpPort < 1 || smtpPort > 65_535 || !smtpFrom) throw new Error("LO_SMTP_CONFIG_REQUIRED");
  const serviceAssertionTrustFile = externalPath(env.LO_SERVICE_ASSERTION_TRUST_FILE, "LO_SERVICE_ASSERTION_TRUST_FILE_REQUIRED", true);
  const workerAssertionPrivateKeyFile = externalPath(env.LO_WORKER_ASSERTION_PRIVATE_KEY_FILE, "LO_WORKER_ASSERTION_PRIVATE_KEY_FILE_INVALID");
  return {
    databaseUrl, publicBaseOrigin, allowedOrigins, trustedProxyCidrs,
    trustProxy: trustedProxyCidrs.length ? trustedProxyCidrs : false,
    smtpHost, smtpPort, smtpFrom, serviceAssertionTrustFile, workerAssertionPrivateKeyFile,
  };
}

export function testServerConfig(override: Partial<ServerConfig> = {}): ServerConfig {
  const allowedOrigins = override.allowedOrigins ?? ["https://app.learning-orbit.test"];
  const publicBaseOrigin = override.publicBaseOrigin ?? allowedOrigins[0]!;
  const trustedProxyCidrs = override.trustedProxyCidrs ?? [];
  const trustProxy = override.trustProxy ?? (trustedProxyCidrs.length ? trustedProxyCidrs : false);
  return { ...override, publicBaseOrigin, allowedOrigins, trustedProxyCidrs, trustProxy };
}
