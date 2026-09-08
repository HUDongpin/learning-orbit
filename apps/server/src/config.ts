import { isIP } from "node:net";
import { isAbsolute } from "node:path";

import type { AgentProviderScope } from "./modules/agent/provider-manifest.js";
import { UNCONFIGURED_PROVIDER_SCOPE, loadAgentProviderScope } from "./modules/agent/provider-manifest.js";

export interface ServerConfig {
  databaseUrl?: string | undefined;
  publicBaseOrigin: string;
  allowedOrigins: readonly string[];
  storageBrowserOrigins: readonly string[];
  trustedProxyCidrs: readonly string[];
  trustProxy: false | readonly string[];
  smtpHost?: string | undefined;
  smtpPort?: number | undefined;
  smtpFrom?: string | undefined;
  serviceAssertionTrustFile?: string | undefined;
  workerAssertionPrivateKeyFile?: string | undefined;
  /**
   * Salt for every hashed room reference in the audit trail, the retention
   * sweep and the governance routes.  Optional on the type only so a test or
   * the pilot harness can inject one explicitly; `loadServerConfig` requires
   * it, so a deployed process never reaches here without one.
   */
  auditSalt?: string | undefined;
  roomCodePepperCurrentVersion?: number | undefined;
  roomCodePeppers?: ReadonlyMap<number, Buffer> | undefined;
  storage?: StorageTransportConfig | undefined;
  /**
   * The one reviewed provider this deployment may run, bound to the digest of
   * the exact manifest bytes the worker also reads.
   *
   * It lives on the config so it is read from the environment this function
   * was handed, not from `process.env` half-way through `buildApp`: the boot
   * stays injectable, and a test can hand in a scope without writing to the
   * process.  `UNCONFIGURED_PROVIDER_SCOPE` — the value nothing can match —
   * is what an unconfigured deployment keeps, so the agent is unavailable
   * rather than scoped to a provider nobody approved.
   */
  agentProviderScope: AgentProviderScope;
  /** Deployment name attached to spans; never a hostname or a room identifier. */
  environment: string;
  /**
   * OTLP/HTTP base origin of the approved collector.  Absent means telemetry
   * is collected in-process and exported nowhere, which is supported: a
   * missing collector must never block a classroom write.
   */
  otlpEndpoint?: string | undefined;
}

/** Server-side credentials for the private object store. Never sent to a browser. */
export interface StorageTransportConfig {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
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

function storageBrowserOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
    if (parsed.origin !== value || parsed.username || parsed.password
      || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))) throw new Error();
    return parsed.origin;
  } catch { throw new Error("LO_STORAGE_BROWSER_ORIGINS_INVALID"); }
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

function roomCodePepperConfig(env: NodeJS.ProcessEnv): {
  roomCodePepperCurrentVersion: number;
  roomCodePeppers: ReadonlyMap<number, Buffer>;
} {
  const currentText = env.ROOM_CODE_PEPPER_CURRENT_VERSION;
  if (!currentText) throw new Error("ROOM_CODE_PEPPER_CURRENT_VERSION_REQUIRED");
  if (!/^[1-9][0-9]{0,4}$/.test(currentText)) {
    throw new Error("ROOM_CODE_PEPPER_VERSION_INVALID");
  }
  const currentVersion = Number(currentText);
  if (currentVersion > 65_535) throw new Error("ROOM_CODE_PEPPER_VERSION_INVALID");

  const prefix = "ROOM_CODE_PEPPER_V";
  const peppers = new Map<number, Buffer>();
  const fingerprints = new Set<string>();
  const configured = Object.entries(env)
    .filter(([name]) => name.startsWith(prefix))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [name, encoded] of configured) {
    const versionText = name.slice(prefix.length);
    if (!/^[1-9][0-9]{0,4}$/.test(versionText)) {
      throw new Error("CODE_PEPPER_VERSION_INVALID");
    }
    const version = Number(versionText);
    if (version > 65_535) throw new Error("CODE_PEPPER_VERSION_INVALID");
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
      throw new Error("CODE_PEPPER_BASE64URL_INVALID");
    }
    const pepper = Buffer.from(encoded, "base64url");
    if (pepper.toString("base64url") !== encoded) {
      throw new Error("CODE_PEPPER_BASE64URL_INVALID");
    }
    if (pepper.length < 32) throw new Error("CODE_PEPPER_TOO_SHORT");
    const fingerprint = pepper.toString("hex");
    if (fingerprints.has(fingerprint)) throw new Error("CODE_PEPPER_DUPLICATE");
    fingerprints.add(fingerprint);
    peppers.set(version, pepper);
  }
  if (!peppers.has(currentVersion)) throw new Error("CODE_PEPPER_NOT_CONFIGURED");
  return { roomCodePepperCurrentVersion: currentVersion, roomCodePeppers: peppers };
}

/** 32 characters: the 43 a 32-byte base64url secret produces, with margin. */
const AUDIT_SALT_MIN_LENGTH = 32;

/**
 * Read the salt that makes the audit trail content-free.
 *
 * It is not an optional feature flag.  A blank value used to remove the
 * security audit log, the retention scheduler and every governance route at
 * once, silently, leaving a deployment that looked healthy and kept classroom
 * data forever with no record of who read what.  A deployment without a usable
 * salt refuses to start instead.
 */
