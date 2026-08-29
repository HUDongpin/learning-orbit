# Learning Orbit Reliability, Safety, Privacy, and Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that the controlled classroom pilot preserves messages, authorization, provenance, deletion, learner-safe interpretation, accessibility, and recoverability under realistic failures before any real student session.

**Architecture:** Reliability evidence is generated from the same monorepo and deployment topology as the pilot: instrumented Web/API/WS and Python Worker services, disposable PostgreSQL/object-store environments, four-student browser orchestration, deterministic fault injection, and explicit privacy/pilot release gates. Green component tests alone cannot authorize a classroom pilot.

**Tech Stack:** OpenTelemetry traces/metrics, structured redacted logs, PostgreSQL 18, Docker Compose, Vitest, Python unittest, Playwright, axe-core, the repository-pinned `grafana/k6:2.2.0` container, container/network fault injection, JSON evidence reports.

---

## Preconditions

Plans 01–04 must pass first. Then execute Task 3 Steps 1–4 (backend/contracts only) and Task 4 (`005_pilot_governance.sql`, deletion/export contracts, lifecycle routes and their server tests); those committed steps are the only Plan 06 prerequisite for the Plan 05 teacher UI. Task 3 Step 5 is explicitly post-Gate-5 Web security work and cannot be included in the prerequisite commit before those components exist. After Plan 05 passes against the bounded prerequisite, execute Tasks 1–2, Task 3 Step 5, and Tasks 5–8. The target is a supervised single-school/research pilot, not public production. This plan uses a default engineering load fixture of 10 simultaneous rooms × 4 students + 1 teacher, clearly labeled as a pilot test target rather than a production SLA. Before any Python command, activate the Plan 01 `.venv` and assert Python 3.12; never fall back to the host's default Python.

### Task 1: Add redacted observability and end-to-end correlation

**Files:**
- Create: `learning-orbit/apps/server/src/observability/telemetry.ts`
- Create: `learning-orbit/apps/server/src/observability/redaction.ts`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/observability.py`
- Create: `learning-orbit/apps/server/test/observability/redaction.test.ts`
- Create: `learning-orbit/apps/server/test/observability/telemetry.test.ts`
- Create: `learning-orbit/services/worker/tests/test_observability.py`
- Modify: `learning-orbit/apps/server/package.json`
- Modify: `learning-orbit/pnpm-lock.yaml`
- Modify: `learning-orbit/apps/server/src/main.ts`
- Modify: `learning-orbit/services/worker/pyproject.toml`
- Modify: `learning-orbit/services/worker/requirements.lock`
- Modify: `learning-orbit/services/worker/src/learning_orbit_worker/main.py`
- Modify: `learning-orbit/infra/docker-compose.yml`
- Modify: `learning-orbit/infra/images.lock.json`

- [ ] **Step 1: Write log-redaction failures first**

```ts
it("removes student content, signed URLs, cookies, and provider secrets", () => {
  const output = redactLog({
    roomId: "room-1", eventId: "event-1", text: "学生原文", cookie: "session=secret",
    uploadUrl: "https://store/object?X-Amz-Signature=secret", apiKey: "provider-secret"
  });
  expect(output).toEqual({ roomId: "room-1", eventId: "event-1", text: "[REDACTED_CONTENT]", cookie: "[REDACTED_SECRET]", uploadUrl: "[REDACTED_URL]", apiKey: "[REDACTED_SECRET]" });
});
```

- [ ] **Step 2: Run and verify raw values leak before implementation**

Run: `cd learning-orbit && pnpm vitest run apps/server/test/observability/redaction.test.ts`  
Expected: FAIL because `redactLog` is absent.

- [ ] **Step 3: Implement allowlist-first logging**

Install and lock the reviewed 2026-08-29 OpenTelemetry lines exactly: Node `@opentelemetry/api@1.9.1`, `@opentelemetry/sdk-node@0.221.0`, `@opentelemetry/exporter-trace-otlp-http@0.221.0`, `@opentelemetry/exporter-metrics-otlp-http@0.221.0`, `@opentelemetry/sdk-trace-base@2.10.0`, and `@opentelemetry/sdk-metrics@2.10.0`; Python `opentelemetry-api==1.44.0`, `opentelemetry-sdk==1.44.0`, and `opentelemetry-exporter-otlp-proto-http==1.44.0`. Regenerate the existing pnpm and hashed Python locks, run both lock verifiers, and review the license/dependency diff. Do not install globally or create another requirements file. Resolve the official OpenTelemetry Collector image to a reviewed immutable digest in `infra/images.lock.json`; Compose uses only that digest and a repository config that accepts OTLP inside the private network without exposing a public ingest port.

```ts
const SAFE_KEYS = new Set(["service", "environment", "roomId", "eventId", "roomSeq", "commandId", "jobId", "correlationId", "agentRunId", "projectionVersion", "completeThroughRoomSeq", "failureCode", "durationMs"]);

export function redactLog(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => {
    if (SAFE_KEYS.has(key)) return [key, value];
    if (/url/i.test(key)) return [key, "[REDACTED_URL]"];
    if (/secret|token|key|cookie|authorization/i.test(key)) return [key, "[REDACTED_SECRET]"];
    return [key, "[REDACTED_CONTENT]"];
  }));
}
```

- [ ] **Step 4: Correlate the full event path**

Instrument `command.accept → room_event.commit → outbox.publish → worker.claim → projection.commit → websocket.send → client.apply` with `correlationId`, `roomSeq`, and safe version metadata. Worker instrumentation must read `correlationId` from the claimed Plan 01 `worker_job.correlation_id`; it may not create a replacement trace identifier. Tests dispatch one fixture for every registered job family and require the span/log correlation to equal the persisted row before and after retry. Do not attach message bodies, prompts, transcripts, captions, media URLs, or provider payloads to spans. Node telemetry starts before Fastify/plugin construction and flushes/shuts down on server close/SIGTERM; Python telemetry starts once in the canonical worker composition root and flushes on normal stop/SIGTERM. Production uses bounded OTLP/HTTP exporters pointed only at the approved collector. Tests inject `InMemorySpanExporter`/`InMemoryMetricExporter` (Node) and in-memory span/metric readers (Python), so they require no network and inspect every attribute. Missing/unreachable collector degrades telemetry without blocking classroom writes and emits only a rate-limited safe code; it never buffers without bound.

- [ ] **Step 5: Run JS/Python telemetry tests and commit**

Run: `cd learning-orbit && node scripts/verify-python-lock.mjs && pnpm vitest run apps/server/test/observability && .venv/bin/python -m unittest services/worker/tests/test_observability.py -v`  
Expected: PASS; fixture secrets and content do not appear in captured logs/spans.  
Commit:

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/main.ts apps/server/src/observability apps/server/test/observability services/worker/pyproject.toml services/worker/requirements.lock services/worker/src/learning_orbit_worker/main.py services/worker/src/learning_orbit_worker/observability.py services/worker/tests/test_observability.py infra/docker-compose.yml infra/images.lock.json
git commit -m "feat(ops): add redacted end-to-end telemetry"
```

### Task 2: Prove event, outbox, and projection recovery under faults

**Files:**
- Create: `learning-orbit/tests/chaos/event-spine.test.ts`
- Create: `learning-orbit/tests/chaos/projection-replay.test.ts`
- Create: `learning-orbit/tests/chaos/worker-container-contract.test.ts`
- Create: `learning-orbit/tests/chaos/support/faults.ts`
- Create: `learning-orbit/infra/docker/{server,worker,web}.Dockerfile`
- Create: `learning-orbit/scripts/verify-worker-runtime-sql.mjs`
- Modify: `learning-orbit/infra/docker-compose.yml`
- Modify: `learning-orbit/infra/images.lock.json`

- [ ] **Step 1: Write the event-spine invariants**

```ts
it("survives lost ack, duplicate command, server restart, and outbox replay", async () => {
  const commandId = crypto.randomUUID();
  await faults.dropNextWebSocketAck();
  await student.send({ commandId, type: "message.add", payload: { text: "能量沿食物链转移" } });
  await faults.restartServer();
  await student.resume();
  await student.send({ commandId, type: "message.add", payload: { text: "能量沿食物链转移" } });
  expect(await db.eventsByCommand(commandId)).toHaveLength(1);
  expect(await fourClients.visibleCopies(commandId)).toEqual([1, 1, 1, 1]);
});
```

- [ ] **Step 2: Run against the normal integration environment**

Run: `cd learning-orbit && pnpm vitest run tests/chaos/event-spine.test.ts`  
Expected: FAIL until fault controls and resume hooks are wired.

- [ ] **Step 3: Implement deterministic fault controls**

```ts
export const faults = {
  async restartServer() { await compose.restart("server"); await health.wait("server"); },
  async restartWorker() { await compose.restart("worker"); await health.wait("worker"); },
  async pauseOutbox() { await control.post("/test/faults/outbox", { paused: true }); },
  async skewClientClock(ms: number) { await control.post("/test/faults/client-clock", { ms }); },
  async dropNextWebSocketAck() { await control.post("/test/faults/ws/drop-next-ack", {}); }
};
```

Test-only control routes compile only when `LEARNING_ORBIT_TEST_FAULTS=1`; production startup fails if that variable is set.

The `pilot-test` Compose profile builds Web, server and Worker from the same lockfiles/source commit with separate minimal Dockerfiles and health checks; it connects them to the disposable PostgreSQL/private-storage services from Plans 01–02. Resolve official Node 24 and Python 3.12 slim base images to reviewed immutable digests in `infra/images.lock.json`; Dockerfiles consume only those build arguments and run as non-root with read-only application files. `compose.restart("server"|"worker")` addresses these exact service names. Fault routes and container-control credentials exist only in this profile, and a production build/start test rejects them.

The Worker image is built with repository root as context. In addition to `services/worker`, `worker.Dockerfile` explicitly copies only these runtime-owned canonical SQL files to `/app/apps/server/src/db/sql/`: `claim_worker_job.sql`, `settle_worker_job_claims.sql`, `lock_room_xact.sql`, `lock_room_session.sql`, and `unlock_room_session.sql`. This preserves the path resolved by `/app/services/worker/src/learning_orbit_worker/{jobs,room_lock}.py`; the image may not carry a Python rewrite. `verify-worker-runtime-sql.mjs` computes each source SHA-256, reads the file back from the built image as its non-root user, compares bytes and then starts the container against the disposable DB to import `jobs`/`room_lock`, claim one fixture job and acquire/release the canonical room lock. Missing/extra/drifted SQL, `ENOENT`, wrong ownership or an image built from a different source commit fails before chaos tests.

- [ ] **Step 4: Add replay and future-time poisoning scenarios**

Inject duplicate, revise, retract, delete, five-second lateness, severely late events, a one-day future client time, worker crash after claim, projection version gap, and checkpoint restore. Assert chat zero-loss, idempotent projection weights, online/replay hash parity, and visible last-good＋rebuilding status.

- [ ] **Step 5: Run chaos tests and commit**

Run: `cd learning-orbit && node scripts/verify-worker-runtime-sql.mjs && pnpm vitest run tests/chaos/worker-container-contract.test.ts tests/chaos/event-spine.test.ts tests/chaos/projection-replay.test.ts --sequence.concurrent=false`  
Expected: PASS; the installed Worker imports/claims/locks with byte-identical canonical SQL, and each scenario writes a deterministic JSON evidence record under `test-results/chaos/`.  
Commit:

