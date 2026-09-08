import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@learning-orbit/contracts";
import { buildApp } from "../../src/app.js";
import { loadServerConfig, testServerConfig } from "../../src/config.js";
import { AgentError, AgentService } from "../../src/modules/agent/agent-service.js";
import {
  UNCONFIGURED_PROVIDER_SCOPE,
  loadAgentProviderScope,
  parseAgentProviderManifest,
} from "../../src/modules/agent/provider-manifest.js";

const ORIGIN = "https://app.learning-orbit.test";
const ROOM_ID = "a0000000-0000-4000-8000-000000000010";
const MEMBER_ID = "00000000-0000-4000-8000-000000000011";
const ACTOR_ID = "00000000-0000-4000-8000-000000000012";
const NOVA_ID = "00000000-0000-4000-8000-000000000013";
const SESSION_ID = "00000000-0000-4000-8000-000000000014";
const EVENT_ID = "00000000-0000-4000-8000-000000000015";
const HEALTH_PATH = "/internal/agent/provider-health";

// The same reviewed shape the worker's own manifest test uses; the two parsers
// must agree on every byte or the digest in a health sample is unmatchable.
const MANIFEST = {
  schemaVersion: 1,
  providerId: "fixture-socratic-v1",
  displayName: "Fixture Socratic Provider",
  modelId: "fixture-model",
  region: "local",
  purpose: "socratic facilitation for a controlled classroom pilot",
  maxOutputTokens: 512,
  credentialEnvVar: "LO_AGENT_PROVIDER_KEY",
  remoteCopyMode: "no_persistent_copy_attested",
};

const raw = (overrides: Record<string, unknown> = {}): Buffer =>
  Buffer.from(JSON.stringify({ ...MANIFEST, ...overrides }), "utf8");

/**
 * The same document with one field written as a verbatim JSON literal.
 *
 * `JSON.stringify(512.0)` is `512`, so a float token can only be produced by
 * writing the bytes: the divergence being pinned lives in the literal, not in
 * the JavaScript value it parses to.
 */
const rawToken = (field: keyof typeof MANIFEST, token: string): Buffer => Buffer.from(
  `{${Object.entries(MANIFEST)
    .map(([name, value]) => `${JSON.stringify(name)}:${name === field ? token : JSON.stringify(value)}`)
    .join(",")}}`,
  "utf8",
);

/** A minimally valid deployment environment; the manifest path is what varies. */
const bootEnv = {
  DATABASE_URL: "postgres://user:password@localhost/db",
  LO_PUBLIC_BASE_ORIGIN: ORIGIN,
  LO_ALLOWED_ORIGINS: ORIGIN,
  LO_SMTP_HOST: "127.0.0.1",
  LO_SMTP_PORT: "1025",
  LO_SMTP_FROM: "no-reply@learning-orbit.test",
  LO_SERVICE_ASSERTION_TRUST_FILE: "/run/learning-orbit/trust.json",
  ROOM_CODE_PEPPER_CURRENT_VERSION: "1",
  ROOM_CODE_PEPPER_V1: Buffer.alloc(32, 0x51).toString("base64url"),
  LO_AUDIT_SALT: Buffer.alloc(32, 0x53).toString("base64url"),
} as NodeJS.ProcessEnv;

const student: Extract<AuthSession, { role: "student" }> = {
  role: "student",
  roomId: ROOM_ID,
  roomMemberId: MEMBER_ID,
  actorId: ACTOR_ID,
  pseudonym: "探索者 A",
  nova: {
    actorId: NOVA_ID,
    actorKind: "agent",
    actorRole: "socratic_facilitator",
    displayName: "Nova Agent",
  },
};
const sessions = {
  get: async () => student,
  getSessionId: async () => SESSION_ID,
  revoke: async () => undefined,
};