function auditSalt(env: NodeJS.ProcessEnv): string {
  const value = env.LO_AUDIT_SALT ?? "";
  if (!value) throw new Error("LO_AUDIT_SALT_REQUIRED");
  if (value.trim() !== value) throw new Error("LO_AUDIT_SALT_INVALID");
  if (value.length < AUDIT_SALT_MIN_LENGTH) throw new Error("LO_AUDIT_SALT_TOO_SHORT");
  return value;
}

/**
 * Read the object-store credentials, if any.
 *
 * Absent credentials are a supported state: the media routes then answer a
 * stable 503 and write nothing, which is the documented no-provider boundary.
 * A *partly* supplied transport is not, because it is always a mistake, and a
 * transport the browser could never reach is refused for the same reason.
 */
function storageTransportConfig(
  env: NodeJS.ProcessEnv,
  browserOriginsConfigured: boolean,
): StorageTransportConfig | undefined {
  const endpoint = env.LO_STORAGE_ENDPOINT ?? "";
  const bucket = env.LO_STORAGE_BUCKET ?? "";
  const accessKeyId = env.LO_STORAGE_ACCESS_KEY_ID ?? "";
  const secretAccessKey = env.LO_STORAGE_SECRET_ACCESS_KEY ?? "";
  const region = env.LO_STORAGE_REGION ?? "us-east-1";
  const provided = [endpoint, bucket, accessKeyId, secretAccessKey].filter(Boolean).length;
  if (provided === 0) return undefined;
  if (provided !== 4) throw new Error("LO_STORAGE_TRANSPORT_INCOMPLETE");
  if (!browserOriginsConfigured) throw new Error("LO_STORAGE_BROWSER_ORIGINS_REQUIRED");
  const parsed = origin(endpoint, "LO_STORAGE_ENDPOINT_INVALID");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("LO_STORAGE_BUCKET_INVALID");
  if (!/^[a-z0-9-]{1,32}$/.test(region)) throw new Error("LO_STORAGE_REGION_INVALID");
  return Object.freeze({ endpoint: parsed, bucket, region, accessKeyId, secretAccessKey });
}

export function loadServerConfig(env = process.env): ServerConfig {
  const publicBaseOrigin = origin(env.LO_PUBLIC_BASE_ORIGIN ?? "", "LO_PUBLIC_BASE_ORIGIN_REQUIRED");
  const allowedOrigins = csv(env, "LO_ALLOWED_ORIGINS").map((value) => origin(value, "LO_ALLOWED_ORIGINS_INVALID"));
  if (!allowedOrigins.length) throw new Error("LO_ALLOWED_ORIGINS_REQUIRED");
  const storageBrowserOrigins = csv(env, "LO_STORAGE_BROWSER_ORIGINS").map(storageBrowserOrigin);
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
  const pepperConfig = roomCodePepperConfig(env);
  const storage = storageTransportConfig(env, storageBrowserOrigins.length > 0);
  const environment = env.LO_ENVIRONMENT ?? "development";
  if (!/^[a-z0-9_-]{1,32}$/.test(environment)) throw new Error("LO_ENVIRONMENT_INVALID");
  const otlpEndpoint = env.LO_OTLP_ENDPOINT ? origin(env.LO_OTLP_ENDPOINT, "LO_OTLP_ENDPOINT_INVALID") : undefined;
  const agentProviderScope = loadAgentProviderScope(env);
  // Read last, and deliberately so.  The salt is a requirement this loader
  // grew after every validator above it, and checking it first replaced the
  // bounded code each of those already reports — a deployment missing its
  // object-store transport was told its audit salt was missing instead.  It
  // is no less required here: nothing below can reach the return without one.
  const configuredAuditSalt = auditSalt(env);
  return {
    environment,
    agentProviderScope,
    ...(otlpEndpoint ? { otlpEndpoint } : {}),
    ...(storage ? { storage } : {}),
    databaseUrl, publicBaseOrigin, allowedOrigins, storageBrowserOrigins, trustedProxyCidrs,
    trustProxy: trustedProxyCidrs.length ? trustedProxyCidrs : false,
    smtpHost, smtpPort, smtpFrom, serviceAssertionTrustFile, workerAssertionPrivateKeyFile,
    auditSalt: configuredAuditSalt,
    ...pepperConfig,
  };
}

export function testServerConfig(override: Partial<ServerConfig> = {}): ServerConfig {
  const allowedOrigins = override.allowedOrigins ?? ["https://app.learning-orbit.test"];
  const storageBrowserOrigins = override.storageBrowserOrigins ?? [];
  const publicBaseOrigin = override.publicBaseOrigin ?? allowedOrigins[0]!;
  const trustedProxyCidrs = override.trustedProxyCidrs ?? [];
  const trustProxy = override.trustProxy ?? (trustedProxyCidrs.length ? trustedProxyCidrs : false);
  const environment = override.environment ?? "test";
  // No manifest was handed in, so no provider was approved: the refusing scope
  // is the default, never one read from the ambient process.
  const agentProviderScope = override.agentProviderScope ?? UNCONFIGURED_PROVIDER_SCOPE;
  return {
    ...override, environment, agentProviderScope,
    publicBaseOrigin, allowedOrigins, storageBrowserOrigins, trustedProxyCidrs, trustProxy,
  };
}