```bash
git add tests/chaos infra/docker infra/docker-compose.yml infra/images.lock.json scripts/verify-worker-runtime-sql.mjs
git commit -m "test(reliability): prove event and projection recovery"
```

### Task 3: Close authorization, injection, and content-rendering threats

**Files:**
- Create: `learning-orbit/infra/postgres/migrations/005_pilot_governance.sql`
- Create: `learning-orbit/infra/postgres/migrations/006_enforce_pilot_governance.sql`
- Create: `learning-orbit/infra/postgres/seeds/test/pilot-retention-policy.fixture.sql`
- Create: `learning-orbit/packages/contracts/schemas/pilot-retention-policy-record.v1.json`
- Create: `learning-orbit/packages/contracts/schemas/provider-copy-authority-record.v1.json`
- Generate: `learning-orbit/packages/contracts/src/generated/pilot-retention-policy-record.v1.ts`
- Generate: `learning-orbit/packages/contracts/src/generated/provider-copy-authority-record.v1.ts`
- Modify: `learning-orbit/packages/contracts/src/generated/manifest.json`
- Modify: `learning-orbit/services/worker/src/learning_orbit_worker/generated/manifest.json`
- Modify: `learning-orbit/packages/contracts/src/index.ts`
- Modify: `learning-orbit/packages/contracts/test/generated-ownership.test.ts`
- Create: `learning-orbit/docs/security/threat-model.md`
- Create: `learning-orbit/docs/pilot/trusted-authority-configuration.md`
- Create: `learning-orbit/apps/server/src/modules/authorization/authorize-room-action.ts`
- Create: `learning-orbit/apps/server/src/modules/authorization/controlled-authority-verifier.ts`
- Modify: `learning-orbit/apps/server/src/modules/security/service-assertion.ts`
- Create: `learning-orbit/apps/server/test/security/controlled-authority-verifier.test.ts`
- Create: `learning-orbit/apps/server/test/security/provider-copy-authority.test.ts`
- Create: `learning-orbit/apps/server/src/modules/lifecycle/pilot-policy-import.ts`
- Create: `learning-orbit/apps/server/src/modules/lifecycle/student-analytics-policy-listener.ts`
- Create: `learning-orbit/apps/server/src/modules/analytics/governed-room-analytics-access.ts`
- Create: `learning-orbit/scripts/import-approved-pilot-policy.ts`
- Create: `learning-orbit/apps/server/test/security/role-boundaries.test.ts`
- Create: `learning-orbit/apps/server/test/security/cross-room.test.ts`
- Create: `learning-orbit/apps/server/test/lifecycle/pilot-policy-import.test.ts`
- Create: `learning-orbit/apps/server/test/lifecycle/retention-binding.test.ts`
- Create: `learning-orbit/apps/server/test/lifecycle/student-analytics-policy-listener.test.ts`
- Create after Plan 05 Gate 5: `learning-orbit/apps/web/src/security/render-untrusted.tsx`
- Create after Plan 05 Gate 5: `learning-orbit/apps/web/src/security/render-untrusted.test.tsx`
- Create after Plan 05 Gate 5: `learning-orbit/tests/security/security-regression.test.ts`
- Modify after Plan 05 Gate 5: `learning-orbit/apps/web/src/{chat,concept,sna,teacher}/`
- Modify: `learning-orbit/apps/server/src/{app,routes,realtime}.ts`
- Modify: `learning-orbit/apps/server/src/modules/rooms/room-service.ts`
- Modify: `learning-orbit/apps/server/src/modules/{rooms,media,analytics,agent}/`

- [ ] **Step 1: Encode server-derived identity tests**

```ts
it("rejects forged actor and Agent role fields before creating an event", async () => {
  const commandId = crypto.randomUUID();
  const response = await studentClient.command(roomId, {
    commandId, type: "message.add",
    actorId: teacherActorId, actorKind: "agent", agentRole: "socratic_facilitator",
    payload: { text: "伪造消息" }
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().code).toBe("INVALID_COMMAND");
  expect(await db.eventsByCommand(commandId)).toHaveLength(0);
});
```

- [ ] **Step 2: Run the security suite in red state**

Run: `cd learning-orbit && pnpm contracts:generate && pnpm test:contracts && pnpm db:migrate:test && pnpm vitest run apps/server/test/security apps/server/test/lifecycle/pilot-policy-import.test.ts apps/server/test/lifecycle/retention-binding.test.ts apps/server/test/lifecycle/student-analytics-policy-listener.test.ts`  
Expected: FAIL because the shared authorization guard, signed policy import/binding, policy listener and governance migrations are absent. No Web file is referenced before Plan 05 exists.

- [ ] **Step 3: Implement a single authorization decision function**

`analytics/governed-room-analytics-access.ts` is the production implementation of Plan 03 `RoomAnalyticsAccessPort`; application composition refuses the synthetic adapter outside tests. It resolves current session/membership, deletion tombstone, bound retention policy and the exact per-key promotion in one authorized read and exposes no new bypass.

```ts
export async function authorizeRoomAction(deps: AuthzDeps, principal: Principal, roomId: string, action: RoomAction) {
  const current = await deps.sessions.requireCurrent(principal.sessionId);
  if (current.principalId !== principal.principalId || current.kind !== principal.kind) throw new UnauthorizedError();
  if (await deps.deletions.hasStarted(roomId)) throw new GoneError("ROOM_DELETION_IN_PROGRESS");
  if (principal.kind === "teacher") {
    const ownsRoom = await deps.rooms.isTeacher(roomId, principal.teacherId);
    if (!ownsRoom || !ROLE_ACTIONS.teacher.has(action)) throw new NotFoundError();
    return { actorId: principal.teacherId, actorKind: "human" as const, role: "teacher" as const };
  }
  const member = await deps.members.findStudent(roomId, principal.roomMemberId);
  if (!member || member.actorId !== principal.actorId || !ROLE_ACTIONS.student.has(action)) throw new NotFoundError();
  return { actorId: member.actorId, actorKind: "human" as const, role: "student" as const };
}

export async function authorizeDeletionStatusRead(deps: AuthzDeps, principal: Principal, roomId: string) {
  if (principal.kind !== "teacher") throw new NotFoundError();
  const current = await deps.sessions.requireCurrent(principal.sessionId);
  if (current.teacherId !== principal.teacherId) throw new UnauthorizedError();
  const roomRef = deps.roomRefs.sha256(roomId);
  const job = await deps.deletions.findByRoomRef(roomRef);
  if (!job || job.ownerTeacherId !== principal.teacherId) throw new NotFoundError();
  return { action: "deletion_status_read" as const, deletionJobId: job.deletionJobId };
}
```

Browser sessions can resolve only teacher or student principals. Nova and system workers use Plan 01's canonical short-lived service-assertion verifier/signer/client, with Plan 04's provider-health specialization; no client-supplied Agent role enters this function.

Every room-scoped HTTP route, WebSocket upgrade/frame, resume/read, media, analytics, Agent, export and deletion route calls this guard before loading room data and again under the lock for writes. It verifies the current session/principal and rejects deletion-in-progress except the content-free owner-only deletion-status path. Internal room/job mutations continue to call Plan 01 `authorizeServiceAssertion`, which binds the complete job tuple in the request body; passing it is necessary but not sufficient because modules still lock/CAS raw job and family identity. The sole named non-room/job exception is `internal.agent.health`, which continues to use Plan 04 `authorizeProviderHealthAssertion`. Task 3 changes neither verification algorithm. It imports/rotates the allowlisted verifier public keys and Worker signer key IDs as one signed trust record, rejects overlap gaps, revoked/fixture/private verifier keys and a signer ID absent from the verifier set, and documents owner-only secret-file delivery. Browser cookies never substitute for either guard. Inventory tests cover key rotation at old/current/next boundaries, forged issuer/subject, stolen/stale job, body mismatch and provider-health scope/time failures; all write zero unauthorized rows.

Migration `005_pilot_governance.sql` creates only the durable governance records needed by Tasks 3–4:

