import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Which reviewed provider is in force, and the digest of the exact manifest
 * bytes that describe it.
 *
 * Both halves of the agent boundary are scoped by this pair: the health route
 * admits a signed sample only for it, and `AgentService` admits a run only
 * against health recorded for it. Configuring them separately is how they
 * drift, so the scope is read once and handed to both.
 */
export type AgentProviderScope = Readonly<{ providerId: string; manifestSha256: string }>;

/** The manifest is absent, malformed, or not one this deployment may use. */
export class AgentProviderManifestError extends Error {
  constructor(readonly code: string) { super(code); }
}

/**
 * The scope of a deployment that has approved no provider.
 *
 * It matches no manifest that can exist — SHA-256 never produces 64 zeros — so
 * every health sample is refused with `PROVIDER_SCOPE_MISMATCH` and every run
 * request stays `AGENT_SERVICE_UNAVAILABLE`. This is what an unconfigured
 * deployment keeps, and it is deliberately a refusal rather than a default.
 */
export const UNCONFIGURED_PROVIDER_SCOPE: AgentProviderScope = Object.freeze({
  providerId: "fixture",
  manifestSha256: "0".repeat(64),
});

// The closed key set, field shapes and codes below mirror the worker's
// `providers/manifest.py` exactly. The two processes must agree byte-for-byte
// on what a manifest is: a file one accepts and the other does not would put a
// digest in a health sample that the server can never match.
const MANIFEST_KEYS = [
  "schemaVersion", "providerId", "displayName", "modelId", "region",
  "purpose", "maxOutputTokens", "credentialEnvVar", "remoteCopyMode",
] as const;
const TEXT_KEYS = ["displayName", "modelId", "region", "purpose", "credentialEnvVar"] as const;
const REMOTE_COPY_MODES = ["no_persistent_copy_attested", "delete_and_probe"];
const PROVIDER_ID = /^[a-z0-9._-]{1,64}$/;
const MANIFEST_SHA256 = /^[a-f0-9]{64}$/;
const CREDENTIAL_ENV_VAR = /^[A-Z][A-Z0-9_]{2,63}$/;
const MAX_TEXT_LENGTH = 160;
const MAX_OUTPUT_TOKENS = 8192;
// A reviewed manifest is a few hundred bytes. The file is already in memory by
// the time this runs, so the bound is on what gets decoded, hashed and parsed,
// not on what gets read: it keeps a boot from digesting whatever the path
// happens to point at.
const MAX_MANIFEST_BYTES = 65_536;
/**
 * The JSON number literals Python's `json` decodes to `int`, not `float`.
 *
 * `512` and `512.0` are one number in JavaScript, so `Number.isInteger` cannot
 * tell them apart, but `isinstance(tokens, int)` in the worker refuses the
 * second. The literal is what the two readers must agree on.
 */
const INTEGER_TOKEN = /^-?(?:0|[1-9][0-9]*)$/;

/**
 * `JSON.parse` with the reviver's source-text context.
 *
 * ES2023 — the lib this package compiles against — predates it, so the shape
 * is declared here rather than inferred. A runtime that does not supply the
 * context leaves the token source absent, which is refused below: an
 * unverifiable literal is not an integral one.
 */
type SourceReviver = (
  this: object, key: string, value: unknown, context?: { readonly source?: string },
) => unknown;
const parseWithSource = JSON.parse as unknown as (text: string, reviver: SourceReviver) => unknown;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** The parsed manifest, with the raw JSON literal its own `maxOutputTokens` came from. */
interface ManifestDocument {
  readonly document: Record<string, unknown>;
  readonly tokenSource: string | undefined;
}

function manifestDocument(raw: Buffer): ManifestDocument {
  // `ignoreBOM: true` keeps a leading U+FEFF in the decoded text rather than
  // stripping it, so a BOM'd file fails `JSON.parse` here exactly as it fails
  // `json.loads(raw.decode("utf-8"))` in the worker. The default would have
  // accepted a file the worker refuses, and the digest of those bytes would
  // then be one no health sample could ever carry.
  const tokenSources = new Map<object, string>();
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    parsed = parseWithSource(text, function (this: object, key, value, context) {
      // Keyed by the holder, so a nested `maxOutputTokens` cannot stand in for
      // the top-level one.
      if (key === "maxOutputTokens" && typeof context?.source === "string") {
        tokenSources.set(this, context.source);
      }
      return value;
    });
  } catch {
    throw new AgentProviderManifestError("AGENT_PROVIDER_MANIFEST_INVALID");
  }
  if (!isPlainObject(parsed)) throw new AgentProviderManifestError("AGENT_PROVIDER_MANIFEST_INVALID");
  return { document: parsed, tokenSource: tokenSources.get(parsed) };
}