/** A pool that answers the reads this boundary makes and never opens a transaction. */
function recordingPool() {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("FROM room_member m JOIN auth_session")) {
        return { rows: [{ room_member_id: MEMBER_ID, actor_id: ACTOR_ID, deletion_active: false }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    connect: vi.fn(async () => { throw new Error("NO_TRANSACTION_IN_THIS_TEST"); }),
    end: vi.fn(async () => undefined),
    on: vi.fn(),
  };
  return { pool, calls };
}

describe("agent provider scope at boot", () => {
  let directory: string;
  let manifestPath: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "lo-provider-manifest-"));
    manifestPath = join(directory, "provider-manifest.json");
    writeFileSync(manifestPath, raw());
  });
  afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

  it("keeps the refusing scope when no provider manifest is configured", async () => {
    expect(loadAgentProviderScope({})).toEqual({ providerId: "fixture", manifestSha256: "0".repeat(64) });
    expect(loadAgentProviderScope({ LO_AGENT_PROVIDER_MANIFEST: "" })).toEqual(UNCONFIGURED_PROVIDER_SCOPE);
    // Both the loaded and the injected config default to it, so neither a
    // deployment nor a test can reach a consumer with no scope at all.
    expect(loadServerConfig(bootEnv).agentProviderScope).toEqual(UNCONFIGURED_PROVIDER_SCOPE);
    expect(testServerConfig().agentProviderScope).toEqual(UNCONFIGURED_PROVIDER_SCOPE);

    // An unconfigured deployment admits nothing: the health row it looks for
    // is scoped to a digest no real manifest can produce.
    const { pool } = recordingPool();
    const health = { current: vi.fn(async () => "unavailable" as const) };
    const service = new AgentService(
      pool as never,
      { now: () => new Date("2026-08-31T06:00:00.000Z") },
      health as never,
      loadAgentProviderScope({}),
    );
    vi.spyOn(service.repository, "getOrCreateRunAndJob").mockImplementation(async (input) => {
      await input.beforeCreate?.({ query: pool.query } as never);
      throw new Error("CREATE_GATE_DID_NOT_CLOSE");
    });
    await expect(service.request(student, SESSION_ID, ROOM_ID, EVENT_ID))
      .rejects.toEqual(new AgentError("AGENT_SERVICE_UNAVAILABLE"));
    expect(health.current).toHaveBeenCalledWith("fixture", "0".repeat(64), expect.anything(), true);
  });

  it("binds a reviewed manifest to the digest of its exact bytes", () => {
    const document = raw();
    expect(parseAgentProviderManifest(document)).toEqual({
      providerId: "fixture-socratic-v1",
      manifestSha256: createHash("sha256").update(document).digest("hex"),
    });
    // A byte that changes anything changes the digest the server stores.
    expect(parseAgentProviderManifest(raw({ region: "eu" })).manifestSha256)
      .not.toBe(parseAgentProviderManifest(document).manifestSha256);
    expect(loadAgentProviderScope({ LO_AGENT_PROVIDER_MANIFEST: manifestPath }))
      .toEqual(parseAgentProviderManifest(document));
  });

  it("refuses a manifest that is not closed and well formed", () => {
    for (const [document, code] of [
      [Buffer.from("not json", "utf8"), "AGENT_PROVIDER_MANIFEST_INVALID"],
      [Buffer.from("[]", "utf8"), "AGENT_PROVIDER_MANIFEST_INVALID"],
      [Buffer.from("", "utf8"), "AGENT_PROVIDER_MANIFEST_INVALID"],
      [Buffer.from([0x7b, 0xff, 0x7d]), "AGENT_PROVIDER_MANIFEST_INVALID"],
      [raw({ schemaVersion: 2 }), "AGENT_PROVIDER_MANIFEST_VERSION"],
      [raw({ extra: 1 }), "AGENT_PROVIDER_MANIFEST_INVALID"],
      [raw({ providerId: "Fixture Provider" }), "AGENT_PROVIDER_MANIFEST_INVALID"],
      [raw({ credentialEnvVar: "lowercase_var" }), "AGENT_PROVIDER_MANIFEST_INVALID"],
      [raw({ maxOutputTokens: 0 }), "AGENT_PROVIDER_MANIFEST_INVALID"],
      [raw({ maxOutputTokens: 9000 }), "AGENT_PROVIDER_MANIFEST_INVALID"],
      [raw({ maxOutputTokens: 512.5 }), "AGENT_PROVIDER_MANIFEST_INVALID"],
      [raw({ remoteCopyMode: "keep_forever" }), "AGENT_PROVIDER_MANIFEST_REMOTE_COPY_MODE"],
    ] as const) {
      expect(() => parseAgentProviderManifest(document)).toThrow(code);
    }
  });

  it("refuses exactly the bytes the worker's reader refuses", () => {
    // Verified against `services/worker/.../providers/manifest.py`: each of
    // these is `AGENT_PROVIDER_MANIFEST_INVALID` there. A file only one side
    // accepts puts a digest in a health sample the other can never match, and
    // the agent is then unavailable with nothing said at start-up.
    //
    // A byte-order mark survives `raw.decode("utf-8")` in Python and fails
    // `json.loads`; stripping it here would have accepted the file.
    expect(() => parseAgentProviderManifest(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw()])))
      .toThrow("AGENT_PROVIDER_MANIFEST_INVALID");
    // `512.0` and `5.12e2` are Python floats, which `isinstance(tokens, int)`
    // refuses however integral their value is.
    for (const token of ["512.0", "5.12e2", "512e0", "0512", "true"]) {
      expect(() => parseAgentProviderManifest(rawToken("maxOutputTokens", token)))
        .toThrow("AGENT_PROVIDER_MANIFEST_INVALID");
    }
    // The integer literal both readers accept still parses, unchanged.
    expect(parseAgentProviderManifest(rawToken("maxOutputTokens", "512")).providerId)
      .toBe("fixture-socratic-v1");
  });

  it("refuses a described copy lifecycle this build does not implement", () => {
    // `delete_and_probe` is a mode the contracts may describe and no code
    // performs: there is no remote delete, no unreadability probe and no
    // closure record anywhere in this repository. The worker's reader refuses
    // it under this same code; accepting it here would let a manifest assert
    // that remote copies are deleted and the deletion proven, and would put a
    // digest in a health sample the worker will never report.
    expect(() => parseAgentProviderManifest(raw({ remoteCopyMode: "delete_and_probe" })))
      .toThrow("AGENT_PROVIDER_MANIFEST_COPY_MODE_UNIMPLEMENTED");
    // Distinct from a mode nobody has ever heard of, so a reader can tell
    // "unknown" from "real, and not implemented here yet".
    expect(() => parseAgentProviderManifest(raw({ remoteCopyMode: "keep_forever" })))
      .toThrow("AGENT_PROVIDER_MANIFEST_REMOTE_COPY_MODE");
    // The one mode this build delivers still parses.
    expect(parseAgentProviderManifest(raw()).providerId).toBe("fixture-socratic-v1");
  });

  it("refuses a manifest that carries the credential instead of naming it", () => {
    // A long unbroken token in a reviewed, committed, hashed file is a key.
    expect(() => parseAgentProviderManifest(raw({ purpose: `sk-${"a".repeat(70)}` })))
      .toThrow("AGENT_PROVIDER_MANIFEST_SECRET_SUSPECTED");
    // The accepted manifest names the variable and carries no value for it.
    expect(JSON.parse(raw().toString("utf8")).credentialEnvVar).toBe("LO_AGENT_PROVIDER_KEY");
    expect(Object.values(parseAgentProviderManifest(raw()))).not.toContain("LO_AGENT_PROVIDER_KEY");
  });

  it("refuses a relative path and a file it cannot read", () => {
    expect(() => loadAgentProviderScope({ LO_AGENT_PROVIDER_MANIFEST: "provider-manifest.json" }))
      .toThrow("AGENT_PROVIDER_MANIFEST_PATH_INVALID");
    expect(() => loadAgentProviderScope({ LO_AGENT_PROVIDER_MANIFEST: join(directory, "absent.json") }))
      .toThrow("AGENT_PROVIDER_MANIFEST_UNREADABLE");
    expect(() => loadAgentProviderScope({ LO_AGENT_PROVIDER_MANIFEST: directory }))
      .toThrow("AGENT_PROVIDER_MANIFEST_UNREADABLE");
  });

  it("carries one configured scope to both the health route and the agent service", async () => {
    const scope = parseAgentProviderManifest(raw());
    // The boot resolves the scope from the environment it was handed, and
    // hands the result to `buildApp` — nothing reads the ambient process.
    expect(loadServerConfig({ ...bootEnv, LO_AGENT_PROVIDER_MANIFEST: manifestPath }).agentProviderScope)
      .toEqual(scope);
    const { pool, calls } = recordingPool();
    const app = await buildApp({
      pool: pool as never,
      config: { allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN, agentProviderScope: scope },
      sessions: sessions as never,
      serviceAssertionTrust: { resolve: () => undefined },
    });
    try {
      const sample = (providerId: string, manifestSha256: string) => ({
        probeId: randomUUID(),
        providerId,
        manifestSha256,
        health: "healthy" as const,
        checkedAt: "2020-01-01T00:00:00.000Z",
        reasonCode: null,
      });
      // In scope: the sample reaches the assertion check and is refused there,
      // which is only possible if the boot handed this manifest to the route.
      const matched = await app.inject({
        method: "POST", url: HEALTH_PATH, payload: sample(scope.providerId, scope.manifestSha256),
      });
      expect([matched.statusCode, matched.json()]).toEqual([401, { status: "rejected", code: "PROBE_ASSERTION_INVALID" }]);
      // The fixture scope is no longer what this deployment admits.
      const stale = await app.inject({
        method: "POST", url: HEALTH_PATH, payload: sample("fixture", "0".repeat(64)),
      });
      expect([stale.statusCode, stale.json()]).toEqual([409, { status: "rejected", code: "PROVIDER_SCOPE_MISMATCH" }]);

      // The second consumer reads health for the same pair, so a healthy
      // provider cannot be reported under one scope and admitted under another.
      await app.inject({
        method: "GET", url: `/v1/rooms/${ROOM_ID}/agent/current`,
        headers: { origin: ORIGIN }, cookies: { lo_session: "opaque" },
      });
      const healthReads = calls.filter(({ sql }) => sql.includes("FROM agent_provider_health"));
      expect(healthReads).not.toHaveLength(0);
      for (const read of healthReads) {
        expect(read.values).toEqual([scope.providerId, scope.manifestSha256]);
      }
    } finally {
      await app.close();
    }
  });

  it("fails the boot on a malformed manifest instead of falling back to the fixture scope", async () => {
    // `main.ts` boots from `loadServerConfig()`, so the manifest is the boot's
    // authority: a deployment that meant to run a provider and silently did
    // not is indistinguishable from one that is merely unavailable.
    const malformedPath = join(directory, "malformed.json");
    writeFileSync(malformedPath, raw({ remoteCopyMode: "keep_forever" }));
    expect(() => loadServerConfig({ ...bootEnv, LO_AGENT_PROVIDER_MANIFEST: malformedPath }))
      .toThrow("AGENT_PROVIDER_MANIFEST_REMOTE_COPY_MODE");
    expect(() => loadServerConfig({ ...bootEnv, LO_AGENT_PROVIDER_MANIFEST: join(directory, "absent.json") }))
      .toThrow("AGENT_PROVIDER_MANIFEST_UNREADABLE");
    expect(() => loadServerConfig({ ...bootEnv, LO_AGENT_PROVIDER_MANIFEST: "provider-manifest.json" }))
      .toThrow("AGENT_PROVIDER_MANIFEST_PATH_INVALID");

    // And an app built from a config that names no scope admits nothing,
    // whatever the process happens to have in its environment.
    const { pool } = recordingPool();
    const app = await buildApp({
      pool: pool as never,
      config: { allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN },
      serviceAssertionTrust: { resolve: () => undefined },
    });
    try {
      const stale = await app.inject({
        method: "POST",
        url: HEALTH_PATH,
        payload: {
          probeId: randomUUID(),
          providerId: parseAgentProviderManifest(raw()).providerId,
          manifestSha256: parseAgentProviderManifest(raw()).manifestSha256,
          health: "healthy" as const,
          checkedAt: "2020-01-01T00:00:00.000Z",
          reasonCode: null,
        },
      });
      expect([stale.statusCode, stale.json()])
        .toEqual([409, { status: "rejected", code: "PROVIDER_SCOPE_MISMATCH" }]);
    } finally {
      await app.close();
    }
  });
});