```sql
CREATE TABLE pilot_retention_policy (
  policy_id uuid PRIMARY KEY,
  policy_version text UNIQUE NOT NULL,
  room_events_days integer NOT NULL CHECK (room_events_days > 0),
  raw_media_days integer NOT NULL CHECK (raw_media_days > 0),
  derived_artifacts_days integer NOT NULL CHECK (derived_artifacts_days > 0),
  projections_days integer NOT NULL CHECK (projections_days > 0),
  agent_runs_days integer NOT NULL CHECK (agent_runs_days > 0),
  provider_copies_days integer NOT NULL CHECK (provider_copies_days > 0),
  backups_days integer NOT NULL CHECK (backups_days > 0),
  audit_metadata_days integer NOT NULL CHECK (audit_metadata_days > 0),
  approval_reference text NOT NULL,
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > approved_at),
  CHECK (room_events_days >= GREATEST(derived_artifacts_days, projections_days, agent_runs_days)),
  CHECK (raw_media_days >= derived_artifacts_days),
  CHECK (provider_copies_days <= LEAST(raw_media_days, derived_artifacts_days, agent_runs_days))
);

CREATE TABLE verified_provider_copy_authority (
  authority_id text PRIMARY KEY,
  record_sha256 char(64) UNIQUE NOT NULL CHECK (record_sha256 ~ '^[a-f0-9]{64}$'),
  issuer_id text NOT NULL,
  key_id text NOT NULL,
  provider_id text NOT NULL,
  provider_manifest_sha256 char(64) NOT NULL CHECK (provider_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  lifecycle_mode text NOT NULL CHECK (lifecycle_mode='no_persistent_copy_attested'),
  scope_hash char(64) NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > starts_at),
  revoked_at timestamptz,
  verified_at timestamptz NOT NULL
);

ALTER TABLE provider_processing_record
  ADD CONSTRAINT provider_processing_no_copy_authority_fk
  FOREIGN KEY (no_persistent_copy_authority_id)
  REFERENCES verified_provider_copy_authority(authority_id)
  NOT VALID;

ALTER TABLE classroom_room
  ADD COLUMN retention_policy_id uuid REFERENCES pilot_retention_policy(policy_id);

CREATE TABLE student_analytics_promotion (
  room_id uuid PRIMARY KEY REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  promotion_record_sha256 char(64) NOT NULL CHECK (promotion_record_sha256 ~ '^[a-f0-9]{64}$'),
  policy_revision bigint NOT NULL CHECK (policy_revision > 0),
  feature_allowlist text[] NOT NULL,
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > starts_at),
  revoked_at timestamptz,
  CHECK (feature_allowlist <@ ARRAY['echo.student_approved','trace.student_bundle']::text[])
);

CREATE TABLE security_audit_event (
  security_audit_event_id uuid PRIMARY KEY,
  correlation_id uuid NOT NULL,
  principal_kind text NOT NULL CHECK (principal_kind IN ('teacher','student','service','anonymous')),
  action text NOT NULL CHECK (action IN (
    'auth.magic_link.request','room.join','room.read','room.command',
    'media.read','analytics.read','analytics.review','agent.control',
    'export.request','deletion.request','deletion.status.read','service.callback'
  )),
  outcome text NOT NULL CHECK (outcome IN ('allowed','rejected','failed')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z0-9_]{1,64}$'),
  room_ref_sha256 char(64) CHECK (room_ref_sha256 ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deletion_job (
  deletion_job_id uuid PRIMARY KEY,
  correlation_id uuid NOT NULL,
  room_id uuid REFERENCES classroom_room(room_id) ON DELETE SET NULL,
  room_ref_sha256 char(64) NOT NULL CHECK (room_ref_sha256 ~ '^[a-f0-9]{64}$'),
  request_kind text NOT NULL CHECK (request_kind IN ('teacher','retention')),
  policy_version text,
  status text NOT NULL CHECK (status IN ('queued','running','retryable','completed','dead')),
  owner_teacher_id uuid NOT NULL REFERENCES teacher_account(teacher_id),
  requested_by_teacher_id uuid REFERENCES teacher_account(teacher_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((request_kind='teacher' AND requested_by_teacher_id IS NOT NULL AND policy_version IS NULL) OR
         (request_kind='retention' AND requested_by_teacher_id IS NULL AND policy_version IS NOT NULL))
);

CREATE TABLE deletion_surface_manifest (
  deletion_job_id uuid NOT NULL REFERENCES deletion_job(deletion_job_id) ON DELETE CASCADE,
  surface text NOT NULL CHECK (surface IN ('events','media','derivatives','artifacts','projections','agent_runs','caches','provider_copies')),
  expected_item_count integer NOT NULL CHECK (expected_item_count >= 0),
  status text NOT NULL CHECK (status IN ('frozen','running','verified','dead')),
  frozen_at timestamptz NOT NULL,
  verified_at timestamptz,
  PRIMARY KEY (deletion_job_id,surface)
);

CREATE TABLE deletion_provider_copy_item (
  deletion_job_id uuid NOT NULL REFERENCES deletion_job(deletion_job_id) ON DELETE CASCADE,
  processing_record_id uuid NOT NULL,
  provider_id text NOT NULL,
  provider_manifest_sha256 char(64) NOT NULL CHECK (provider_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  lifecycle_mode text NOT NULL CHECK (lifecycle_mode IN ('delete_and_probe','no_persistent_copy_attested')),
  scope_hash char(64) NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  authority_id text,
  status text NOT NULL CHECK (status IN ('pending','proven','retryable','dead')),
  outcome_code text CHECK (outcome_code IS NULL OR outcome_code ~ '^[A-Z0-9_]{1,64}$'),
  proven_at timestamptz,
  PRIMARY KEY (deletion_job_id,processing_record_id),
  CHECK ((lifecycle_mode='delete_and_probe' AND authority_id IS NULL) OR
         (lifecycle_mode='no_persistent_copy_attested' AND authority_id IS NOT NULL))
);

CREATE TABLE provider_copy_closure (
  processing_record_id uuid PRIMARY KEY,
  room_ref_sha256 char(64) NOT NULL CHECK (room_ref_sha256 ~ '^[a-f0-9]{64}$'),
  provider_id text NOT NULL,
  provider_manifest_sha256 char(64) NOT NULL CHECK (provider_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  lifecycle_mode text NOT NULL CHECK (lifecycle_mode IN ('delete_and_probe','no_persistent_copy_attested')),
  scope_hash char(64) NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  authority_id text,
  outcome_code text NOT NULL CHECK (outcome_code IN ('REMOTE_COPY_UNREADABLE','NO_PERSISTENT_COPY_AUTHORITY_VERIFIED')),
  proof_version integer NOT NULL CHECK (proof_version=1),
  proven_by_job_id uuid NOT NULL,
  proven_at timestamptz NOT NULL,
  CHECK ((lifecycle_mode='delete_and_probe' AND outcome_code='REMOTE_COPY_UNREADABLE') OR
         (lifecycle_mode='no_persistent_copy_attested' AND outcome_code='NO_PERSISTENT_COPY_AUTHORITY_VERIFIED')),
  CHECK ((lifecycle_mode='delete_and_probe' AND authority_id IS NULL) OR
         (lifecycle_mode='no_persistent_copy_attested' AND authority_id IS NOT NULL))
);
CREATE INDEX provider_copy_closure_room_ref_idx
  ON provider_copy_closure(room_ref_sha256,processing_record_id);

CREATE TABLE deletion_media_fence_item (
  deletion_job_id uuid NOT NULL REFERENCES deletion_job(deletion_job_id) ON DELETE CASCADE,
  item_kind text NOT NULL CHECK (item_kind IN ('media_asset','upload_grant','media_job','media_write_fence')),
  item_id uuid NOT NULL,
  write_not_after timestamptz,
  status text NOT NULL CHECK (status IN ('pending','quiescent','proven','retryable','dead')),
  outcome_code text CHECK (outcome_code IS NULL OR outcome_code ~ '^[A-Z0-9_]{1,64}$'),
  proven_at timestamptz,
  PRIMARY KEY (deletion_job_id,item_kind,item_id),
  CHECK ((item_kind IN ('upload_grant','media_write_fence') AND write_not_after IS NOT NULL) OR
         (item_kind IN ('media_asset','media_job') AND write_not_after IS NULL))
);

CREATE TABLE deletion_receipt (
  deletion_job_id uuid PRIMARY KEY REFERENCES deletion_job(deletion_job_id) ON DELETE CASCADE,
  receipt_version integer NOT NULL CHECK (receipt_version = 1),
  surfaces_verified jsonb NOT NULL CHECK (jsonb_typeof(surfaces_verified) = 'array'),
  completed_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX deletion_job_one_unfinished_room_idx
  ON deletion_job(room_id)
  WHERE room_id IS NOT NULL AND status IN ('queued','running','retryable','dead');
```

The application, not the client, computes `room_ref_sha256` with a deployment audit salt. Contract/migration tests reject unknown `action` values, malformed reason codes, content, email, pseudonym, IP, user-agent, URL, token, media, prompt, transcript and free-text columns in these audit/receipt tables. `provider_copy_closure` is deliberately not foreign-keyed to `provider_processing_record`: it is the content-free, identity-bound proof that survives after that locator-bearing parent is removed. It contains no room UUID, locator, request/response, learner text, media ID or authority secret. Its provider/manifest/mode/scope/authority tuple must exactly equal the tuple frozen in any `deletion_provider_copy_item`; `authority_id` is present only for no-persistence proof and names the immutable verified record used at `proven_at`, never key material. A conflicting insert for the same processing ID is a fatal invariant error. An explicit authority `revoked_at <= proven_at` invalidates that closure and blocks a receipt; ordinary later expiry does not rewrite historical proof. Retention policies are immutable approval records. Plan 06 refactors the Plan 01 room-creation transaction to resolve exactly one current policy from reviewed server configuration, lock it, and store its ID; `CreateRoomRequest` remains `{topic}` and cannot choose or extend retention. Zero or ambiguous current policies fail with `RETENTION_POLICY_NOT_CONFIGURED`.

The migration/import sequence is executable and deliberately two-phase. Migration `005` creates the policy table, the content-free verified-provider-authority table, the not-yet-validated Plan 04 authority FK and nullable room binding without guessing a policy. `pilot-retention-policy-record.v1.json` and `provider-copy-authority-record.v1.json` are separate closed record schemas. The latter permits only `no_persistent_copy_attested` and requires provider ID, exact manifest SHA-256, region/purpose/retention scope, signed start/expiry and authority ID; URLs, secrets, learner content and vague free text are forbidden. The single `controlled-authority-verifier.ts` canonicalizes these long-lived governance records and verifies their detached Ed25519 signatures against an issuer/key allowlist read from the deployment-controlled path described in `trusted-authority-configuration.md`; no other governance-import/CLI module may implement that protocol. It is intentionally separate from Plan 01's short-lived service-call envelope verifier, and neither delegates to or accepts the other's record shape/key purpose. `import-approved-pilot-policy.ts` accepts these verified records from the controlled evidence store, dispatches by generated schema discriminator, checks scope/expiry and inserts exactly one immutable retention policy or content-free provider-authority row. At this stage the importer supports only those two record families; student-promotion import is added by Task 7 after its separate closed schema exists. Existing synthetic rooms are mapped only through an explicit `--map-synthetic-room <roomId>` allowlist. The SQL fixture under `infra/postgres/seeds/test/` is labeled `synthetic: true`, may run only when `NODE_ENV=test`, and is rejected by every pilot assertion. Migration `006` then stops with `RETENTION_POLICY_MAPPING_REQUIRED` if any room is unbound, and with `PROVIDER_COPY_AUTHORITY_MAPPING_REQUIRED` if an existing `no_persistent_copy_attested` processing row lacks an exact verified provider/manifest authority, before setting `retention_policy_id NOT NULL` and validating the provider authority FK. Tests cover fresh install, rerun, invalid signature, expired policy/authority, provider or manifest mismatch, ambiguous active policies, forbidden production fixture import, unmapped legacy room and an explicitly mapped synthetic room.

`student_analytics_promotion` is empty by default. Task 7 modifies the same importer—without adding another verifier—to populate it only after validating a linked `student_visible_promotion` record whose room/date scope and feature allowlist match the room. Current access requires `revoked_at IS NULL`, `starts_at <= now < expires_at` and membership of the exact requested key; revoked rows remain content-free tombstones with an incremented `policy_revision`, preserving monotonic notification/replay checks. The student latest/patch/timeline endpoints return `403 STUDENT_ANALYTICS_NOT_PROMOTED` until a current row authorizes the exact requested student projection key; teacher shadow projections remain available under teacher authorization. Every grant/revoke/expiry transaction also emits `pg_notify('student_analytics_policy_changed', canonicalJson({roomId,changedKeys,revision}))`; the closed payload contains only a room UUID, unique allowlisted student projection keys and monotonic policy revision, stays under PostgreSQL's payload bound, and is schema-validated by the listener before use. `student-analytics-policy-listener.ts` then re-reads durable policy under server authorization: newly granted keys enqueue their current projection pointer; revoked/expired keys send the generated targeted analytics `degraded` frame with `STUDENT_ANALYTICS_NOT_PROMOTED` to affected student sockets. On listener restart it reconciles all connected rooms, and clients also recheck on heartbeat/resume, so a lost notification cannot leave stale access. The client immediately clears only the named panel state/cursor; chat and the other key continue. Tests cover one-key grant, one-key revoke, expiry, stale/reordered revisions, malformed/oversized notifications, lost NOTIFY/restart and zero RoomEvent/outbox content writes.

- [ ] **Step 4: Pass and commit the bounded backend governance prerequisite**

Run: `cd learning-orbit && pnpm contracts:generate && pnpm test:contracts && pnpm db:migrate:test && pnpm vitest run apps/server/test/security apps/server/test/lifecycle/pilot-policy-import.test.ts apps/server/test/lifecycle/retention-binding.test.ts apps/server/test/lifecycle/student-analytics-policy-listener.test.ts`  
Expected: PASS; migration reruns cleanly, the approved-policy importer/binding tests pass, room creation fails on zero/ambiguous/untrusted policy and stores exactly one immutable policy ID, forbidden cross-room operations uniformly return 404, and each creates only a content-free `security_audit_event`. Write the command manifest, result and source SHA to the ignored/controlled `test-results/gate-04a-governance.json`; this is engineering evidence only and is not staged as authority.  
Commit only the backend/contract prerequisite:

```bash
git add infra/postgres/migrations/005_pilot_governance.sql infra/postgres/migrations/006_enforce_pilot_governance.sql infra/postgres/seeds/test/pilot-retention-policy.fixture.sql packages/contracts services/worker/src/learning_orbit_worker/generated/manifest.json docs/security docs/pilot/trusted-authority-configuration.md apps/server/src/modules/authorization apps/server/src/modules/security/service-assertion.ts apps/server/src/modules/lifecycle/pilot-policy-import.ts apps/server/src/modules/lifecycle/student-analytics-policy-listener.ts scripts/import-approved-pilot-policy.ts apps/server/src/app.ts apps/server/src/routes.ts apps/server/src/realtime.ts apps/server/src/modules/rooms apps/server/src/modules/media apps/server/src/modules/analytics apps/server/src/modules/agent apps/server/test/security apps/server/test/lifecycle/pilot-policy-import.test.ts apps/server/test/lifecycle/retention-binding.test.ts apps/server/test/lifecycle/student-analytics-policy-listener.test.ts
git commit -m "feat(governance): close backend classroom authorization"
```

- [ ] **Step 5: After Plan 05 Gate 5, drive untrusted rendering red-to-green and commit separately**

First create `render-untrusted.test.tsx` and `security-regression.test.ts` so they import the not-yet-created `render-untrusted.tsx`, exercise the real chat/concept/SNA/teacher components, and cover stored XSS, SVG/script uploads, prompt injection hidden in image/OCR, markdown links, bidi controls, excessively long grapheme sequences, forged evidence IDs, WebSocket origin mismatch, signed-URL leakage, cross-room IDOR, CSRF, rate limits and provider callback replay.

Run red: `cd learning-orbit && pnpm vitest run apps/web/src/security/render-untrusted.test.tsx tests/security/security-regression.test.ts`  
Expected: FAIL first because the central safe renderer/policy is missing (or a real component violates it); a pre-existing accidental pass is not accepted without proving every named component appears in the route/component coverage manifest.

Implement `render-untrusted.tsx` as a small shared boundary: plain learner/Agent/artifact text becomes React text nodes, allowable links use a closed protocol/attribute policy, and no untrusted path uses `innerHTML`, raw SVG markup or provider HTML. Migrate every named Plan 05 surface through it, then run green: `cd learning-orbit && pnpm vitest run apps/server/test/security apps/web/src/security/render-untrusted.test.tsx tests/security/security-regression.test.ts`  
Expected: PASS; route authorization remains green and the real Web surfaces render adversarial fixtures inertly without hiding or normalizing away audit evidence.  
Commit only the post-Gate-5 Web/security slice:

```bash
git add apps/web/src/security apps/web/src/chat apps/web/src/concept apps/web/src/sna apps/web/src/teacher tests/security
git commit -m "test(security): render classroom content as untrusted data"
```

### Task 4: Prove export, retention, and deletion closure

**Files:**
- Create: `learning-orbit/packages/contracts/schemas/deletion-lifecycle.v1.json`
- Create: `learning-orbit/packages/contracts/schemas/lifecycle-internal-media-surface.v1.json`
- Generate: `learning-orbit/packages/contracts/src/generated/deletion-lifecycle.v1.ts`
- Generate: `learning-orbit/packages/contracts/src/generated/lifecycle-internal-media-surface.v1.ts`
- Generate: `learning-orbit/services/worker/src/learning_orbit_worker/generated/lifecycle_internal_media_surface_v1.py`
- Modify: `learning-orbit/packages/contracts/src/generated/manifest.json`
- Modify: `learning-orbit/services/worker/src/learning_orbit_worker/generated/manifest.json`
- Verify unchanged: `learning-orbit/packages/contracts/scripts/generate-types.mjs`
- Modify: `learning-orbit/packages/contracts/{src/index.ts,src/routes.ts}`
- Create: `learning-orbit/packages/contracts/test/deletion-lifecycle.test.ts`
- Create: `learning-orbit/apps/server/src/modules/lifecycle/retention-policy.ts`
- Create: `learning-orbit/apps/server/src/modules/lifecycle/retention-scheduler.ts`
- Create: `learning-orbit/apps/server/src/modules/lifecycle/student-analytics-promotion.ts`
- Create: `learning-orbit/apps/server/src/modules/lifecycle/export-room.ts`
- Create: `learning-orbit/apps/server/src/modules/lifecycle/deletion-saga.ts`
- Create: `learning-orbit/apps/server/src/modules/lifecycle/deletion-receipt.ts`
- Create: `learning-orbit/apps/server/src/modules/lifecycle/internal-media-surface-route.ts`
- Modify: `learning-orbit/apps/server/src/modules/media/{media-deletion-manifest-port,room-write-gate}.ts`
- Modify: `learning-orbit/apps/server/src/app.ts`
- Modify: `learning-orbit/apps/server/src/routes.ts`
- Create: `learning-orbit/apps/server/test/lifecycle/route-registration.test.ts`
- Create: `learning-orbit/apps/server/test/lifecycle/room-deletion-closure.test.ts`
- Create: `learning-orbit/apps/server/test/lifecycle/retention-expiry.test.ts`
- Create: `learning-orbit/apps/server/test/lifecycle/provider-copy-closure-race.test.ts`
- Create: `learning-orbit/apps/server/test/lifecycle/internal-media-surface-route.test.ts`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/lifecycle.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/provider_copy_lifecycle.py`
- Reuse unchanged: `learning-orbit/services/worker/src/learning_orbit_worker/room_lock.py`
- Reuse unchanged: `learning-orbit/services/worker/src/learning_orbit_worker/jobs.py`
- Modify: `learning-orbit/services/worker/src/learning_orbit_worker/main.py`
- Create: `learning-orbit/services/worker/tests/test_lifecycle.py`
- Create: `learning-orbit/services/worker/tests/test_provider_copy_lifecycle.py`
- Create: `learning-orbit/services/worker/tests/test_lifecycle_handler_registration.py`
- Create: `learning-orbit/services/worker/tests/test_lifecycle_media_contract.py`
- Create: `learning-orbit/docs/privacy/data-inventory.md`

- [ ] **Step 1: Write a full-surface deletion test**

```ts
it("makes source and derived classroom data unreadable before issuing receipt", async () => {
  const request = await teacherClient.delete(`/v1/rooms/${roomId}`);
  expect(request.statusCode).toBe(202);
  const receipt = await waitForDeletionReceipt(request.json().deletionJobId);
  expect(Object.keys(receipt).sort()).toEqual(["completedAt", "receiptVersion", "surfacesVerified"]);
  expect(receipt.surfacesVerified).toEqual(["agent_runs", "artifacts", "caches", "derivatives", "events", "media", "projections", "provider_copies"]);
  expect(await probes.readableArtifacts(roomId)).toEqual({ events: 0, media: 0, derivatives: 0, artifacts: 0, projections: 0, agentRuns: 0, caches: 0, providerCopies: 0 });
});

it("freezes provider-copy IDs before any parent can be deleted", async () => {
  const expectedIds = await seedTrackedAgentAndMediaProviderCalls(roomId);
  const accepted = await teacherClient.delete(`/v1/rooms/${roomId}`);
  const jobId = accepted.json().deletionJobId;
  expect(await providerCopyManifest(jobId)).toEqual({ expectedItemCount: expectedIds.length, status: "frozen" });
  expect(await frozenProviderCopyIds(jobId)).toEqual(expectedIds.sort());
  await expect(deleteAgentAndMediaParentsDirectly(roomId)).rejects.toThrow(/provider_processing/);
  await proveOnlyProviderCopy(jobId, expectedIds[0]);
  expect(await deletionReceipt(jobId)).toBeNull();
});

it("freezes every claimable or running media job and bounded write fence by room", async () => {
  const { asset, processJob, reconcileJob, retryableProcessJob, writeFence } = await seedRoomScopedMediaJobs(roomId, {
    processStatus: "queued", reconcileStatus: "running",
    secondProcessStatus: "retryable", writeFenceState: "uncertain"
  });
  for (const job of [processJob, reconcileJob, retryableProcessJob]) {
    expect(job).toMatchObject({
      roomId, sourceEventId: null, correlationId: asset.promotionCorrelationId,
      analyticsOrderSeq: null, analyticsOrderKind: null
    });
  }
  const { deletionJobId } = (await teacherClient.delete(`/v1/rooms/${roomId}`)).json();
  expect((await frozenMediaJobIds(deletionJobId)).sort())
    .toEqual([processJob.jobId, reconcileJob.jobId, retryableProcessJob.jobId].sort());
  expect(await frozenMediaWriteFenceIds(deletionJobId)).toEqual([writeFence.writeFenceId]);
  expect(await frozenWriteNotAfter(deletionJobId, writeFence.writeFenceId))
    .toEqual(writeFence.writeNotAfter);
  expect(await mediaJobStatuses([processJob.jobId, reconcileJob.jobId, retryableProcessJob.jobId]))
    .toEqual(["cancelled", "cancelled", "cancelled"]);
});

it("keeps the final delete-surface claim alive across room deletion", async () => {
  const { deletionJobId, finalSurface } = await seedDeletionReadyForFinalSurface(roomId);
  const job = await claimDeleteSurfaceJob(deletionJobId, finalSurface);
  expect(job).toMatchObject({
    jobType: "room.delete-surface.v1", roomId: null, sourceEventId: null,
    payload: { deletionJobId, surface: finalSurface },
    dedupeKey: `room.delete-surface.v1:${deletionJobId}:${finalSurface}`,
    correlationId: await deletionCorrelation(deletionJobId),
    analyticsOrderSeq: null, analyticsOrderKind: null, status: "running"
  });
  await completeFinalSurfaceWithClaim(job);
  expect(await roomExists(roomId)).toBe(false);
  expect(await deletionReceipt(deletionJobId)).not.toBeNull();
  expect(await rawWorkerJob(job.jobId)).toMatchObject({ roomId: null, status: "running" });
  await canonicalJobStore.succeed(job);
  expect(await rawWorkerJob(job.jobId)).toMatchObject({
    status: "succeeded", claimToken: null, lockedAt: null, lockedBy: null
  });
});

it("waits out frozen signed PUTs and fences derivative writes before receipt", async () => {
  const grant = await issueSignedPut(roomId);
  const derivative = blockMediaWorkerBeforeDerivativeWrite(roomId);
  const { deletionJobId } = (await teacherClient.delete(`/v1/rooms/${roomId}`)).json();
  await passInitialMediaSweep(deletionJobId);
  await putThroughAlreadyIssuedUrl(grant.uploadUrl, cleanImageBytes);
  derivative.release();
  expect(await deletionReceipt(deletionJobId)).toBeNull();
  clock.advanceTo(grant.writeNotAfter);
  await runDeletionUntilSettled(deletionJobId);
  expect(await mediaLifecycleStore.listRoomPrefix(roomId, testStoreControl(clock, 2_000))).toEqual([]);
  expect(await deletionReceipt(deletionJobId)).not.toBeNull();
});

it("freezes the real post-delay signature deadline rather than a pre-sign estimate", async () => {
  fakeStore.blockPresign();
  const grantPending = issueSignedPut(roomId);
  const deletionPending = teacherClient.delete(`/v1/rooms/${roomId}`);
  clock.advance(45_000);
  fakeStore.releasePresign();
  const grant = await grantPending;
  const { deletionJobId } = (await deletionPending).json();
  expect(await frozenGrantDeadline(deletionJobId, grant.grantId)).toEqual(grant.writeNotAfter);
  clock.advanceTo(oldPreSignEstimate);
  await putThroughAlreadyIssuedUrl(grant.uploadUrl, cleanImageBytes);
  expect(await deletionReceipt(deletionJobId)).toBeNull();
  clock.advanceTo(grant.writeNotAfter);
  await runDeletionUntilSettled(deletionJobId);
  expect(await mediaLifecycleStore.headAbsent(grant.stagingKey, testStoreControl(clock, 2_000))).toBe(true);
});