/**
 * The two shapes the assertion layer enforces at request time.
 *
 * Re-checked here so a scope can never reach a consumer in a form
 * `authorizeProviderHealthAssertion` would refuse: a boot that produced one
 * would leave the agent permanently unavailable with nothing said at start-up.
 */
function providerScope(providerId: string, manifestSha256: string): AgentProviderScope {
  if (!PROVIDER_ID.test(providerId) || !MANIFEST_SHA256.test(manifestSha256)) {
    throw new AgentProviderManifestError("AGENT_PROVIDER_MANIFEST_INVALID");
  }
  return Object.freeze({ providerId, manifestSha256 });
}

/** Validate a manifest and bind its provider id to the digest of its exact bytes. */
export function parseAgentProviderManifest(raw: Buffer): AgentProviderScope {
  if (raw.byteLength === 0 || raw.byteLength > MAX_MANIFEST_BYTES) {
    throw new AgentProviderManifestError("AGENT_PROVIDER_MANIFEST_INVALID");
  }
  const manifestSha256 = createHash("sha256").update(raw).digest("hex");
  const { document, tokenSource } = manifestDocument(raw);
  if (Object.keys(document).length !== MANIFEST_KEYS.length
    || MANIFEST_KEYS.some((key) => !Object.hasOwn(document, key))) {
    throw new AgentProviderManifestError("AGENT_PROVIDER_MANIFEST_INVALID");
  }
  if (document.schemaVersion !== 1) throw new AgentProviderManifestError("AGENT_PROVIDER_MANIFEST_VERSION");
  const providerId = document.providerId;
  if (typeof providerId !== "string" || !PROVIDER_ID.test(providerId)) {
    throw new AgentProviderManifestError("AGENT_PROVIDER_MANIFEST_INVALID");
  }
  for (const key of TEXT_KEYS) {
    const value = document[key];
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
      throw new AgentProviderManifestError("AGENT_PROVIDER_MANIFEST_INVALID");
    }
  }
  if (!CREDENTIAL_ENV_VAR.test(document.credentialEnvVar as string)) {
    throw new AgentProviderManifestError("AGENT_PROVIDER_MANIFEST_INVALID");
  }
  // The worker takes `isinstance(tokens, int)`, so `512.0` and `5.12e2` are
  // its floats and are refused there. Checking the literal as well as the
  // value is what keeps the two readers accepting the same files.
  const tokens = document.maxOutputTokens;
  if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < 1 || tokens > MAX_OUTPUT_TOKENS
    || tokenSource === undefined || !INTEGER_TOKEN.test(tokenSource)) {
    throw new AgentProviderManifestError("AGENT_PROVIDER_MANIFEST_INVALID");
  }
  if (typeof document.remoteCopyMode !== "string" || !REMOTE_COPY_MODES.includes(document.remoteCopyMode)) {
    throw new AgentProviderManifestError("AGENT_PROVIDER_MANIFEST_REMOTE_COPY_MODE");
  }
  // A secret in the manifest would be reviewed, committed, and hashed into the
  // digest the server stores. The credential is named by `credentialEnvVar`
  // and never carried, so a long unbroken token in any field is refused rather
  // than loaded: this process must never hold the provider credential at all.
  for (const value of Object.values(document)) {
    if (typeof value === "string" && value.length > 60 && !value.includes(" ")) {
      throw new AgentProviderManifestError("AGENT_PROVIDER_MANIFEST_SECRET_SUSPECTED");
    }
  }
  return providerScope(providerId, manifestSha256);
}

/**
 * Resolve the provider scope from the one path the worker also reads.
 *
 * With `LO_AGENT_PROVIDER_MANIFEST` unset the deployment has approved no
 * provider and keeps the refusing scope. With it set, the manifest is the
 * authority: a malformed file, an unreadable one, or a relative path fails the
 * boot with a bounded code instead of falling back to the refusing scope,
 * because a deployment that meant to run a provider and silently did not is
 * indistinguishable from one that is merely unavailable.
 */
export function loadAgentProviderScope(env: NodeJS.ProcessEnv = process.env): AgentProviderScope {
  const path = env.LO_AGENT_PROVIDER_MANIFEST;
  if (!path) return UNCONFIGURED_PROVIDER_SCOPE;
  if (!isAbsolute(path)) throw new AgentProviderManifestError("AGENT_PROVIDER_MANIFEST_PATH_INVALID");
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    throw new AgentProviderManifestError("AGENT_PROVIDER_MANIFEST_UNREADABLE");
  }
  return parseAgentProviderManifest(raw);
}