it("freezes the later promotion settlement bound after a timed-out copy", async () => {
  const grant = await issueUploadedStagingObject(roomId);
  const copy = fakeStore.blockConditionalCopyPastClientAbort();
  const finalizePending = finalizeGrant(grant.grantId);
  const deletionPending = teacherClient.delete(`/v1/rooms/${roomId}`);
  clock.advanceTo(copy.clientDeadline);
  await expect(finalizePending).rejects.toMatchObject({ code: "MEDIA_STORE_COPY_TIMEOUT" });
  expect(copy.persistedPromotionWriteNotAfter.getTime()).toBeGreaterThan(grant.writeNotAfter.getTime());
  await runGrantJanitorOnce();
  expect(await uploadGrantExists(grant.grantId)).toBe(true);
  const { deletionJobId } = (await deletionPending).json();
  expect(await frozenGrantDeadline(deletionJobId, grant.grantId))
    .toEqual(copy.persistedPromotionWriteNotAfter);
  copy.commitRemoteBeforeSettlementBound();
  expect(await deletionReceipt(deletionJobId)).toBeNull();
  clock.advanceTo(copy.persistedPromotionWriteNotAfter);
  await runDeletionUntilSettled(deletionJobId);
  expect(await mediaLifecycleStore.headAbsent(grant.immutableKey, testStoreControl(clock, 2_000))).toBe(true);
});

it("evicts established sockets and withholds queued core events after deletion starts", async () => {
  const ws = await connectStudentAndHello(roomId);
  const unpublished = await appendButDoNotPublishCoreEvent(roomId);
  await teacherClient.delete(`/v1/rooms/${roomId}`);
  await pumpCoreOutboxOnce();
  expect(await framesForEvent(ws, unpublished.eventId)).toEqual([]);
  expect(await closeCode(ws)).toBe(4410);
});
```

`deletion-lifecycle.v1.json` is the closed wire authority for `DeleteRoomRequest`, `DeleteRoomAccepted`, `DeletionStatus` and `DeletionReceipt`. `DELETE routes.rooms.delete(roomId)` accepts only the generated typed confirmation and returns `202 {deletionJobId,status:"queued"}`. Teacher-only `GET routes.deletions.get(deletionJobId)` returns queued/running/retryable/dead status or completed status plus the content-free receipt; teacher-only `GET routes.deletions.forRoom(roomId)` returns the same active/completed job locator so a reload resumes polling without a second DELETE. The server resolves the latter through the salted room reference even after `room_id` becomes null. Neither route returns room content or another teacher's job. Generate these types and reject any extra `roomId`, content, URL, token, pseudonym or free-text field in a receipt.

Deletion initiation is server-idempotent, not merely button-disabled. In one room lock/transaction the service returns the existing unfinished job for the same owning teacher or inserts one row; the partial unique index is the final concurrent-tab guard. A lost `202`, browser retry, simultaneous tabs and the retention scheduler all converge on the same `deletionJobId`. `dead` remains the same recoverable/operational job rather than allowing a second saga; only an explicit administrator retry changes its state. Tests issue 20 concurrent DELETEs, drop the first response, restart the server and assert one job ID, one surface-work set, one room teardown and one receipt.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://learning-orbit.local/schemas/deletion-lifecycle.v1.json",
  "title": "DeletionLifecycle",
  "oneOf": [
    { "$ref": "#/$defs/DeleteRoomRequest" },
    { "$ref": "#/$defs/DeleteRoomAccepted" },
    { "$ref": "#/$defs/DeletionStatus" }
  ],
  "$defs": {
    "DeleteRoomRequest": {
      "type": "object", "additionalProperties": false,
      "required": ["confirmation"],
      "properties": { "confirmation": { "type": "string", "minLength": 43, "maxLength": 43 } }
    },
    "DeletionReceipt": {
      "type": "object", "additionalProperties": false,
      "required": ["receiptVersion", "completedAt", "surfacesVerified"],
      "properties": {
        "receiptVersion": { "const": 1 },
        "completedAt": { "type": "string", "format": "date-time" },
        "surfacesVerified": { "type": "array", "minItems": 8, "maxItems": 8, "uniqueItems": true, "items": { "type": "string", "enum": ["events", "media", "derivatives", "artifacts", "projections", "agent_runs", "caches", "provider_copies"] } }
      }
    },
    "DeleteRoomAccepted": {
      "type": "object", "additionalProperties": false,
      "required": ["deletionJobId", "status"],
      "properties": { "deletionJobId": { "type": "string", "format": "uuid" }, "status": { "const": "queued" } }
    },
    "DeletionStatus": {
      "oneOf": [
        {
          "type": "object", "additionalProperties": false,
          "required": ["deletionJobId", "status", "nextPollAfterMs", "failureCode"],
          "properties": {
            "deletionJobId": { "type": "string", "format": "uuid" },
            "status": { "enum": ["queued", "running", "retryable", "dead"] },
            "nextPollAfterMs": { "type": ["integer", "null"], "minimum": 250, "maximum": 30000 },
            "failureCode": { "type": ["string", "null"], "maxLength": 100 }
          }
        },
        {
          "type": "object", "additionalProperties": false,
          "required": ["deletionJobId", "status", "receipt"],
          "properties": {
            "deletionJobId": { "type": "string", "format": "uuid" },
            "status": { "const": "completed" },
            "receipt": { "$ref": "#/$defs/DeletionReceipt" }
          }
        }
      ]
    }
  }
}
```

The deterministic generator emits `DeleteRoomRequest`, `DeleteRoomAccepted`, `DeletionStatus` and `DeletionReceipt` from `packages/contracts/src/generated/deletion-lifecycle.v1.ts`; the schema test compiles each branch, the server requires `confirmation === "DELETE " + roomId`, and the completed branch alone can carry `receipt`.

Freeze the Python→TypeScript media-surface bridge in the same task:

```json
{
  "$schema":"https://json-schema.org/draft/2020-12/schema",
  "$id":"https://learning-orbit.local/schemas/lifecycle-internal-media-surface.v1.json",
  "title":"LifecycleInternalMediaSurfaceContract",
  "x-learning-orbit-python-ingress":true,
  "type":"object","additionalProperties":false,"maxProperties":0,
  "$defs":{
    "Request":{"type":"object","additionalProperties":false,
      "required":["jobId","jobType","roomId","sourceEventId","dedupeKey","correlationId","claimGeneration","claimToken","workerId","targetRoomId","operationId","mode","surface","policyVersion","deadline"],
      "properties":{
        "jobId":{"type":"string","format":"uuid"},
        "jobType":{"enum":["retention.expire-surface.v1","room.delete-surface.v1"]},
        "roomId":{"type":"null"},"sourceEventId":{"type":"null"},
        "dedupeKey":{"type":"string","minLength":1,"maxLength":255},
        "correlationId":{"type":"string","format":"uuid"},
        "claimGeneration":{"type":"string","pattern":"^[1-9][0-9]{0,18}$"},
        "claimToken":{"type":"string","format":"uuid"},
        "workerId":{"type":"string","minLength":1,"maxLength":128},
        "targetRoomId":{"type":"string","format":"uuid"},
        "operationId":{"type":"string","format":"uuid"},
        "mode":{"enum":["retention_expiry","teacher_deletion"]},
        "surface":{"const":"media"},
        "policyVersion":{"type":["string","null"],"maxLength":160},
        "deadline":{"type":["string","null"],"format":"date-time"}
      },
      "allOf":[
        {"if":{"properties":{"mode":{"const":"retention_expiry"}}},"then":{"properties":{"jobType":{"const":"retention.expire-surface.v1"},"policyVersion":{"type":"string","minLength":1},"deadline":{"type":"string","format":"date-time"}}}},
        {"if":{"properties":{"mode":{"const":"teacher_deletion"}}},"then":{"properties":{"jobType":{"const":"room.delete-surface.v1"},"policyVersion":{"type":"null"},"deadline":{"type":"null"}}}}
      ]
    },
    "Response":{"oneOf":[
      {"type":"object","additionalProperties":false,"required":["status","code"],"properties":{"status":{"const":"completed"},"code":{"const":"MEDIA_SURFACE_UNREADABLE"}}},
      {"type":"object","additionalProperties":false,"required":["status","code","notBefore"],"properties":{"status":{"const":"retryable"},"code":{"enum":["MEDIA_UPLOAD_GRANTS_NOT_QUIESCENT","MEDIA_WRITES_NOT_QUIESCENT","MEDIA_STORE_RETRYABLE"]},"notBefore":{"type":"string","format":"date-time"}}},
      {"type":"object","additionalProperties":false,"required":["status","code"],"properties":{"status":{"const":"rejected"},"code":{"enum":["SERVICE_ASSERTION_INVALID","JOB_CLAIM_STALE","LIFECYCLE_JOB_IDENTITY_INVALID","ROOM_LIFECYCLE_STATE_INVALID"]}}}
    ]}
  }
}
```

Route `internal.lifecycle.mediaSurface` validates the generated request and Plan 01 service assertion. The persisted Worker claim is intentionally room/source null; `targetRoomId` is separate and is derived, never trusted. Both modes require `operationId=raw payload.deletionJobId` and the same locked `deletion_job`; retention additionally requires exact payload room/policy/deadline, while teacher deletion requires its exact frozen room/surface. The route takes the canonical target-room session lock for bounded store I/O, uses short pre/final transactions that lock room/manifest/media rows before the exact Worker job, and invokes Plan 02's TypeScript-owned hook with the durable `MediaDeletionManifestPort`. The terminal proof transaction inserts `LIFECYCLE_SURFACE_COMPLETED`. The Python lifecycle handler uses Plan 01's signer/client and generated parser. Tests reject every tuple/mode/payload mismatch, stale claim and response loss, and prove retention plus teacher modes each produce one store proof/marker without duplicating TypeScript deletion logic in Python.

- [ ] **Step 2: Run and identify remaining readable surfaces**

Run: `cd learning-orbit && pnpm vitest run apps/server/test/lifecycle/room-deletion-closure.test.ts`  
Expected: FAIL with a structured list of remaining surfaces.

- [ ] **Step 3: Implement policy-driven expiry and deletion receipts**

```ts
export type RetentionPolicy = {
  roomEventsDays: number;
  rawMediaDays: number;
  derivedArtifactsDays: number;
  projectionsDays: number;
  agentRunsDays: number;
  providerCopiesDays: number;
  backupsDays: number;
  auditMetadataDays: number;
};

export function assertPilotRetentionPolicy(policy: RetentionPolicy): void {
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`INVALID_RETENTION_${key.toUpperCase()}`);
  }
  if (policy.roomEventsDays < Math.max(policy.derivedArtifactsDays, policy.projectionsDays, policy.agentRunsDays)) {
    throw new Error("RETENTION_PARENT_EXPIRES_BEFORE_DEPENDENT");
  }
  if (policy.rawMediaDays < policy.derivedArtifactsDays) {
    throw new Error("RETENTION_MEDIA_EXPIRES_BEFORE_DERIVATIVE");
  }
  if (policy.providerCopiesDays > Math.min(policy.rawMediaDays, policy.derivedArtifactsDays, policy.agentRunsDays)) {
    throw new Error("RETENTION_PROVIDER_COPY_OUTLIVES_SOURCE");
  }
}

export function makeDeletionReceipt(job: CompletedDeletionJob) {
  const required = ["agent_runs", "artifacts", "caches", "derivatives", "events", "media", "projections", "provider_copies"] as const;
  const actual = [...new Set(job.surfacesVerified)].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) throw new Error("DELETION_SURFACES_INCOMPLETE");
  return { completedAt: job.completedAt, surfacesVerified: actual, receiptVersion: 1 };
}
```

The server refuses to create a pilot room unless an approved school policy supplies all required retention classes and passes both the database and TypeScript parent/dependent ordering checks above. These inequalities prevent an event or raw-media parent from cascading away while an approved derivative, projection or Agent-run retention window is still open. Provider copies and caches may never outlive the shortest applicable source; backups and content-free audit metadata remain separately governed classes. The eight receipt surfaces mean current application/provider copies and future online reads only. Backups use a separately audited expiry/key-destruction record tied to the retention policy; the UI labels the result “線上資料面刪除收據” and never promises immediate row-level removal from immutable backups.

`retention-scheduler.ts` uses an injected clock and scans only closed rooms with a still-bound immutable policy. At the first due surface it atomically creates or reuses one deterministic `deletion_job(request_kind='retention')` for `(roomId,policyVersion)`, freezes its manifests, and enqueues deduplicated `retention.expire-surface.v1` jobs keyed by `roomId + policyVersion + surface`; every payload carries that same `deletionJobId`. Their `correlation_id` is a documented UUIDv5 of the closed tuple and remains stable across scans/retries. Event, raw-media, derived-artifact, projection, Agent-run, provider-copy, backup and audit deadlines are calculated independently from `closed_at`. The derived-artifact surface explicitly includes `derived_text_artifact`, immutable correction lineage and teacher-only `analytics_review_detail`; the projection surface includes snapshots, patches, heads and promotion rows. Cache entries expire no later than the shortest retention deadline of their source class. Provider-copy deadlines run first when equal. Before removing a provider-processing row, the provider-copy retention owner must insert the matching `provider_copy_closure` proof in the same transaction; Agent-run/media/artifact handlers return retryable `PROVIDER_COPY_DEPENDENCY_PENDING` until either the processing row is closed this way or an exact closure exists. Plan 04's `ON DELETE RESTRICT` FKs are the database backstop. The worker records a per-surface probe before marking a job succeeded, requeues retryable failures with bounded backoff, and raises an operational alert at `dead`; a missed scan is safe because the next scan derives deadlines from durable room/policy state. Automatic expiry never issues its online deletion receipt until every online surface has become unreadable, and a teacher-requested saga may accelerate online deletion but cannot extend the approved expiry. Backup expiry/key destruction is verified separately and never folded into the eight-surface online receipt.

The only new job types are `retention.expire-surface.v1` with closed payload `{deletionJobId,roomId,policyVersion,surface,deadline}` and `room.delete-surface.v1` with closed payload `{deletionJobId,surface}`. Both are source-less, non-analytics and `worker_job.room_id=NULL` so a current job survives room cascade. Raw rows have exact payload/dedupe/server correlation/order-null shape, and the server/Worker require the payload deletion ID to resolve the same frozen room/manifest. Adapters validate full claim before external delete/probe and in every proof transaction. The transaction that makes a surface terminal—ordinary retention proof or final room deletion/receipt—also inserts `complete_business(...,"LIFECYCLE_SURFACE_COMPLETED")`; partial work inserts none. After a final-transaction crash, the claim protocol sees the marker and marks the NULL-room job succeeded without dispatch, so it never needs a vanished room ID. A defensively invoked adapter with `deletion_job.room_id IS NULL` returns idempotent completed only after locking and verifying completed deletion job, full manifests, valid receipt, exact job correlation/dedupe and matching completion marker; otherwise it fails closed with no room I/O. Tests cover crash-after-receipt-before-succeed, max attempt, old-token remote completion and one proof/receipt.

The deletion-request transaction takes the shared room lock, sets deletion-in-progress and rejects new writes/jobs. It cancels every room-scoped `queued|retryable|running` job selected by `worker_job.room_id=roomId`—core/media/analytics/Agent/multimodal—while leaving only the deliberate NULL-room lifecycle jobs active; every cancelled row clears `claim_token/locked_at/locked_by`. It revokes grants and freezes media assets, effective grant bounds, media job IDs, active/uncertain write fences and the union of (a) current provider-processing IDs and (b) prior `provider_copy_closure` rows with the same salted room reference. Each provider item freezes `providerId,providerManifestSha256,lifecycleMode,scopeHash,authorityId`; an existing exact, non-invalidated closure makes it immediately proven, while a current row remains pending. A closure with a conflicting tuple or retroactively revoked authority fails the freeze and cannot reduce the expected count. Tests seed each family/status, cancel without violating the running CHECK, then resume old tokens and require zero event/media/projection/provider/artifact/replay mutations. The delayed-copy fixture proves reconcile/janitor/deletion share one DB effective bound. Final exact-key/prefix sweep waits for signed PUT, conditional copy and Python fence settlement; receipt uses frozen/proven counts.

Plan 06 implements the production adapters for Plan 02 `RoomWriteGate` and `MediaDeletionManifestPort` against the durable deletion tombstone/manifests, then reruns the exact Gate 2 hook contract plus the full room saga. No other module reads a test manifest in pilot mode.

`provider_copy_lifecycle.py` is the sole implementation of the `provider_copies` surface. Provider handlers and both lifecycle owners use Plan 01's canonical room session lock and global row/job order. The winning owner runs a short pre-call transaction that locks room, processing record and current claim, validates deletion/retention authority, then performs the bounded remote action while retaining only the canonical session lock on its dedicated connection. Its final transaction re-locks room/processing/job, revalidates the same token, inserts the exact `provider_copy_closure`, removes `provider_processing_artifact` and `provider_processing_record`, and marks its own item/proof terminal atomically. `delete_and_probe` requires the reviewed linearizable tombstone and `probe == unreadable`; unknown/resurrection/transient states remain retryable. `no_persistent_copy_attested` requires current exact-scope signed authority plus zero application copies. A reclaimed old attempt cannot insert closure, remove links, certify unreadability or issue a receipt, even when its idempotent remote delete completes.

If retention wins first, teacher deletion waits for the room lock and then consumes the matching closure without a second provider call. If teacher deletion wins first, retention waits and then completes from the same closure. `INSERT ... ON CONFLICT(processing_record_id) DO NOTHING` is followed by a locked equality check across room ref/provider/manifest/mode/scope/outcome; it is never a blind success. Tests run both winner orders, crash after closure before job success, and a stale-token pause after remote unreadability. They require one provider proof, one closure, no orphan locator/link, both lifecycle jobs idempotently terminal, and no early receipt. The closure remains as content-free audit metadata until the approved audit deadline and is purged only when no processing row and no unfinished deletion item references its identity; the data inventory records this retention/export/deletion behavior. No locator or closure token/hash appears in manifests, APIs, logs, exports or receipts.

Deletion is a fail-closed saga: the teacher request first creates `deletion_job`, revokes student sessions and makes every ordinary room read/command return `410 ROOM_DELETION_IN_PROGRESS`. After that transaction commits it calls Plan 01's idempotent `RoomHub.evictRoom(roomId,4410)`; independently, every core/projection/status broadcast reauthorizes against the durable deletion tombstone, so a queued outbox frame cannot slip through the commit→eviction interval. The room row remains while dependency-ordered workers quiesce signed uploads/media writes, delete provider copies, then delete private originals, Agent runs/artifacts, derivatives, teacher review detail and caches. During this interval only `deletion_status_read` may resolve the owner through the salted reference and return a content-free locator/status. Only after every frozen manifest count equals its proven count and every configured surface proof succeeds—including all signed-upload `writeNotAfter` bounds, final media sweeps, explicit remote unreadability for `delete_and_probe`, or current exact-scope signed no-persistence authority plus zero application copies for that mode—does one transaction delete `classroom_room` (allowing the remaining explicit cascades from Plans 01–04), preserve the now room-ID-free deletion job, and insert the content-free receipt. A zero media/provider count is accepted only from the manifest frozen before parent deletion. The receipt means “all online copies covered by the approved storage/provider manifests are no longer readable”; it does not claim invisible backups beyond the approved contract. A partial failure stays retryable/dead with an operational alert and never issues a success receipt.

- [ ] **Step 4: Constrain exports**

Teacher export contains authorized room events, approved artifacts, projections and provenance but excludes provider secrets, signed URLs, hidden reasoning, internal risk scores, and other rooms. A research-purpose export is explicitly deferred from this controlled-pilot implementation; no research route, hidden flag or reuse of the teacher export may be added without a separate approved purpose record, pseudonymization design and implementation plan.

Freeze `routes.rooms.export(roomId, format)` as `GET /v1/rooms/:roomId/export?format=json|csv`. The server derives the teacher from the cookie, validates room ownership and active retention policy, streams from a bounded snapshot transaction, supplies a sanitized `Content-Disposition` filename, and records a content-free audit event. Students and cross-room teachers receive no export. The web treats the body as a Blob, uses the server filename, revokes the local object URL, and never logs or caches the file.

- [ ] **Step 5: Run lifecycle tests and commit**

Run: `cd learning-orbit && pnpm contracts:generate && pnpm test:contracts && pnpm vitest run apps/server/test/lifecycle && .venv/bin/python -m unittest services/worker/tests/test_lifecycle.py services/worker/tests/test_lifecycle_media_contract.py services/worker/tests/test_provider_copy_lifecycle.py services/worker/tests/test_lifecycle_handler_registration.py -v`  
Expected: PASS; deletion/media-bridge generated types and both manifests are current; the signed Python→TypeScript media-surface round trip passes for retention and teacher modes. Deterministic-clock tests prove every policy inequality and deadline, restart-safe deduplication, both provider-closure owner orders, delete/already-absent/readable/unreadable/unknown provider outcomes, unlinked pre-call records, no-persistence authority expiry/revocation, backup retry/dead behavior, deletion-status recovery and no early receipt. The data inventory maps every table/object/cache/log class—including `worker_job_completion`, `provider_copy_closure`, provider-processing/link, review detail and promotion—to owner, purpose, retention, export and deletion behavior. Completion rows are content-free, expose neither raw nor hashed token through API/log/export/receipt, and are transactionally removed when normal or stale-recovered success clears the lease; room cascade is only a fallback.  
Commit:

```bash
git add packages/contracts services/worker/src/learning_orbit_worker/generated apps/server/src/app.ts apps/server/src/routes.ts apps/server/src/modules/lifecycle apps/server/src/modules/media/media-deletion-manifest-port.ts apps/server/src/modules/media/room-write-gate.ts apps/server/test/lifecycle services/worker/src/learning_orbit_worker/lifecycle.py services/worker/src/learning_orbit_worker/provider_copy_lifecycle.py services/worker/src/learning_orbit_worker/main.py services/worker/tests/test_lifecycle.py services/worker/tests/test_lifecycle_media_contract.py services/worker/tests/test_provider_copy_lifecycle.py services/worker/tests/test_lifecycle_handler_registration.py docs/privacy/data-inventory.md
git commit -m "feat(privacy): prove retention export and deletion closure"
```

### Task 5: Establish pilot performance and backpressure evidence

**Files:**
- Create: `learning-orbit/tests/load/classroom-pilot.js`
- Create: `learning-orbit/tests/load/assert-pilot-results.ts`
- Create: `learning-orbit/tests/load/fixtures/failing-pilot.json`
- Create: `learning-orbit/scripts/run-k6-pilot.mjs`
- Create: `learning-orbit/docs/performance/pilot-targets.md`
- Modify: `learning-orbit/infra/images.lock.json`
- Modify: `learning-orbit/package.json`
- Modify: `learning-orbit/apps/server/src/modules/realtime/backpressure.ts`

- [ ] **Step 1: Define measured pilot targets**

Record these as engineering admission thresholds on the declared reference environment, not as public production SLA:

- 10 rooms × 4 students + 1 teacher, 50 WebSocket clients.
- 1 text command per student every 8–20 seconds with deterministic jitter.
- 95% committed text acknowledgements ≤ 750 ms; 99% ≤ 1,500 ms.
- Zero lost or duplicate committed events after reconnect.
- Outbox p95 lag ≤ 1 second.
- Deterministic ECHO/TRACE projection p95 lag ≤ 3 seconds, reported separately from ASR/OCR/LLM.
- A slow client cannot grow the server send buffer without bound; it receives `snapshot_required` or a controlled close.

- [ ] **Step 2: Write the result assertion before the scenario**

```ts
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(report.committedEventLoss, 0);
assert.equal(report.duplicateCommittedEvents, 0);
assert.ok(report.textAckMs.p95 <= 750);
assert.ok(report.textAckMs.p99 <= 1500);
assert.ok(report.outboxLagMs.p95 <= 1000);
assert.ok(report.deterministicProjectionLagMs.p95 <= 3000);
```

Write `fixtures/failing-pilot.json` with one lost committed event and over-threshold latency, then run the assertion before the scenario exists:

Run: `cd learning-orbit && pnpm tsx tests/load/assert-pilot-results.ts tests/load/fixtures/failing-pilot.json`  
Expected: FAIL on `committedEventLoss === 0`; changing the fixture or weakening the assertion to manufacture green is forbidden.

- [ ] **Step 3: Implement deterministic load identities and room setup**

`classroom-pilot.js` creates rooms through the test administration API, joins exactly four seats and one teacher, sends stable command IDs, forces one reconnect per client, records server sequence gaps, and does not send real student text or media.

Extend the reviewed image lock with the official `grafana/k6:2.2.0` image resolved to an immutable digest. `run-k6-pilot.mjs` reads and validates that locked ref, uses `spawn` with an argument array (no shell interpolation) to run the container on the disposable pilot network, mounts only `tests/load/` plus the output directory, passes synthetic endpoint configuration through an allowlist, and writes `test-results/load/pilot.json`. Root `load:pilot` invokes this script; mutable tags, host credentials and real classroom fixtures fail before Docker starts.

- [ ] **Step 4: Implement bounded WebSocket backpressure**

```ts
export function enforceBackpressure(socket: WebSocket, thresholds = { warn: 256_000, close: 1_000_000 }): "ok" | "warn" | "close" {
  if (socket.bufferedAmount >= thresholds.close) { socket.close(1013, "snapshot required"); return "close"; }
  if (socket.bufferedAmount >= thresholds.warn) return "warn";
  return "ok";
}
```

- [ ] **Step 5: Run load admission and commit**

Run: `cd learning-orbit && pnpm load:pilot && pnpm tsx tests/load/assert-pilot-results.ts test-results/load/pilot.json`  
Expected: PASS on the recorded reference hardware; report separately lists ingest, outbox, ECHO, TRACE, media and model stages.  
Commit:

```bash
git add tests/load scripts/run-k6-pilot.mjs infra/images.lock.json package.json docs/performance apps/server/src/modules/realtime/backpressure.ts
git commit -m "test(performance): establish controlled pilot admission targets"
```

### Task 6: Close responsive, keyboard, screen-reader, and reduced-motion gates

**Files:**
- Create: `learning-orbit/tests/e2e/accessibility.spec.ts`
- Create: `learning-orbit/tests/e2e/visual-regression.spec.ts`
- Create: `learning-orbit/tests/e2e/sna-geometry.spec.ts`
- Create: `learning-orbit/apps/web/src/accessibility/live-region-queue.test.ts`

- [ ] **Step 1: Port the prototype's five-view matrix**

```ts
for (const viewport of [
  { width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 },
  { width: 390, height: 844 }, { width: 320, height: 568 }
]) {
  test(`no overflow or unreachable controls at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openFixtureRoom(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await expect(page.getByRole("button", { name: "發送" })).toBeVisible();
  });
}
```

- [ ] **Step 2: Run and capture initial failures**

Run: `cd learning-orbit && pnpm playwright test tests/e2e/accessibility.spec.ts tests/e2e/visual-regression.spec.ts tests/e2e/sna-geometry.spec.ts`  
Expected: FAIL until Plan 05 is fully integrated.

- [ ] **Step 3: Measure SNA in final screen pixels**

At desktop and mobile widths, assert each incident edge has a unique source/target port, reciprocal dyads remain two complete directed lines, arrowheads are visible, and sampled fan curves maintain at least 8 final screen pixels of near-node separation after `getScreenCTM()` conversion. Capture failure screenshots with edge IDs and sampled coordinates.

- [ ] **Step 4: Exercise assistive behavior**

Run axe, keyboard-only journeys, 200%/400% zoom, long classroom aliases, long provenance, image alt entry, MediaRecorder denial, graph/list semantic parity, both server SNA windows, SNA presentation pause/resume, focus return after dialogs, live-region batching, and `prefers-reduced-motion`. At every viewport, assert the SNA panel, semantic list and each metric group expose the exact generated `TRACE_STUDENT_INTERPRETATION_ZH_HANT` sentence; a shortened claim ceiling fails. Reduced motion must stop JS timeline autoplay, fake progress timers, and smooth scrolling in addition to CSS animation; it must not auto-resume a paused SNA. Verify pause holds only the displayed SNA version while validated live state, chat and concept continue, and resume adopts the latest real version without a fake cursor. A synthetic room journey also collects `layout-shift` entries and requires CLS below `0.1`; attachments, Agent state, and both graph panels reserve space before asynchronous content arrives. This is a UI admission threshold, not a production SLA.

- [ ] **Step 5: Approve snapshots deliberately and commit**

Run: `cd learning-orbit && pnpm playwright test tests/e2e/accessibility.spec.ts tests/e2e/visual-regression.spec.ts tests/e2e/sna-geometry.spec.ts`  
Expected: PASS with reviewed images in `tests/e2e/__screenshots__/`; no snapshot is updated merely to silence a failure.  
Commit:

```bash
git add tests/e2e apps/web/src/accessibility
git commit -m "test(a11y): close responsive and graph accessibility gates"
```

### Task 7: Freeze and rehearse the teacher-shadow protocol before student exposure

**Files:**
- Create: `learning-orbit/docs/pilot/shadow-protocol.md`
- Create: `learning-orbit/docs/pilot/incident-playbook.md`
- Modify: `learning-orbit/docs/pilot/trusted-authority-configuration.md`
- Create: `learning-orbit/docs/pilot/{engineering-evidence,external-authorization,human-shadow,promotion}-template.md`
- Create: `learning-orbit/docs/pilot/evidence-fixture.yaml`
- Create: `learning-orbit/packages/contracts/schemas/pilot-authority-record.v1.json`
- Generate: `learning-orbit/packages/contracts/src/generated/pilot-authority-record.v1.ts`
- Modify: `learning-orbit/packages/contracts/src/generated/manifest.json`
- Modify: `learning-orbit/services/worker/src/learning_orbit_worker/generated/manifest.json`
- Modify: `learning-orbit/packages/contracts/src/index.ts`
- Modify: `learning-orbit/packages/contracts/test/generated-ownership.test.ts`
- Modify: `learning-orbit/apps/server/src/modules/authorization/controlled-authority-verifier.ts`
- Modify: `learning-orbit/apps/server/src/modules/lifecycle/pilot-policy-import.ts`
- Modify: `learning-orbit/apps/server/src/modules/lifecycle/student-analytics-promotion.ts`
- Modify: `learning-orbit/package.json`
- Modify: `learning-orbit/pnpm-lock.yaml`
- Create: `learning-orbit/tests/pilot/assert-shadow-evidence.ts`
- Create: `learning-orbit/tests/pilot/assert-shadow-evidence.test.ts`
- Create: `learning-orbit/tests/pilot/authority-signature.test.ts`
- Create: `learning-orbit/tests/pilot/fixtures/{test-authority-private.jwk,test-authority-public.jwk,external-authorization.signed.json,human-shadow.signed.json,student-promotion.signed.json}`
- Create: `learning-orbit/scripts/verify-controlled-authority.ts`
- Modify: `learning-orbit/.gitignore`

- [ ] **Step 1: Separate engineering evidence from human authority**

Define four closed record kinds: `engineering_ready`, `external_authorization`, `human_shadow_completed` and `student_visible_promotion`. Only `engineering_ready` may be synthetic or generated by automation. External authorization requires approved school/ethics scope, participant information and consent path, named teacher supervisor, current retention policy ID, provider approval ID, permitted room/date range, incident contacts, feature flags, rollback owner, authorized signers and signed/expiry dates. Its provider scope names the exact provider/manifest hash, region, purpose, retention terms and Plan 04 remote-copy mode; `no_persistent_copy_attested` additionally names the signed authority record and its expiry, while `delete_and_probe` names the reviewed capability/port schema versions without exposing URLs or secrets. It states that analytics are not used for grades or discipline. Human shadow completion names the authorized record, actual supervisor, non-student shadow sessions, incident/deletion rehearsals and unresolved findings. Student-visible promotion is a separate signed decision with a narrow feature allowlist; it is never inferred from a completed shadow. The promotion record must explicitly name zero, one or both student projection keys; absence means chat-only operation.

- [ ] **Step 2: Define evaluation tasks and failure ceilings**

Teachers evaluate evidence lookup, unsupported edge detection, communication/uptake direction, transcript correction, Agent cancellation, stale/rebuilding interpretation, and data deletion. Record unsupported-edge rate, evidence coverage, correction rate, abstention, misunderstanding reports, safety holds, accessibility failures, and incident response time; do not select automatic-publish thresholds after viewing the pilot results.

- [ ] **Step 3: Add fail-closed validators for all four records**

First write `assert-shadow-evidence.test.ts` against the closed four-branch schema, signature verifier and chain rules while those generated types/validators are absent.

Run: `cd learning-orbit && pnpm vitest run tests/pilot/assert-shadow-evidence.test.ts tests/pilot/authority-signature.test.ts`  
Expected: FAIL because the closed authority schema, generated type and single controlled-authority verification path are not implemented yet.

```ts
const evidence = loadYaml(process.argv[2]);
assert.ok(["engineering_ready", "external_authorization", "human_shadow_completed", "student_visible_promotion"].includes(evidence.recordKind));
if (evidence.recordKind !== "engineering_ready") {
  assert.equal(evidence.synthetic, false);
  assert.ok(evidence.signedBy?.length > 0);
  assert.ok(evidence.signedAt && evidence.approvalReference);
  assert.ok(!String(process.argv[2]).includes("fixture"));
}
assert.equal(evidence.usedForGradesOrDiscipline, false);
```

Install exact root dependency `yaml@2.9.0` with `pnpm add -Dw yaml@2.9.0`; `assert-root-scripts.mjs` verifies the pin and lock. The parser uses YAML 1.2 core schema, rejects duplicate keys, aliases, custom tags, non-string map keys and non-finite numbers, caps source bytes/nesting/collection counts, and immediately validates the resulting plain object against the closed JSON Schema. The generated/validated `pilot-authority-record.v1.json` has a closed field set per `recordKind`, validates ISO dates and expiry, hashes safe external references, rejects placeholder/signature text, and enforces the chain `external_authorization → human_shadow_completed → student_visible_promotion`. Metadata such as `signedBy` is not itself proof. The CLI `verify-controlled-authority.ts` delegates to the one Task 3 verifier; it does not reimplement cryptography. That verifier canonicalizes the closed JSON payload, verifies its detached Ed25519 signature against an issuer/key allowlist loaded from a deployment-controlled path outside the repository, checks key validity/revocation and exact school/room/date/policy/provider/manifest/lifecycle-mode scope, and emits only `{recordKind,recordSha256,issuerId,keyId,signatureVerifiedAt,scopeHash}`. A provider invocation, no-persistence proof or delete/probe registry whose provider/manifest/lifecycle tuple differs from this verified scope fails closed. The committed JWK pair and signed records are unmistakably synthetic, scoped to issuer `learning-orbit-test-only`, and accepted only when both `NODE_ENV=test` and an explicit test-fixture flag are present; production startup and pilot assertions reject fixture paths/issuer/key IDs. `.gitignore` continues to exclude real trust configs and private keys while narrowly allowing only these named fixtures. Unknown issuers, repository-local production keys, changed payloads, expired records and revoked keys fail closed. Automation and agents may validate or report missing authority, but cannot author, sign or silently promote any of the final three records. A named human release custodian still compares the verified scope with the intended pilot and records the final admission decision in the controlled evidence store.

- [ ] **Step 4: Rehearse synthetically and stop before any human shadow**

The engineering team rehearses provider outage, unsafe Agent output, wrong-source concept edge, cross-room access attempt, worker backlog, lost WebSocket ack and room deletion using synthetic fixtures. That proves the playbook and validator only. This task does not conduct or sign a human shadow. It stops after the protocol/fixtures are committed; actual external authorization, non-student teacher shadow and promotion occur only in Task 8 Step 5 after all release/program tooling is committed and the candidate source commit is frozen.

- [ ] **Step 5: Validate and commit the protocol**

Run: `cd learning-orbit && pnpm contracts:generate && pnpm test:contracts && pnpm vitest run tests/pilot/assert-shadow-evidence.test.ts tests/pilot/authority-signature.test.ts && pnpm tsx tests/pilot/assert-shadow-evidence.ts docs/pilot/evidence-fixture.yaml --expect engineering_ready`  
Expected: PASS only for the synthetic `engineering_ready` schema fixture and isolated signature fixtures. The same fixture must FAIL when checked as `external_authorization`, `human_shadow_completed` or `student_visible_promotion`; no command claims a real authorization, shadow or pilot occurred, and no real authority record is created before the source freeze.  
Commit:

```bash
git add docs/pilot packages/contracts services/worker/src/learning_orbit_worker/generated/manifest.json apps/server/src/modules/authorization/controlled-authority-verifier.ts apps/server/src/modules/lifecycle/pilot-policy-import.ts apps/server/src/modules/lifecycle/student-analytics-promotion.ts tests/pilot scripts/verify-controlled-authority.ts package.json pnpm-lock.yaml .gitignore
git commit -m "docs(pilot): define supervised shadow admission protocol"
```

### Task 8: Produce a fail-closed pilot release evidence bundle

**Files:**
- Create: `learning-orbit/scripts/run-pilot-verification.mjs`
- Create: `learning-orbit/scripts/build-pilot-evidence.ts`
- Create: `learning-orbit/scripts/assert-engineering-ready.ts`
- Create: `learning-orbit/scripts/assert-pilot-ready.ts`
- Create: `learning-orbit/docs/release/pilot-checklist.md`
- Modify: `learning-orbit/package.json`
- Modify: `learning-orbit/scripts/assert-root-scripts.mjs`

- [ ] **Step 1: Write the readiness assertion before the builder**

```ts
const bundle = JSON.parse(readFileSync(process.argv[2], "utf8"));
const humanAuthority = loadAndValidateAuthorityArgs(process.argv.slice(3));
for (const gate of ["contracts", "realtime", "media", "analytics", "agentShadow", "studentTeacherUi", "security", "privacy", "a11y", "load", "shadowProtocol"]) {
  assert.equal(bundle.gates[gate].status, "pass", `${gate} is not pass`);
  assert.ok(bundle.gates[gate].evidenceSha256);
}
assert.equal(bundle.claims.learningOutcomeValidated, false);
assert.equal(bundle.claims.productionSlaProven, false);
for (const key of ["externalAuthorization", "humanShadowCompleted", "studentVisiblePromotion"]) {
  const gate = humanAuthority[key];
  assert.equal(gate.synthetic, false, `${key} cannot be synthetic`);
  assert.equal(gate.signatureVerified, true, `${key} signature is not verified`);
  assert.ok(gate.recordSha256 && gate.issuerId && gate.keyId && gate.scopeHash && gate.signatureVerifiedAt);
}
```

`assert-engineering-ready.ts` validates the same-commit technical gates and is allowed to consume synthetic reports. `assert-pilot-ready.ts` additionally requires the three linked, non-synthetic human-authority records, invokes the controlled signature verifier with `CONTROLLED_AUTHORITY_TRUST_CONFIG`, checks the verified scope/expiry/linkage and rejects fixture paths. A human release custodian must then countersign the exact bundle hash in the controlled store; this final custody action is not automated. The script never treats a green test, an agent-produced document, signature-shaped metadata or a self-declared checkbox as external authorization.

- [ ] **Step 2: Run against an empty bundle**

Run: `cd learning-orbit && pnpm tsx scripts/assert-pilot-ready.ts test-results/pilot-evidence.json`  
Expected: FAIL because technical gates and external human-authority records are absent. A later synthetic engineering bundle may pass `assert-engineering-ready.ts` but must still fail this command with `EXTERNAL_AUTHORITY_REQUIRED`.

- [ ] **Step 3: Build the bundle from fresh command outputs**

`build-pilot-evidence.ts` executes or imports the exact test reports, stores command, timestamp, exit code, environment fingerprint, source commit, schema hashes and report SHA-256, and refuses reports generated before the current commit. It does not include credentials, raw media, prompts, student text or private URLs.

Declare the root script exactly as `"verify:pilot": "node scripts/run-pilot-verification.mjs"` and extend `assert-root-scripts.mjs` accordingly. The runner uses `spawn` with argument arrays and `shell:false`, starts from a clean frozen commit, verifies Node/Python/pnpm/browser/image locks, then runs the named contract, realtime, media, analytics, Agent shadow, student/teacher UI, security, privacy, accessibility, load and shadow-protocol gates in a deterministic order. Each child command writes a content-free JSON report under `test-results/gates/<gate>.json` containing command argv, start/end, exit code, source commit, environment fingerprint and output SHA-256; it stops on first failure and never treats skipped tests as pass. The runner must invoke the already-committed `assert-program-contracts.ts --out test-results/program-contracts.json` as its final technical gate once the master sequence installs that script. It contains no human-authority paths and does not build the final bundle itself.

- [ ] **Step 4: Commit release tooling before collecting final evidence**

```bash
git add scripts/run-pilot-verification.mjs scripts/build-pilot-evidence.ts scripts/assert-engineering-ready.ts scripts/assert-pilot-ready.ts scripts/assert-root-scripts.mjs package.json docs/release
git commit -m "chore(release): add fail-closed pilot evidence gate"
```

Expected: source and release-tooling commit is frozen; `test-results/` remains ignored, and no evidence file has been staged.

- [ ] **Step 5: Freeze the final program gate, run technical evidence, then conduct authorized human admission**

Before this step, execute Master Task 7 Steps 1–3 to create and commit `assert-program-contracts.ts`; that is the final source/tooling commit. From this point onward, do not change or commit source, tests, schemas, docs or configuration. First run the complete technical story and admit engineering only:

Run:

```bash
cd learning-orbit
pnpm verify:pilot
pnpm tsx scripts/build-pilot-evidence.ts --out test-results/pilot-evidence.json
pnpm tsx scripts/assert-engineering-ready.ts test-results/pilot-evidence.json
```

Expected: the engineering assertion passes only when every upstream technical gate—including the now-committed program-contract report—is fresh on the frozen commit. If it fails, no human shadow occurs; fix source, recommit, and restart this entire step.

Only after engineering readiness, validate the independently controlled external-authorization signature/scope. A named teacher then runs the prescribed non-student shadow against this exact candidate and signs `human_shadow_completed`; evidence contains timestamps, safe IDs, actions, recovery, unresolved findings and owner sign-off—never raw classroom content. A separate authorized decision may then sign `student_visible_promotion` with a zero/one/two-key student analytics allowlist. The controlled importer writes only verified hashes/scope/allowed keys to `student_analytics_promotion`. Finally run:

```bash
cd learning-orbit
pnpm tsx scripts/assert-pilot-ready.ts test-results/pilot-evidence.json \
  --authority "$CONTROLLED_AUTHORIZATION_RECORD" \
  --shadow "$CONTROLLED_HUMAN_SHADOW_RECORD" \
  --promotion "$CONTROLLED_STUDENT_PROMOTION_RECORD" \
  --trust-config "$CONTROLLED_AUTHORITY_TRUST_CONFIG"
```

Expected: the pilot assertion passes only when separately controlled, current, mutually linked and cryptographically verified human records name the same candidate/bundle scope; the named release custodian still records the exact-bundle admission decision outside Git. Without those records it fails `EXTERNAL_AUTHORITY_REQUIRED` while the engineering result remains valid. Evidence files are retained by the controlled CI/pilot evidence store with their hashes; they are never staged merely to make a gate appear complete. No source commit occurs after technical evidence or human shadow; any source change invalidates the technical bundle and human candidate linkage and requires the full Step 5 sequence again.

## Gate 6 release criteria

- Fresh evidence proves event idempotency, committed-message zero loss, projection replay parity, media lifecycle closure and Agent cancellation under injected faults.
- Cross-room authorization, forged roles, CSRF/origin, provider callbacks, XSS, malicious media and evidence forgery tests pass.
- Logs/traces contain no student content, signed URLs, credentials, provider payloads or hidden reasoning.
- Retention is school-policy driven; export and deletion cover events, media, derivatives, artifacts, projections, Agent runs, caches and future reads.
- Five viewports, zoom, keyboard, screen reader, reduced motion and screen-pixel SNA routing pass.
- Pilot load passes on declared hardware without being labeled a production SLA.
- A valid external authorization precedes an actual teacher-only human shadow; a separate signed promotion follows it before any student-visible analytics.
- The evidence bundle continues to state `learningOutcomeValidated=false` and `productionSlaProven=false`.

## Non-goals

- This gate does not authorize multi-school production, public deployment, school SSO/SIS integration or outcome-effect claims.
- Passing automation cannot substitute for school/ethics approval, teacher supervision or human review of the shadow evidence.
