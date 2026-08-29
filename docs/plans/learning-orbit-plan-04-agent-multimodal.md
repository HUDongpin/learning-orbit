# Learning Orbit Nova Agent and Multimodal Shadow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a cancellable, auditable Socratic Nova Agent and versioned ASR/OCR/image-understanding artifact pipeline that initially operates in teacher-only shadow mode.

**Architecture:** Room commands create durable `agent_run` records and deduplicated `worker_job` rows; the Python worker calls provider ports, records versioned inputs/outputs and safety decisions, and submits final Agent messages through the Room Command API. Machine-derived text is never stored as if it were student-authored text, and no provider output reaches students until the applicable policy and teacher-review gates succeed.

**Tech Stack:** Fastify/TypeScript command API, PostgreSQL 18, Python 3.12 worker, JSON Schema 2020-12, provider ports with deterministic fixtures, HTTP streaming adapters, OpenTelemetry, Vitest, Python unittest, Playwright.

---

## Preconditions and authorization boundary

Complete Plans 01–03. Text chat, media, worker job claiming, projection replay, correction events, teacher role checks, and Plan 01's default-deny `EventPayloadRegistry` must pass. Before every task, run `cd learning-orbit && source .venv/bin/activate && python3.12 -c 'import sys; assert sys.version_info[:2] == (3, 12)'`; reuse Plan 01's uncommitted `.venv` and never hardcode a user-specific Python path. This plan does not authorize external model spend, credential use, or transfer of minor data to a provider: Gate 4 is proven with fixtures and local mock servers only. Neither the Task 4 model adapter nor Task 6 multimodal adapters may be enabled against an external provider until the bounded Plan 06 governance slice has imported the exact signed provider/manifest/lifecycle authority and the final external-authorization gate is current. That authority must name service, manifest hash, endpoint region, retention/data-processing terms, approved modalities, model identifiers, rate limits, remote-copy lifecycle mode, and secret variable names. Secret values never appear in Git, logs, tests, screenshots, or plan artifacts. Plan 03 `analytics.*` projection frames remain on the independent projection Outbox and are never registered as RoomEvent payloads here.

Before Plan 06, deletion/retention/provider-authorization states used by Agent race tests come only from explicitly test-scoped authority ports; non-test startup keeps external providers disabled and pilot admission false. Plan 06 installs the durable implementations and reruns the same cancel/provider-open/finalization fixtures. This plan may freeze those interfaces and fail-closed semantics, but it does not create a deletion tombstone, signed school authority or successful pilot gate early.

### Task 1: Freeze Agent, provider, safety, and derived-artifact contracts

**Files:**
- Create: `learning-orbit/packages/contracts/schemas/agent-internal-command.v1.json`
- Create: `learning-orbit/packages/contracts/schemas/agent-provider-health.v1.json`
- Generate: `learning-orbit/packages/contracts/src/generated/{agent-internal-command.v1,agent-provider-health.v1}.ts`
- Generate: `learning-orbit/services/worker/src/learning_orbit_worker/generated/{agent_internal_command_v1,agent_provider_health_v1}.py`
- Modify: `learning-orbit/packages/contracts/src/generated/manifest.json`
- Modify: `learning-orbit/services/worker/src/learning_orbit_worker/generated/manifest.json`
- Modify: `learning-orbit/packages/contracts/src/index.ts`
- Create: `learning-orbit/packages/contracts/schemas/agent-run.schema.json`
- Create: `learning-orbit/packages/contracts/schemas/moderation-decision.schema.json`
- Create: `learning-orbit/packages/contracts/schemas/agent-status.v1.json`
- Create: `learning-orbit/packages/contracts/schemas/agent-current-state.v1.json`
- Create: `learning-orbit/packages/contracts/schemas/agent-command.v1.json`
- Modify: `learning-orbit/packages/contracts/schemas/realtime-frame.v1.json`
- Modify: `learning-orbit/packages/contracts/src/routes.ts`
- Reference: `learning-orbit/packages/contracts/schemas/derived-text-artifact.v1.json` from Plan 03
- Reference: `learning-orbit/packages/contracts/schemas/analytics-review-command.v1.json` from Plan 03
- Create: `learning-orbit/packages/contracts/test/agent-contract.test.ts`
- Create: `learning-orbit/packages/contracts/test/agent-status-contract.test.ts`
- Create: `learning-orbit/infra/postgres/migrations/004_agent_multimodal.sql`
- Create: `learning-orbit/apps/server/src/modules/agent/provider-health-repository.ts`
- Create: `learning-orbit/apps/server/src/modules/agent/internal-provider-health-route.ts`
- Modify: `learning-orbit/apps/server/src/modules/security/service-assertion.ts`
- Modify: `learning-orbit/apps/server/src/app.ts`
- Create: `learning-orbit/apps/server/test/agent/agent-provider-health.test.ts`
- Modify: `learning-orbit/apps/server/test/security/service-assertion.test.ts`
- Create: `learning-orbit/services/worker/tests/test_agent_internal_contract.py`
- Create: `learning-orbit/services/worker/tests/test_provider_health_contract.py`

- [ ] **Step 1: Write failing separation tests**

```ts
it("does not allow ASR text to masquerade as a ChatEvent", () => {
  const artifact = {
    schemaVersion: 1,
    artifactId: "00000000-0000-4000-8000-000000000801",
    lineageId: "00000000-0000-4000-8000-000000000851",
    roomId: "00000000-0000-4000-8000-000000000010",
    eventId: "00000000-0000-4000-8000-000000000108",
    roomSeq: 8,
    sourceMediaId: "00000000-0000-4000-8000-000000000701",
    sourceModality: "audio",
    derivation: "asr",
    text: "分解者让养分回到土壤",
    normalizedTextSha256: "8c65a3a9fd16ef2e684ca82f725a4f3a921cfe46858f8ea9ea73ddf2f4f95d30",
    sourceConfidenceRaw: 0.82,
    sourceConfidenceCalibrated: null,
    provider: "fixture-asr",
    modelVersion: "fixture-asr-1",
    languageTag: "zh-Hant",
    spans: [],
    reviewStatus: "unreviewed",
    displayStatus: "teacher_shadow",
    warnings: [],
    supersedesArtifactId: null,
    active: true,
    createdAt: "2026-08-28T09:12:00Z"
  };
  expect(validateSchema("derived-text-artifact.v1", artifact)).toEqual([]);
  expect(() => parseCoreRoomEvent({ ...validRoomEnvelope, type: "message.added", payload: artifact }))
    .toThrow("INVALID_EVENT_PAYLOAD:message.added");
});

it("requires each moderation decision to carry a policy version and reason code", () => {
  expect(validateSchema("moderation-decision", { decision: "allow" }).length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run tests and confirm absent schemas**

Run: `cd learning-orbit && pnpm vitest run packages/contracts/test/agent-contract.test.ts`  
Expected: FAIL because the Agent-run and moderation-decision schemas are absent; the two referenced Plan 03 schemas already pass their own contract suite.

- [ ] **Step 3: Define the Agent lifecycle contract**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://learning-orbit.local/schemas/agent-run.schema.json",
  "title": "AgentRun",
  "type": "object",
  "additionalProperties": false,
  "required": ["agentRunId", "roomId", "state", "triggerEventId", "requestedByActorId", "requestedByRole", "inputFromRoomSeq", "inputThroughRoomSeq", "modelProvider", "modelId", "promptVersion", "policyVersion", "createdAt", "updatedAt"],
  "properties": {
    "agentRunId": { "type": "string", "format": "uuid" },
    "roomId": { "type": "string", "format": "uuid" },
    "state": { "enum": ["queued", "running", "streaming", "completed", "blocked_by_policy", "cancelled", "failed"] },
    "triggerEventId": { "type": "string", "format": "uuid" },
    "requestedByActorId": { "type": "string", "format": "uuid" },
    "requestedByRole": { "enum": ["student", "teacher"] },
    "inputFromRoomSeq": { "type": "integer", "minimum": 1 },
    "inputThroughRoomSeq": { "type": "integer", "minimum": 1 },
    "modelProvider": { "type": "string", "minLength": 1 },
    "modelId": { "type": "string", "minLength": 1 },
    "promptVersion": { "type": "string", "minLength": 1 },
    "policyVersion": { "type": "string", "minLength": 1 },
    "failureCode": { "type": ["string", "null"] },
    "createdAt": { "type": "string", "format": "date-time" },
    "updatedAt": { "type": "string", "format": "date-time" }
  }
}
```

The generated internal Agent command and core `message.added` schemas share the same 30-source ceiling; a conformance test accepts exactly 30 UUIDs and rejects 31 at both boundaries before any room transaction.

`agent-status.v1.json` is a closed generated WebSocket frame with required fields `type:"agent_status"`, UUID `roomId`, nullable UUID `agentRunId`, `state: idle|queued|running|streaming|completed|blocked_by_policy|cancelled|failed`, `serviceHealth: healthy|degraded|unavailable`, boolean `agentEnabled`, `updatedAt`, and nullable bounded `failureCode`. It has no text, prompt, token, provider, model, cost, or student data. Add it by `$ref` to the closed `realtime-frame.v1.json` union and assert each forbidden field fails schema validation.

```json
{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://learning-orbit.local/schemas/agent-status.v1.json","title":"AgentStatusFrame","type":"object","additionalProperties":false,"required":["type","roomId","agentRunId","state","serviceHealth","agentEnabled","updatedAt","failureCode"],"properties":{"type":{"const":"agent_status"},"roomId":{"type":"string","format":"uuid"},"agentRunId":{"type":["string","null"],"format":"uuid"},"state":{"enum":["idle","queued","running","streaming","completed","blocked_by_policy","cancelled","failed"]},"serviceHealth":{"enum":["healthy","degraded","unavailable"]},"agentEnabled":{"type":"boolean"},"updatedAt":{"type":"string","format":"date-time"},"failureCode":{"type":["string","null"],"maxLength":100}}}
```

`agent-current-state.v1.json` generates the safe reconnect response and deliberately does not reuse the internal/audit `AgentRun` schema:

```json
{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://learning-orbit.local/schemas/agent-current-state.v1.json","title":"AgentCurrentState","type":"object","additionalProperties":false,"required":["roomId","run","serviceHealth","agentEnabled","updatedAt"],"properties":{"roomId":{"type":"string","format":"uuid"},"run":{"oneOf":[{"type":"null"},{"type":"object","additionalProperties":false,"required":["agentRunId","state","failureCode","createdAt","updatedAt"],"properties":{"agentRunId":{"type":"string","format":"uuid"},"state":{"enum":["queued","running","streaming","completed","blocked_by_policy","cancelled","failed"]},"failureCode":{"type":["string","null"],"maxLength":100},"createdAt":{"type":"string","format":"date-time"},"updatedAt":{"type":"string","format":"date-time"}}}]},"serviceHealth":{"enum":["healthy","degraded","unavailable"]},"agentEnabled":{"type":"boolean"},"updatedAt":{"type":"string","format":"date-time"}}}
```

`agent-command.v1.json` is the closed REST command/response authority:

```json
{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://learning-orbit.local/schemas/agent-command.v1.json","title":"AgentCommandCatalog","type":"object","additionalProperties":false,"maxProperties":0,"$defs":{"RequestAgentRunInput":{"type":"object","additionalProperties":false,"required":["triggerEventId"],"properties":{"triggerEventId":{"type":"string","format":"uuid"}}},"AgentRunAccepted":{"type":"object","additionalProperties":false,"required":["agentRunId","state"],"properties":{"agentRunId":{"type":"string","format":"uuid"},"state":{"enum":["queued","running","streaming","completed","blocked_by_policy","cancelled","failed"]}}},"CancelAgentRunAccepted":{"type":"object","additionalProperties":false,"required":["agentRunId","state"],"properties":{"agentRunId":{"type":"string","format":"uuid"},"state":{"const":"cancelled"}}},"AgentSettingsInput":{"type":"object","additionalProperties":false,"required":["enabled"],"properties":{"enabled":{"type":"boolean"}}},"AgentSettingsResponse":{"type":"object","additionalProperties":false,"required":["enabled","cancelledRunId"],"properties":{"enabled":{"type":"boolean"},"cancelledRunId":{"type":["string","null"],"format":"uuid"}}}}}
```

```json
{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://learning-orbit.local/schemas/agent-provider-health.v1.json","title":"AgentProviderHealthContract","x-learning-orbit-python-ingress":true,"type":"object","additionalProperties":false,"maxProperties":0,"$defs":{"Request":{"type":"object","additionalProperties":false,"required":["probeId","providerId","manifestSha256","health","checkedAt","reasonCode"],"properties":{"probeId":{"type":"string","format":"uuid"},"providerId":{"type":"string","pattern":"^[a-z0-9._-]{1,64}$"},"manifestSha256":{"type":"string","pattern":"^[a-f0-9]{64}$"},"health":{"enum":["healthy","degraded","unavailable"]},"checkedAt":{"type":"string","format":"date-time"},"reasonCode":{"type":["string","null"],"pattern":"^[A-Z0-9_]{1,64}$"}}},"Response":{"oneOf":[{"type":"object","additionalProperties":false,"required":["status"],"properties":{"status":{"enum":["accepted","ignored_stale"]}}},{"type":"object","additionalProperties":false,"required":["status","code"],"properties":{"status":{"const":"rejected"},"code":{"enum":["PROBE_ASSERTION_INVALID","PROVIDER_SCOPE_MISMATCH","HEALTH_SAMPLE_TIME_INVALID"]}}}]}}}
```

Task 1 also freezes the complete Worker→Server Agent command before generation:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://learning-orbit.local/schemas/agent-internal-command.v1.json",
  "title": "AgentInternalCommandContract",
  "x-learning-orbit-python-ingress": true,
  "type": "object",
  "additionalProperties": false,
  "maxProperties": 0,
  "$defs": {
    "Request": {
      "type": "object",
      "additionalProperties": false,
      "required": ["jobId", "jobType", "roomId", "sourceEventId", "dedupeKey", "agentRunId", "correlationId", "claimGeneration", "claimToken", "workerId", "text", "outputSha256", "sourceEventIds", "warningCodes"],
      "properties": {
        "jobId": { "type": "string", "format": "uuid" },
        "jobType": { "const": "agent.execute.v1" },
        "roomId": { "type": "string", "format": "uuid" },
        "sourceEventId": { "type": "string", "format": "uuid" },
        "dedupeKey": { "type": "string", "pattern": "^agent\\.execute\\.v1:[0-9a-f-]{36}$" },
        "agentRunId": { "type": "string", "format": "uuid" },
        "correlationId": { "type": "string", "format": "uuid" },
        "claimGeneration": { "type": "string", "pattern": "^[1-9][0-9]{0,18}$" },
        "claimToken": { "type": "string", "format": "uuid" },
        "workerId": { "type": "string", "minLength": 1, "maxLength": 128 },
        "text": { "type": "string", "minLength": 1, "maxLength": 4000 },
        "outputSha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
        "sourceEventIds": { "type": "array", "items": { "type": "string", "format": "uuid" }, "minItems": 1, "maxItems": 30, "uniqueItems": true },
        "warningCodes": { "type": "array", "items": { "type": "string", "pattern": "^[A-Z0-9_]{1,64}$" }, "maxItems": 10, "uniqueItems": true }
      }
    },
    "Response": {
      "oneOf": [
        { "type": "object", "additionalProperties": false, "required": ["status", "eventId"], "properties": { "status": { "enum": ["applied", "already_applied"] }, "eventId": { "type": "string", "format": "uuid" } } },
        { "type": "object", "additionalProperties": false, "required": ["status", "code"], "properties": { "status": { "const": "rejected" }, "code": { "enum": ["SERVICE_ASSERTION_INVALID", "JOB_CLAIM_STALE", "AGENT_OUTPUT_INVALID", "AGENT_RUN_NOT_ACTIVE", "ROOM_NOT_OPEN"] } } }
      ]
    }
  }
}
```

Freeze shared builders in `packages/contracts/src/routes.ts`:

```ts
agent:{request:(r:string)=>room(r,"/agent/runs"),cancel:(r:string,id:string)=>room(r,`/agent/runs/${encodeURIComponent(id)}/cancel`),current:(r:string)=>room(r,"/agent/current"),settings:(r:string)=>room(r,"/agent/settings")}
```

`POST request`, `POST cancel`, `GET current` and `PUT settings` validate/return only the generated command/current types. Current is cookie-authenticated for room members and returns only student-safe Agent status plus `serviceHealth` and `agentEnabled`; teacher-only audit detail remains separate. Settings is teacher-only. Plan 05 imports these generated types/builders rather than declaring Agent request/response, service-health or paths.

```ts
it("derives health only from signed monotonic samples",async()=>{expect((await postHealth(forgedSample)).statusCode).toBe(401);await postHealth(sign({providerId:"pilot",health:"healthy",checkedAt:clock.now(),reasonCode:null}));await postHealth(sign(olderUnavailable));expect((await current(roomCookie)).serviceHealth).toBe("healthy");clock.advance(31_000);expect((await current(roomCookie)).serviceHealth).toBe("unavailable");});
```

`agent-provider-health.v1.json` freezes request `{probeId,providerId,manifestSha256,health,checkedAt,reasonCode}` and response `{status:"accepted"|"ignored_stale"}` / closed rejected code; IDs/hashes/codes are bounded, extras are forbidden and no room/job/student field exists. Canonical route `internal.agent.health` is the one explicit non-room/job internal mutation. Extend Plan 01's single `service-assertion.ts` with `authorizeProviderHealthAssertion` by reusing its private closed-envelope, canonical-body-hash, Ed25519 trust and replay checks; do not create another verifier. This variant rejects job/room/claim fields, requires subject `provider-health-probe:{providerId}`, exact audience, lifetime ≤30 seconds, and exact provider/manifest scope from the loaded approved manifest. The probe uses Plan 01's signer with `lifetime_seconds=30`. Repository upsert accepts only newer `checkedAt`; replay cannot roll health back. Route/schema/cross-language manifest tests reject forged issuer/subject, wrong provider/manifest, stale/future time, extras and a 31-second assertion. Missing/older-than-30-second DB state maps to unavailable; memory is never authority.

- [ ] **Step 4: Add append-only histories and one-active-run protection**

```sql
CREATE TYPE agent_run_state AS ENUM ('queued','running','streaming','completed','blocked_by_policy','cancelled','failed');

ALTER TABLE classroom_room ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE worker_job ADD COLUMN cancel_requested_at timestamptz;

CREATE TABLE agent_run (
  agent_run_id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  state agent_run_state NOT NULL,
  trigger_event_id uuid NOT NULL REFERENCES room_event(event_id) ON DELETE CASCADE,
  requested_by_teacher_id uuid REFERENCES teacher_account(teacher_id) ON DELETE CASCADE,
  requested_by_room_member_id uuid REFERENCES room_member(room_member_id) ON DELETE CASCADE,
  input_from_room_seq bigint NOT NULL,
  input_through_room_seq bigint NOT NULL CHECK (input_through_room_seq >= input_from_room_seq),
  correlation_id uuid NOT NULL,
  model_provider text NOT NULL,
  model_id text NOT NULL,
  prompt_version text NOT NULL,
  policy_version text NOT NULL,
  failure_code text,
  token_input bigint,
  token_output bigint,
  cost_microunits bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((requested_by_teacher_id IS NOT NULL)::int + (requested_by_room_member_id IS NOT NULL)::int = 1)
);

CREATE UNIQUE INDEX one_active_agent_run_per_room
  ON agent_run(room_id)
  WHERE state IN ('queued','running','streaming');

CREATE UNIQUE INDEX one_agent_run_per_trigger
  ON agent_run(room_id, trigger_event_id);

CREATE TABLE agent_run_transition (
  transition_id uuid PRIMARY KEY,
  agent_run_id uuid NOT NULL REFERENCES agent_run(agent_run_id) ON DELETE CASCADE,
  from_state agent_run_state,
  to_state agent_run_state NOT NULL,
  reason_code text,
  causation_id uuid NOT NULL UNIQUE,
  transitioned_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_control_event (
  control_event_id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  teacher_id uuid NOT NULL REFERENCES teacher_account(teacher_id),
  action text NOT NULL CHECK (action IN ('enable','disable','cancel_requested')),
  agent_run_id uuid REFERENCES agent_run(agent_run_id),
  causation_id uuid NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_provider_health (
  provider_id text PRIMARY KEY,
  health text NOT NULL CHECK (health IN ('healthy','degraded','unavailable')),
  checked_at timestamptz NOT NULL,
  reason_code text,
  signature_key_id text NOT NULL,
  signature bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE moderation_decision (
  decision_id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  subject_kind text NOT NULL CHECK (subject_kind IN ('agent_output','derived_artifact','media')),
  subject_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('allow','warn','hold','redact')),
  policy_version text NOT NULL,
  reason_codes jsonb NOT NULL,
  decided_by text NOT NULL CHECK (decided_by IN ('deterministic_policy','approved_provider','teacher')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subject_kind, subject_id, policy_version)
);

CREATE TABLE provider_processing_record (
  processing_record_id uuid PRIMARY KEY,
  subject_kind text NOT NULL CHECK (subject_kind IN ('agent_run','media_derivation')),
  agent_run_id uuid REFERENCES agent_run(agent_run_id) ON DELETE RESTRICT,
  source_media_id uuid REFERENCES media_asset(media_id) ON DELETE RESTRICT,
  derivation text CHECK (derivation IN ('asr','ocr','image_description')),
  provider_id text NOT NULL,
  correlation_id uuid NOT NULL,
  provider_manifest_id text NOT NULL,
  authorization_record_id text NOT NULL,
  approved_purpose text NOT NULL,
  region text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  processor_version text NOT NULL,
  remote_copy_mode text NOT NULL CHECK (remote_copy_mode IN ('delete_and_probe','no_persistent_copy_attested')),
  remote_artifact_ref_ciphertext bytea,
  no_persistent_copy_authority_id text,
  cancellation_requested_at timestamptz,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK ((subject_kind='agent_run' AND agent_run_id IS NOT NULL AND source_media_id IS NULL AND derivation IS NULL) OR
         (subject_kind='media_derivation' AND source_media_id IS NOT NULL AND derivation IS NOT NULL AND agent_run_id IS NULL)),
  CHECK ((remote_copy_mode='delete_and_probe' AND remote_artifact_ref_ciphertext IS NOT NULL AND no_persistent_copy_authority_id IS NULL) OR
         (remote_copy_mode='no_persistent_copy_attested' AND remote_artifact_ref_ciphertext IS NULL AND no_persistent_copy_authority_id IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (agent_run_id, source_media_id, derivation, processor_version)
);

CREATE TABLE provider_processing_artifact (
  processing_record_id uuid PRIMARY KEY REFERENCES provider_processing_record(processing_record_id) ON DELETE CASCADE,
  artifact_id uuid UNIQUE NOT NULL REFERENCES derived_text_artifact(artifact_id) ON DELETE CASCADE
);
```

The two provider-processing parent FKs are deliberately `ON DELETE RESTRICT`, unlike ordinary room-owned rows. A source Agent run or media row cannot disappear while its encrypted remote locator/authority record still exists. Migration tests prove parent deletion fails before the processing record is explicitly lifecycle-closed and removed, then succeeds afterward. Plan 06 freezes the expected processing-record IDs, proves every provider copy, deletes those rows, and only then permits Agent/media/artifact parent deletion; a current-parent enumeration can never turn a lost locator into an empty-success result.

- [ ] **Step 5: Apply migration, regenerate types, and commit**

Run: `cd learning-orbit && pnpm db:migrate:test && pnpm contracts:generate && pnpm test:contracts && .venv/bin/python -m unittest services/worker/tests/test_agent_internal_contract.py services/worker/tests/test_provider_health_contract.py -v && pnpm vitest run apps/server/test/agent/agent-provider-health.test.ts apps/server/test/security/service-assertion.test.ts`  
Expected: PASS; both manifests share the exact canonical source set, generated Python ingress parsers import, artifacts stay separate, status rejects sensitive fields, requester FK holds, signed provider health persists only under the 30-second provider scope, append-only history tests pass, and migration rerun is clean.  
Commit:

```bash
git add packages/contracts services/worker/src/learning_orbit_worker/generated services/worker/tests/test_agent_internal_contract.py services/worker/tests/test_provider_health_contract.py infra/postgres/migrations/004_agent_multimodal.sql apps/server/src/app.ts apps/server/src/modules/security/service-assertion.ts apps/server/src/modules/agent/provider-health-repository.ts apps/server/src/modules/agent/internal-provider-health-route.ts apps/server/test/security/service-assertion.test.ts apps/server/test/agent/agent-provider-health.test.ts
git commit -m "feat(agent): freeze agent and multimodal shadow contracts"
```

### Task 2: Implement explicit Agent triggers, cancellation, and idempotency

**Files:**
- Create: `learning-orbit/apps/server/src/modules/agent/agent-service.ts`
- Create: `learning-orbit/apps/server/src/modules/agent/agent-routes.ts`
- Create: `learning-orbit/apps/server/src/modules/agent/agent-repository.ts`
- Test: `learning-orbit/apps/server/test/agent/agent-trigger.test.ts`
- Test: `learning-orbit/apps/server/test/agent/agent-concurrency.test.ts`
- Test: `learning-orbit/apps/server/test/agent/agent-settings-cancel.test.ts`

- [ ] **Step 1: Write red tests for trigger policy**

```ts
it("accepts an explicit @Nova request and rejects recursive Agent triggering", async () => {
  const human = await sendMessage(studentClient, {
    text: "@Nova Agent 我们应如何检查能量循环的说法？",
    mentions: [room.novaActorId]
  });
  expect((await requestAgent(studentClient, human.eventId)).statusCode).toBe(202);
  const agentEvent = await seedAgentEvent(roomId);
  expect((await requestAgent(agentClient, agentEvent.eventId)).json().code).toBe("AGENT_CANNOT_TRIGGER_AGENT");
});

it("allows the teacher to cancel the only active run", async () => {
  const run = await createQueuedRun(roomId);
  await cancelAgentRun(teacherClient, run.agentRunId);
  expect(await getRunState(run.agentRunId)).toBe("cancelled");
});

it("accepts student and teacher owners but rejects a cross-room student", async () => {
  expect((await requestAgent(roomAStudent, roomATrigger)).statusCode).toBe(202);
  expect((await requestAgent(roomBTeacher, roomBTrigger)).statusCode).toBe(202);
  expect((await requestAgent(roomBStudent, roomATrigger)).statusCode).toBe(404);
});

it("disables atomically and never lets cancelled work succeed", async () => {
  const run = await createRunningRun(roomId);
  await put(routes.agent.settings(roomId), teacherCookie, { enabled: false });
  expect(await roomAgentEnabled(roomId)).toBe(false);
  expect(await runState(run.agentRunId)).toBe("cancelled");
  expect(await jobCancelRequestedAt(run.jobId)).not.toBeNull();
  expect(await jobState(run.jobId)).toBe("cancelled");
  expect(await trySucceedJob(run.jobId)).toBe(false);
  expect((await studentPut(routes.agent.settings(roomId), { enabled: true })).statusCode).toBe(403);
});

it("exposes append-only history until governed room deletion",async()=>{const run=await completedRun();expect((await patch(`/internal/agent-runs/${run.agentRunId}/transitions/${run.transitionId}`,{})).statusCode).toBe(404);expect(await transitionHistory(run.agentRunId)).toEqual(run.transitions);});
```

- [ ] **Step 2: Run and confirm route failure**

Run: `cd learning-orbit && pnpm vitest run apps/server/test/agent/agent-trigger.test.ts`  
Expected: FAIL with missing routes.

- [ ] **Step 3: Implement trigger invariants**

```ts
export async function requestAgentRun(deps: AgentDeps, input: AgentRequest): Promise<AgentRun> {
  const member = await deps.rooms.requireRoomPrincipal(input.sessionId, input.roomId);
  const room = await deps.rooms.requireRoom(input.roomId);
  if (room.status !== "open") throw new AgentError("ROOM_NOT_OPEN", 409);
  const trigger = await deps.events.requireEvent(input.roomId, input.triggerEventId);
  if (trigger.actorKind === "agent") throw new AgentError("AGENT_CANNOT_TRIGGER_AGENT", 422);
  const explicitlyMentioned = trigger.payload.mentions?.includes(room.novaActorId) === true;
  if (member.role !== "teacher" && !explicitlyMentioned) throw new AgentError("EXPLICIT_TRIGGER_REQUIRED", 403);
  if (!room.agentEnabled) throw new AgentError("AGENT_DISABLED", 409);
  return deps.repo.getOrCreateRunAndJob({ jobType: "agent.execute.v1", roomId: input.roomId, triggerEventId: trigger.eventId, correlationId: trigger.correlationId, requestedByTeacherId: member.role === "teacher" ? member.teacherId : null, requestedByRoomMemberId: member.role === "student" ? member.roomMemberId : null, throughSeq: trigger.roomSeq });
}
```

The generated request route uses Plan 01's `agentTrigger` rate-limit policy. `getOrCreateRunAndJob` locks the room, returns the existing `(room_id,trigger_event_id)` run for identical retries, or atomically inserts one run plus the exact raw job: `job_type='agent.execute.v1'`, non-null `room_id=run.room_id`, `source_event_id=trigger_event_id`, closed `{agentRunId}` payload, dedupe `agent.execute.v1:{agentRunId}`, `correlation_id=trigger.correlation_id`, queued/run-now, and (after Plan 03) NULL analytics-order fields. The handler validates every one of those fields against the locked run+trigger plus the current claim before provider preparation. Drift in source, dedupe, correlation, room or order yields zero provider calls. The first request returns 202; lost-response/reconnect/completed retry returns 200 with the same run and no new call/cost/message. Tests submit 20 concurrent retries and raw-row tampering fixtures, requiring one run/job, stable IDs/correlation and default-deny before provider access.

- [ ] **Step 4: Make cancellation observable and race-safe**

Every state change updates head plus inserts one transition in one transaction; causation retries no-op. An authoritative room/user deletion, disable or cancel of queued/running/streaming work writes `cancel_requested_at`, sets both `agent_run.state` and `worker_job.status` to `cancelled`, and clears `claim_token/locked_at/locked_by` in that same transaction before appending transition/control history. A Worker-initiated cancel additionally CASes its current generation/token. Job success/fail uses Plan 01's full claim CAS plus `cancel_requested_at IS NULL`; zero rows means cancellation or reclaim won. Tests cancel a running fixture, assert the database CHECK passes with all three lease fields NULL, then resume the old token and require zero transition, provider record, message or job-success rows.

`agent-routes.ts` registers only generated request/cancel/current/settings. Settings is teacher-only; controls never create RoomEvents. Transition/control repositories expose insert/read only and APIs expose no mutation; this append-only claim lasts until Plan 06 governed room cascade (no unconditional DELETE trigger). Tests cancel each state, retry causation, and race cancel/success.

- [ ] **Step 5: Run concurrency tests and commit**

Run: `cd learning-orbit && pnpm vitest run apps/server/test/agent/agent-trigger.test.ts apps/server/test/agent/agent-concurrency.test.ts apps/server/test/agent/agent-settings-cancel.test.ts`  
Expected: PASS; one active run, in-room owners, append-only idempotent control history, and cancelled jobs never succeed.  
Commit:

```bash
git add apps/server/src/modules/agent apps/server/test/agent
git commit -m "feat(agent): enforce explicit trigger and cancellation policy"
```

### Task 3: Build a bounded, provenance-preserving context assembler

**Files:**
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/agent/context.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/agent/prompt.py`
- Create: `learning-orbit/services/worker/tests/test_agent_context.py`
- Create: `learning-orbit/services/worker/tests/test_prompt_snapshots.py`

- [ ] **Step 1: Write context exclusion and source-range tests**

```python
class AgentContextTests(unittest.TestCase):
    def test_context_contains_only_authorized_active_events(self):
        context = build_context(self.room, through_seq=12, max_events=30)
        self.assertEqual([item.room_seq for item in context.events], [8, 9, 11, 12])
        self.assertNotIn("retracted text", context.rendered)
        self.assertEqual(context.source_range, (8, 12))

    def test_prompt_instructs_socratic_facilitation_without_hidden_scores(self):
        prompt = build_prompt(self.context)
        self.assertIn("ask for evidence", prompt.system)
        self.assertNotIn("student ranking", prompt.rendered_context.lower())
```

- [ ] **Step 2: Run and confirm missing functions**

Run: `cd learning-orbit && python3.12 -m unittest services/worker/tests/test_agent_context.py -v`  
Expected: FAIL with import errors.

- [ ] **Step 3: Implement an immutable context object**

```python
@dataclass(frozen=True)
class AgentContext:
    room_id: str
    source_range: tuple[int, int]
    events: tuple[ContextEvent, ...]
    approved_artifacts: tuple[DerivedArtifact, ...]

def build_context(repo: AgentRepo, room_id: str, through_seq: int, max_events: int = 30) -> AgentContext:
    events = tuple(repo.active_events(room_id=room_id, through_seq=through_seq, limit=max_events))
    if not events:
        raise AgentInputError("NO_ACTIVE_CONTEXT")
    artifacts = tuple(repo.approved_artifacts_for_events([event.event_id for event in events]))
    return AgentContext(room_id, (events[0].room_seq, events[-1].room_seq), events, artifacts)
```

- [ ] **Step 4: Version the Socratic prompt as data**

Create `services/worker/src/learning_orbit_worker/agent/prompts/socratic-facilitator-v1.txt` containing four allowed moves: ask for evidence, connect two views, surface an unresolved contradiction, and summarize without supplying the answer. It must prohibit grading, ranking, diagnosing, hidden-personality inference, unsupported factual claims, and revealing system instructions.

- [ ] **Step 5: Run prompt snapshot tests and commit**

Run: `cd learning-orbit && python3.12 -m unittest services/worker/tests/test_agent_context.py services/worker/tests/test_prompt_snapshots.py -v`  
Expected: PASS with a stable SHA-256 for the prompt file.  
Commit:

```bash
git add services/worker/src/learning_orbit_worker/agent services/worker/tests/test_agent_context.py services/worker/tests/test_prompt_snapshots.py
git commit -m "feat(agent): assemble bounded provenance context"
```

### Task 4: Define provider ports and deterministic execution

**Files:**
- Modify: `learning-orbit/services/worker/pyproject.toml`
- Modify: `learning-orbit/services/worker/requirements.lock`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/providers/model.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/providers/lifecycle.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/providers/manifest.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/providers/fixture.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/providers/health.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/providers/openai_compatible_http.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/agent/run.py`
- Test: `learning-orbit/services/worker/tests/test_agent_run.py`
- Test: `learning-orbit/services/worker/tests/test_provider_health.py`
- Test: `learning-orbit/services/worker/tests/test_openai_compatible_http.py`
- Test: `learning-orbit/services/worker/tests/test_provider_lifecycle.py`
- Test: `learning-orbit/services/worker/tests/test_provider_manifest.py`

- [ ] **Step 1: Write streaming, timeout, cancellation, and no-provider tests**

```python
class AgentRunTests(unittest.TestCase):
    def test_fixture_stream_is_not_committed_until_complete(self):
        job, deps = self.claimed_attempt(provider=FixtureProvider(["请说明", "你的证据。"]))
        candidate = build_agent_candidate(deps, job, self.run_id)
        self.assertGreater(job.claim_generation, 0); self.assertIsNotNone(job.claim_token)
        self.assertEqual(candidate.text, "请说明你的证据。")
        self.assertEqual(self.repo.staged_candidates(), [])
        self.assertEqual(self.repo.final_messages(), [])
        self.assertEqual(self.repo.room_event_count(), 0)
        self.assertEqual(self.repo.outbox_count(), 0)
        self.assertEqual(self.repo.stream_chunks(), [])

    def test_disabled_provider_fails_with_stable_code(self):
        job, deps = self.claimed_attempt(provider=DisabledProvider())
        candidate = build_agent_candidate(deps, job, self.run_id)
        self.assertEqual(candidate.failure_code, "MODEL_PROVIDER_DISABLED")

    def test_cancelled_run_never_commits_message(self):
        job, deps = self.claimed_attempt(provider=CancellingFixtureProvider())
        candidate = build_agent_candidate(deps, job, self.run_id)
        self.assertEqual(candidate.state, "cancelled")
        self.assertEqual(self.repo.final_messages(), [])
        self.assertIn(self.repo.run_state(self.run_id)[0], ("running", "streaming"))
        self.assertIsNone(self.repo.job_completion(job.job_id))

    def test_raw_chunks_never_leave_worker_memory(self):
        job, deps = self.claimed_attempt(provider=FixtureProvider(["unsafe ", "draft"]))
        candidate = build_agent_candidate(deps, job, self.run_id)
        self.assertEqual(candidate.text, "unsafe draft")
        self.assertEqual(self.transient.frames, [])
        self.assertNotIn("unsafe", self.logs.text)

    def test_pause_wins_provider_completion_race(self):
        job, deps = self.claimed_attempt(provider=PauseBeforeFinalProvider())
        candidate = build_agent_candidate(deps, job, self.run_id)
        self.assertEqual(candidate.failure_code, "ROOM_PAUSED")
        self.assertEqual(self.repo.final_messages(), [])

    def test_pilot_provider_without_copy_lifecycle_fails_before_request(self):
        with self.assertRaisesRegex(ConfigurationError, "PROVIDER_COPY_LIFECYCLE_REQUIRED"):
            load_provider_manifest(
                self.manifest_without_lifecycle,
                environment="pilot",
                verification=self.valid_verification,
            )
```

- [ ] **Step 2: Run and verify red state**

Run: `cd learning-orbit && python3.12 -m unittest services/worker/tests/test_agent_run.py -v`  
Expected: FAIL because provider ports are absent.

- [ ] **Step 3: Implement provider-neutral streaming types**

```python
@dataclass(frozen=True)
class ModelRequest:
    model_id: str
    system: str
    messages: tuple[dict[str, str], ...]
    max_output_tokens: int

@dataclass(frozen=True)
class ProviderLifecycleHandle:
    mode: Literal["delete_and_probe", "no_persistent_copy_attested"]
    remote_artifact_ref: bytes | None
    no_persistent_copy_authority_id: str | None

@dataclass(frozen=True)
class PreparedModelCall:
    request: ModelRequest
    provider_invocation_id: str
    lifecycle: ProviderLifecycleHandle

class ModelProvider(Protocol):
    provider_id: str
    def prepare(self, request: ModelRequest, provider_invocation_id: str) -> PreparedModelCall: ...
    def open_stream(self, call: PreparedModelCall) -> Iterator[str]: ...

class ProviderCopyLifecycle(Protocol):
    provider_id: str
    def delete_remote_artifact(self, remote_ref: bytes, idempotency_key: str) -> Literal["deleted", "already_absent", "retryable"]: ...
    def probe_remote_artifact(self, remote_ref: bytes) -> Literal["unreadable", "readable", "unknown"]: ...

class DisabledProvider:
    provider_id = "disabled"
    def prepare(self, request: ModelRequest, provider_invocation_id: str) -> PreparedModelCall:
        raise ProviderUnavailable("MODEL_PROVIDER_DISABLED")
    def open_stream(self, call: PreparedModelCall) -> Iterator[str]:
        raise ProviderUnavailable("MODEL_PROVIDER_DISABLED")
```

Add and lock `httpx==0.28.1` in the existing worker environment. `OpenAICompatibleHttpProvider` implements the manifest-selected chat/stream protocol with a base URL allowlist, TLS verification, separate connect/read/total timeouts, maximum response bytes/tokens, bounded retries only for safe transient errors, and Authorization sourced only from the manifest-named environment variable. It rejects redirects, private/unapproved hosts, unknown JSON fields and provider text after cancellation. A local mock HTTP server proves request mapping, stream parsing, timeout, 429 backoff, malformed chunks, cancellation and redacted logs; it never requires a real credential. The same manifest must declare exactly one lifecycle mode. `delete_and_probe` requires reviewed DELETE and status/HEAD path templates, stable provider request/object identifiers, idempotency support, response schemas and a linearizable tombstone guarantee: once delete succeeds and the probe reports unreadable for that stable invocation ID, an earlier in-flight/late response cannot recreate the remote artifact. The HTTP adapter implements both `ProviderCopyLifecycle` methods with the same host/TLS/redirect/timeout controls; a mock holds a request in flight, deletes it, releases the late completion and still requires `unreadable`. A provider without that guarantee is ineligible for this mode. `no_persistent_copy_attested` requires a separately signed, scoped and expiring authority record and returns no remote reference. Unknown, `unknown` probe, missing delete capability or an expired attestation blocks pilot admission and later deletion completion rather than yielding a success receipt. Pilot startup may instantiate this adapter only when the external provider record names the exact protocol, host, model, region, lifecycle mode and secret variable and the Plan 06 authority gate is current.

`providers/manifest.py` is introduced in this task, before either HTTP adapter can start. Its closed parser rejects extras and requires provider/manifest identity, manifest SHA-256, capabilities, model IDs, region, approved host/path templates, secret variable names, bounds, lifecycle mode and the matching lifecycle fields. In `pilot`, it additionally requires an injected verification receipt from Plan 06 whose provider ID, manifest hash and lifecycle mode match exactly; since Plan 06 is not yet executed at Gate 4, all Gate 4 runs remain fixture/mock-only. Task 6 extends the same parser with audio/vision modality fields and never creates another manifest loader.

```python
def load_provider_manifest(
    path: Path,
    environment: str,
    verification: ProviderAuthorityReceipt | None,
) -> VerifiedProviderManifest:
    manifest = ProviderManifest.from_closed_json(path.read_text())
    if environment == "pilot":
        if verification is None or not verification.signature_verified:
            raise ConfigurationError("PROVIDER_AUTHORITY_REQUIRED")
        if not verification.is_current:
            raise ConfigurationError("PROVIDER_AUTHORITY_NOT_CURRENT")
        if (
            verification.provider_id != manifest.provider_id
            or verification.manifest_sha256 != manifest.sha256
            or verification.lifecycle_mode != manifest.remote_copy_mode
        ):
            raise ConfigurationError("PROVIDER_AUTHORITY_SCOPE_MISMATCH")
    assert_lifecycle_shape(manifest, verification)
    return VerifiedProviderManifest(manifest=manifest, authority_receipt=verification)
```

`approvalStatus` inside a manifest is never treated as authority; only the injected verification receipt produced from the controlled evidence path can enable `pilot`.

Add the provider HTTP dependency without replacing the existing assertion/media dependencies. Regenerate Plan 01's single Python 3.12 hash lock with `python -m piptools compile --generate-hashes --resolver=backtracking --output-file services/worker/requirements.lock services/worker/pyproject.toml`, run `node scripts/verify-python-lock.mjs`, and install with `--require-hashes`; Task 6 reuses this HTTPX lock and does not create a second dependency file. The green command imports Plan 01 `ServiceAssertionSigner` after the lock update so `cryptography==50.0.1` cannot be dropped accidentally.

- [ ] **Step 4: Implement run orchestration with no hidden fallback**

```python
def build_agent_candidate(deps: AgentWorkerDeps, job: WorkerJob, run_id: str) -> CandidateResult:
    deps.job_claims.require_current(job)
    resume = deps.repo.claim_or_resume_run(job, run_id)
    if resume.state == "terminal_with_completion":
        return CandidateResult.existing_terminal()
    if resume.state == "terminal_cancelled":
        return CandidateResult.cancelled("ALREADY_CANCELLED")
    run = resume.run
    reason = deps.repo.preflight_cancel_reason(run_id, run.room_id)
    if reason is not None:
        return CandidateResult.cancelled(reason)
    deps.repo.transition(job, run_id, "running", "WORKER_CLAIMED")
    context = build_context(deps.repo, run.room_id, run.input_through_room_seq)
    request = build_model_request(context, run.model_id)
    chunks: list[str] = []
    try:
        call = deps.provider.prepare(request, provider_invocation_id=run_id)
        deps.repo.record_provider_processing(
            claim=job,
            run_id=run_id,
            provider_id=deps.provider.provider_id,
            correlation_id=run.correlation_id,
            lifecycle=deps.sealer.seal_remote_ref(call.lifecycle),
        )
        for chunk in deps.provider.open_stream(call, cancellation=deps.cancellation):
            reason = deps.repo.preflight_cancel_reason(run_id, run.room_id)
            if reason is not None:
                return CandidateResult.cancelled(reason)
            chunks.append(chunk)
        reason = deps.repo.preflight_cancel_reason(run_id, run.room_id)
        if reason is not None:
            return CandidateResult.cancelled(reason)
        return CandidateResult.ready(run, "".join(chunks), context.source_range)
    except ProviderError as exc:
        return CandidateResult.failed(exc.code)
```

`claim_or_resume_run` never uses ambiguous `None`. A new generation may resume queued/running/streaming/staged non-terminal state with the stable invocation/processing record; completed/blocked/failed requires a matching receipt, while cancelled returns a typed candidate result. Task 4 performs only claim-fenced transition and provider-processing-record setup, then returns ready/failed/cancelled candidate data without a terminal job outcome. Crash tests stop after transition, record and provider response; Task 5's handler resumes and performs the only terminal transaction.

Task 4 deliberately does not register `agent.execute.v1`: it produces a fenced, memory-only/staged `AgentCandidate` library result but has no safety/final-command completion transaction yet, so it must not return Plan 01 `HandlerOutcome.success`. Tests call the library directly and require zero room event/outbox/final message. Task 5 owns the first runnable handler and completion marker.

- [ ] **Step 5: Run worker tests and commit**

Run: `cd learning-orbit && .venv/bin/python -m unittest services/worker/tests/test_agent_run.py services/worker/tests/test_provider_health.py services/worker/tests/test_provider_lifecycle.py services/worker/tests/test_provider_manifest.py services/worker/tests/test_openai_compatible_http.py -v`  
Expected: PASS; no chunks/hidden reasoning persist, cancellation/failure remain typed non-terminal candidate results with zero completion marker, health updates are signed, and every enabled pilot provider supplies a reviewed copy-lifecycle path.  
Commit:

```bash
git add services/worker/pyproject.toml services/worker/requirements.lock services/worker/src/learning_orbit_worker/providers services/worker/src/learning_orbit_worker/agent/run.py services/worker/tests/test_agent_run.py services/worker/tests/test_provider_health.py services/worker/tests/test_provider_lifecycle.py services/worker/tests/test_provider_manifest.py services/worker/tests/test_openai_compatible_http.py
git commit -m "feat(agent): add provider-neutral cancellable execution"
```

### Task 5: Add input/output safety decisions and final Room Command submission

**Files:**
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/safety/policy.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/safety/decisions.py`
- Modify: `learning-orbit/services/worker/src/learning_orbit_worker/agent/run.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/agent_handlers.py`
- Modify: `learning-orbit/services/worker/src/learning_orbit_worker/main.py`
- Test: `learning-orbit/services/worker/tests/test_agent_handler_registration.py`
- Create: `learning-orbit/apps/server/src/modules/agent/internal-agent-route.ts`
- Reuse unchanged: `learning-orbit/apps/server/src/modules/security/service-assertion.ts`
- Reuse unchanged: `learning-orbit/apps/server/src/modules/jobs/job-claim-authority.ts`
- Reuse unchanged: `learning-orbit/apps/server/src/modules/rooms/room-lock.ts`
- Create: `learning-orbit/apps/server/src/modules/agent/agent-status-service.ts`
- Test: `learning-orbit/apps/server/test/agent/agent-event-registry.test.ts`
- Test: `learning-orbit/apps/server/test/agent/internal-agent-route.test.ts`
- Test: `learning-orbit/apps/server/test/agent/agent-status.test.ts`
- Test: `learning-orbit/services/worker/tests/test_agent_safety.py`

The following contract is repeated verbatim from Task 1 so the final-command task is self-contained. Task 5 verifies its generated hash and must not edit the schema or either manifest:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://learning-orbit.local/schemas/agent-internal-command.v1.json",
  "title": "AgentInternalCommandContract",
  "x-learning-orbit-python-ingress": true,
  "type": "object",
  "additionalProperties": false,
  "maxProperties": 0,
  "$defs": {
    "Request": {
      "type": "object",
      "additionalProperties": false,
      "required": ["jobId", "jobType", "roomId", "sourceEventId", "dedupeKey", "agentRunId", "correlationId", "claimGeneration", "claimToken", "workerId", "text", "outputSha256", "sourceEventIds", "warningCodes"],
      "properties": {
        "jobId": { "type": "string", "format": "uuid" },
        "jobType": { "const": "agent.execute.v1" },
        "roomId": { "type": "string", "format": "uuid" },
        "sourceEventId": { "type": "string", "format": "uuid" },
        "dedupeKey": { "type": "string", "pattern": "^agent\\.execute\\.v1:[0-9a-f-]{36}$" },
        "agentRunId": { "type": "string", "format": "uuid" },
        "correlationId": { "type": "string", "format": "uuid" },
        "claimGeneration": { "type": "string", "pattern": "^[1-9][0-9]{0,18}$" },
        "claimToken": { "type": "string", "format": "uuid" },
        "workerId": { "type": "string", "minLength": 1, "maxLength": 128 },
        "text": { "type": "string", "minLength": 1, "maxLength": 4000 },
        "outputSha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
        "sourceEventIds": { "type": "array", "items": { "type": "string", "format": "uuid" }, "minItems": 1, "maxItems": 30, "uniqueItems": true },
        "warningCodes": { "type": "array", "items": { "type": "string", "pattern": "^[A-Z0-9_]{1,64}$" }, "maxItems": 10, "uniqueItems": true }
      }
    },
    "Response": {
      "oneOf": [
        { "type": "object", "additionalProperties": false, "required": ["status", "eventId"], "properties": { "status": { "enum": ["applied", "already_applied"] }, "eventId": { "type": "string", "format": "uuid" } } },
        { "type": "object", "additionalProperties": false, "required": ["status", "code"], "properties": { "status": { "const": "rejected" }, "code": { "enum": ["SERVICE_ASSERTION_INVALID", "JOB_CLAIM_STALE", "AGENT_OUTPUT_INVALID", "AGENT_RUN_NOT_ACTIVE", "ROOM_NOT_OPEN"] } } }
      ]
    }
  }
}
```

- [ ] **Step 1: Write fail-closed output tests**

```python
def test_blocked_output_is_not_submitted(self):
    decision = evaluate_agent_output("请公开同学的心理风险排名", self.policy)
    self.assertEqual(decision.action, "hold")
    self.assertEqual(decision.reason_codes, ("FORBIDDEN_PERSONAL_INFERENCE",))
    self.assertEqual(self.room_api.submissions, [])

def test_allowed_socratic_question_keeps_evidence_refs(self):
    result = finalize_agent_output(self.allowed_run)
    self.assertEqual(result.evidence_refs, ("00000000-0000-4000-8000-000000000108", "00000000-0000-4000-8000-000000000109"))
```

```ts
it("keeps agent namespace fail closed unless a payload is explicitly registered", async () => {
  const registry = createCoreEventPayloadRegistry();
  const roomEvents = roomEventRepository({ eventPayloads: registry });
  await expect(appendAgentFixtureEvent(roomEvents, "agent.run.completed"))
    .rejects.toThrow("UNKNOWN_EVENT_TYPE:agent.run.completed");
  expect(await countAgentFixtureEvents()).toBe(0);

  registry.register("agent.run.completed", {
    type: "object",
    additionalProperties: false,
    required: ["agentRunId"],
    properties: { agentRunId: { type: "string", format: "uuid" } }
  });
  await appendAgentFixtureEvent(roomEvents, "agent.run.completed");
  expect(await countAgentFixtureEvents()).toBe(1);
});
```

The second registration exists only inside this conformance test; Plan 04 does not register or emit a production `agent.*` RoomEvent. If a future production change introduces one, it must add a versioned JSON Schema under `packages/contracts/schemas`, generate/export its payload type, register it explicitly in `apps/server/src/app.ts` before `RoomEventRepository` construction, and retain the rollback assertion above.

- [ ] **Step 2: Run and confirm absent policy engine and default-deny Agent namespace**

Run: `cd learning-orbit && pnpm vitest run apps/server/test/agent/agent-event-registry.test.ts && python3.12 -m unittest services/worker/tests/test_agent_safety.py -v`  
Expected before implementation: the TypeScript test proves the unregistered transaction rolls back with `UNKNOWN_EVENT_TYPE:agent.run.completed`; Python fails with missing safety modules.

- [ ] **Step 3: Implement stable policy actions**

```python
@dataclass(frozen=True)
class SafetyDecision:
    action: Literal["allow", "warn", "hold", "redact"]
    policy_version: str
    reason_codes: tuple[str, ...]

def decide_output(checks: tuple[SafetyCheck, ...], policy_version: str) -> SafetyDecision:
    reasons = tuple(sorted({reason for check in checks for reason in check.reason_codes}))
    if any(check.severity == "block" for check in checks): return SafetyDecision("hold", policy_version, reasons)
    if reasons: return SafetyDecision("warn", policy_version, reasons)
    return SafetyDecision("allow", policy_version, ())
```

Task 5 now creates the first runnable `handle_agent_execute`. It validates the full raw job/claim, calls `build_agent_candidate`, and converts every result explicitly: cancelled atomically clears the job lease/run and returns `terminal_cancelled`; provider failure or held/redacted policy atomically marks the run terminal and inserts `AGENT_EXECUTION_TERMINAL`, then returns success; allow/warn calls the final command below, which inserts that same stable marker, then returns success; existing terminal is accepted only with its matching marker. Lost lease returns `lost_lease`. The registration test runs all branches through Plan 01 `run_with_lease`, proving no success lacks a marker and terminal cancellation does not call succeed/fail twice.

- [ ] **Step 4: Submit final Agent output through an internal authenticated command**

The Worker calls canonical route `internal.agent.complete` through Plan 01's generated-code-aware bounded client and signer. Its closed body/assertion carries the complete tuple `jobId,jobType,roomId,sourceEventId,dedupeKey,correlationId,claimGeneration,claimToken,workerId` plus the Agent result fields. The server recomputes SHA-256. Under the canonical room advisory lock it locks room/run/trigger rows, calls the injected singleton `JobClaimAuthority.requireCurrent`, and rechecks policy/run/room. One transaction appends core message/outbox, changes `agent_run` to completed, inserts its transition and calls `JobClaimAuthority.completeBusiness(...,"AGENT_EXECUTION_TERMINAL")`. The job stays running for the wrapper. Same-claim response-loss retry validates the same marker and returns the existing event; stale/cancelled input writes nothing. Max-attempt crash after this transaction is recovered directly to succeeded with one message/run transition and no handler/provider rerun. Neither the route nor Worker defines a second assertion, room-lock or claim helper.

`agent-status-service.ts` joins persisted run/room plus `agent_provider_health`; the repository TTL rule is the only `serviceHealth` source. It broadcasts text-free authorized status outside RoomEvent/seq/outbox. Current restores the same safe projection; tests prove zero chunks/provider/model/prompt/cost and identical live/reconnect health. Teacher audit stays separate.

- [ ] **Step 5: Run security/integration tests and commit**

Run: `cd learning-orbit && pnpm contracts:generate && pnpm test:contracts && pnpm vitest run apps/server/test/agent/agent-event-registry.test.ts apps/server/test/agent/internal-agent-route.test.ts apps/server/test/agent/agent-status.test.ts && python3.12 -m unittest services/worker/tests/test_agent_safety.py services/worker/tests/test_agent_handler_registration.py -v`  
Expected: PASS; unregistered `agent.*` fails closed, only the final approved core message commits, status reconnects without text, and blocked/paused/cancelled output never appears in `room_event`.  
Commit:

```bash
git add packages/contracts services/worker/src/learning_orbit_worker/generated/manifest.json services/worker/src/learning_orbit_worker/safety services/worker/src/learning_orbit_worker/agent/run.py services/worker/src/learning_orbit_worker/agent_handlers.py services/worker/src/learning_orbit_worker/main.py services/worker/tests/test_agent_safety.py services/worker/tests/test_agent_handler_registration.py apps/server/src/modules/agent apps/server/test/agent
git commit -m "feat(agent): gate and submit final Nova responses"
```

### Task 6: Implement versioned multimodal shadow artifacts

**Files:**
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/providers/asr.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/providers/ocr.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/providers/image_description.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/providers/openai_compatible_multimodal.py`
- Modify: `learning-orbit/services/worker/src/learning_orbit_worker/providers/manifest.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/multimodal_artifacts/__init__.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/multimodal_artifacts/pipeline.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/multimodal_artifacts/handler.py`
- Modify: `learning-orbit/services/worker/src/learning_orbit_worker/agent_handlers.py`
- Create: `learning-orbit/apps/server/src/modules/agent/multimodal-derivation-scheduler.ts`
- Modify: `learning-orbit/apps/server/src/app.ts`
- Modify: `learning-orbit/apps/server/src/modules/rooms/room-event-repository.ts`
- Modify: `learning-orbit/apps/server/src/modules/media/media-status-service.ts`
- Test: `learning-orbit/services/worker/tests/test_artifact_pipeline.py`
- Modify test: `learning-orbit/services/worker/tests/test_provider_manifest.py`
- Test: `learning-orbit/services/worker/tests/test_openai_compatible_multimodal.py`
- Test: `learning-orbit/apps/server/test/agent/multimodal-job-enqueue.test.ts`
- Test: `learning-orbit/apps/server/test/agent/multimodal-enqueue-order.test.ts`

- [ ] **Step 1: Write provenance and abstention tests**

```python
def test_low_fidelity_asr_stays_shadow(self):
    artifact = build_artifact(self.audio_event, FixtureAsr(confidence=0.31, text="不清楚"))
    wire = artifact.to_wire()
    self.assertEqual((wire["displayStatus"], wire["reviewStatus"]), ("teacher_shadow", "unreviewed"))
    self.assertTrue(wire["warnings"])
    self.assertFalse(artifact.eligible_for_extraction)

def test_text_hash_mismatch_is_quarantined(self):
    with self.assertRaises(ArtifactIntegrityError):
        verify_evidence_span(text="太阳能", text_sha256="forged", start=0, end=3)

def test_pilot_requires_manifest_and_consent_record(self):
    with self.assertRaisesRegex(ConfigurationError, "PROCESSING_AUTHORIZATION_REQUIRED"):
        process_artifact(self.media, manifest=None, authorization_record_id=None)

def test_provider_call_is_preceded_by_durable_lifecycle_record(self):
    process_artifact(self.media, provider=self.recording_provider)
    self.assertLess(self.repo.recorded_at, self.recording_provider.network_started_at)
    self.assertEqual(self.repo.processing_links_for(self.media.media_id), 1)
```

The server integration tests run all three interleavings and require one identical job:

```ts
it.each(["ready_then_message", "message_then_ready", "concurrent"] as const)("enqueues exactly once for %s", async (order) => {
  const { mediaId, sourceEventId, correlationId, processorVersion } = await runAttachmentOrder(order);
  const jobs = await jobsByDedupe(`multimodal.derive.v1:${mediaId}:${processorVersion}`);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ source_event_id: sourceEventId, correlation_id: correlationId, payload: { mediaId, sourceEventId, processorVersion } });
});

it("cancels before provider I/O when the source message was retracted after enqueue", async () => {
  const job = await enqueueReadyAttachment();
  await retractSourceMessage(job.sourceEventId);
  await runWorkerOnce();
  expect(await jobState(job.jobId)).toMatchObject({ status: "cancelled", reason: "SOURCE_MESSAGE_INACTIVE" });
  expect(provider.requestCount).toBe(0);
  expect(await providerProcessingCountForMedia(job.mediaId)).toBe(0);
});

it("cannot rebind one media id to a second message lineage",async()=>{const first=await attachReadyMediaToMessage();expect((await attachSameMediaToNewMessage(first.mediaId)).code).toBe("INVALID_COMMAND");await retractSourceMessage(first.sourceEventId);expect((await attachSameMediaToNewMessage(first.mediaId)).code).toBe("INVALID_COMMAND");expect(await jobsForMedia(first.mediaId)).toHaveLength(1);expect((await jobsForMedia(first.mediaId))[0].source_event_id).toBe(first.sourceEventId);});

it.each(["retract_wins", "provider_open_wins"] as const)("linearizes retract against provider open: %s", async (winner) => {
  const outcome = await runRetractProviderOpenRace(winner);
  expect(await db.scalar("select count(*)::int from derived_text_artifact where event_id=$1", [outcome.sourceEventId])).toBe(0);
  expect(await db.scalar("select count(*)::int from worker_job where job_type='analytics.replay-room.v1' and source_event_id=$1", [outcome.sourceEventId])).toBe(0);
  expect(outcome.providerRequestCount).toBe(winner === "retract_wins" ? 0 : 1);
  if (winner === "provider_open_wins") expect(await providerProcessingRow(outcome.mediaId)).toMatchObject({ cancellationRequestedAt: expect.any(Date) });
});
```

- [ ] **Step 2: Run and confirm missing pipeline**

Run: `cd learning-orbit && pnpm vitest run apps/server/test/agent/multimodal-job-enqueue.test.ts apps/server/test/agent/multimodal-enqueue-order.test.ts && python3.12 -m unittest services/worker/tests/test_artifact_pipeline.py -v`  
Expected: FAIL because the shared scheduler/handler and artifact pipeline are absent.

- [ ] **Step 3: Implement separate modality ports**

```python
class AsrProvider(Protocol):
    provider_id: str
    processor_version: str
    def transcribe(self, media: PrivateMedia) -> AsrResult: ...

class OcrProvider(Protocol):
    provider_id: str
    processor_version: str
    def recognize(self, media: PrivateMedia) -> OcrResult: ...

class ImageDescriptionProvider(Protocol):
    provider_id: str
    processor_version: str
    def describe(self, media: PrivateMedia, user_alt: str) -> ImageDescriptionResult: ...
```

ASR results include timestamps; OCR includes boxes; image description retains user alt. Before any network call, the pipeline derives a stable invocation ID from `mediaId + derivation + processorVersion`, prepares the provider lifecycle handle locally, and commits `provider_processing_record` with the source RoomEvent/WorkerJob correlation ID, manifest ID, authorization/consent record ID, approved purpose, region, request hash, processor version and times—never raw request, secret or provider response. It then invokes the provider. The immutable artifact and `provider_processing_artifact` link commit together after validation. A crash before that second transaction leaves a durable lifecycle record; retry uses the same invocation/idempotency/correlation IDs and cannot create an untracked remote copy. Teacher review reads only these safe IDs; missing approval/authorization/lifecycle capability fails before provider call.

`OpenAICompatibleMultimodalProvider` is the concrete approved-HTTP adapter for manifests that declare `openai_compatible_audio` and/or `openai_compatible_vision`. The manifest supplies separate allowlisted paths/models, response-schema version and the Task 4 lifecycle mode/ports; the adapter reuses the hardened HTTP and `ProviderCopyLifecycle` controls, streams private bytes without base64 logging, applies modality byte/time limits, validates timestamps/boxes/text, and fails closed when a provider does not support the declared processing or deletion/probe capability. A local mock server covers valid/invalid ASR, OCR and image-description responses, redirect/timeout/oversize/cancel behavior, delete retry, already-absent, readable/unreadable/unknown probes and proves no media/text enters logs. An approved provider that is not compatible requires a separately reviewed adapter task and cannot be activated by changing only a URL.

- [ ] **Step 4: Extend the existing closed manifest parser for multimodal startup**

```python
def extend_manifest_for_multimodal(manifest: VerifiedProviderManifest) -> VerifiedProviderManifest:
    if manifest.region not in manifest.allowed_regions:
        raise ConfigurationError("PROVIDER_REGION_NOT_ALLOWED")
    if not set(manifest.requested_modalities) <= set(manifest.approved_modalities):
        raise ConfigurationError("PROVIDER_MODALITY_NOT_APPROVED")
    if manifest.remote_copy_mode == "delete_and_probe" and not manifest.has_closed_delete_and_probe_ports:
        raise ConfigurationError("PROVIDER_COPY_LIFECYCLE_REQUIRED")
    if manifest.remote_copy_mode == "no_persistent_copy_attested" and manifest.authority_receipt is None:
        raise ConfigurationError("PROVIDER_COPY_AUTHORITY_REQUIRED")
    return manifest
```

This extends Task 4's one `providers/manifest.py`; it does not introduce the function for the first time. Fixture providers are permitted only when `environment=test`; disabled providers return explicit failure codes. The pilot process refuses to start if a requested external adapter lacks an approved manifest, required secret variable or a closed provider-copy lifecycle. The manifest loader rejects a mode with the wrong locator/authority shape, unknown delete/probe semantics, an expired/revoked no-persistence record, or an unapproved path template.

`multimodal-derivation-scheduler.ts` owns the only `maybeEnqueueMultimodalDerivation(tx, mediaId, processorVersion)` helper. The app root injects it into both transitions: (a) Plan 02's outcome transaction immediately after a media row becomes `ready`, and (b) Plan 01's canonical `message.added` append transaction immediately after Plan 02 has inserted `media_attachment_binding`. Both callers already hold the canonical room lock. The helper locks the media row and its unique binding, loads exactly `binding.source_event_id`, verifies that event's room/message identity and active lineage, ready state, owner/room lineage, approved modality, current processing authorization and not-deleting state, and returns without enqueue when either side is not yet present. It never scans for a lowest room sequence, changes source because of a later message, or writes a RoomEvent. Plan 02 permanently rejects a second logical message binding—even after revise/retract—so a retracted source can only cancel this lineage; it cannot silently migrate an existing artifact/job to another event.

When both halves exist, the helper inserts exactly one `multimodal.derive.v1` job using the shared dedupe key `multimodal.derive.v1:{mediaId}:{processorVersion}` and closed payload `{mediaId,sourceEventId,processorVersion}`; `source_event_id` and `worker_job.correlation_id` exactly copy the selected source RoomEvent, while room identity remains `WorkerJob.room_id`. `ON CONFLICT(dedupe_key) DO NOTHING` is only the last concurrency guard—the locked decision is tested in ready→message, message→ready and simultaneous transactions, each yielding the same single source/job. Unattached, quarantined, deleted or unauthorized media never enqueue.

`register_agent_handlers(registry)` registers `handle_multimodal_derive(job, deps)` from `multimodal_artifacts/handler.py`. The adapter validates payload/correlation/source ID and the current claim, then passes the full job and attempt-scoped cancellation into the handler. At provider-open it calls Plan 01 `room_lock.py`: canonical room advisory/session lock first, then room/message/media/binding/authorization rows, then the exact Worker job last. Only after every check does it insert the provider-processing record. A reclaimed token writes no record/request. The app-root `MultimodalSourceCancellationHook`, in the same canonical room-locked `message.retracted` transaction, locks the same domain rows before the job, sets cancellation fields and `status=cancelled` while clearing `claim_token/locked_at/locked_by`; the processing record gets `cancellation_requested_at`. The old attempt's heartbeat/control aborts and every later CAS fails. Tests cover enqueue→retract→claim, both global lock orders, and a running cancellation fixture whose old token subsequently produces zero provider/artifact/replay writes. It uses the single Plan 01 registry/room SQL and cannot collide with Plan 03's `derived_text.py` module.

After provider output is validated, the handler again takes Plan 01's canonical room lock, locks domain rows, then reloads the exact claim/content/authorization/deletion authority. A current content-invalid branch cancels and clears lease fields with zero artifact/replay; a stale claim writes nothing and cannot cancel the newer attempt. The all-current transaction creates/links one immutable artifact, calls the sole replay enqueue helper and inserts `complete_business(...,"MULTIMODAL_DERIVATION_COMPLETED")`. Same-claim response retry validates that stable marker; a max-attempt crash afterward is recovered succeeded without a second provider call/artifact/replay. Tests pause/reclaim before pre-call and post-response, inspect raw tables for zero old-token mutations and verify cancelled rows have NULL lease fields, plus deletion/supersession/abstention/no-duplicate uptake.

- [ ] **Step 5: Run artifact and configuration tests, then commit**

Run: `cd learning-orbit && pnpm vitest run apps/server/test/agent/multimodal-job-enqueue.test.ts apps/server/test/agent/multimodal-enqueue-order.test.ts && .venv/bin/python -m unittest services/worker/tests/test_artifact_pipeline.py services/worker/tests/test_provider_manifest.py services/worker/tests/test_openai_compatible_multimodal.py -v`  
Expected: PASS; the central registry owns both new job types, every external call has a pre-call lifecycle record and later artifact link, attachment lineage is preserved, replay is deduplicated, and no artifact is approved automatically.  
Commit:

```bash
git add services/worker/src/learning_orbit_worker/providers services/worker/src/learning_orbit_worker/multimodal_artifacts services/worker/src/learning_orbit_worker/agent_handlers.py services/worker/tests/test_artifact_pipeline.py services/worker/tests/test_provider_manifest.py services/worker/tests/test_openai_compatible_multimodal.py apps/server/src/app.ts apps/server/src/modules/agent/multimodal-derivation-scheduler.ts apps/server/src/modules/rooms/room-event-repository.ts apps/server/src/modules/media/media-status-service.ts apps/server/test/agent/multimodal-job-enqueue.test.ts apps/server/test/agent/multimodal-enqueue-order.test.ts
git commit -m "feat(multimodal): create versioned shadow artifacts"
```

### Task 7: Prove multimodal artifacts through the Plan 03 review owner

**Files:**
- Create: `learning-orbit/apps/server/test/agent/multimodal-review-fixtures.test.ts`
- Create: `learning-orbit/services/worker/tests/test_multimodal_review_replay.py`
- Reference: Plan 03 generated review schema, `/v1/rooms/:roomId/analytics/reviews`, handler, immutable correction RoomEvent, and replay worker

- [ ] **Step 1: Write approval, correction, and downstream invalidation tests**

```ts
for (const derivation of ["asr", "ocr", "image_description"] as const) {
  it(`corrects ${derivation} through Plan 03`, async () => {
    const artifact = await seedShadowArtifact({ derivation, fidelity: 0.61 });
    const response = await teacherClient.post(`/v1/rooms/${roomId}/analytics/reviews`, {
      body: generatedCorrectionReview(artifact, { correctionKind: "replace_text" })
    });
    expect(response.statusCode).toBe(201);
    expect(await activeArtifactVersion(artifact.artifactId)).toBe(2);
    expect(await replayParity(roomId)).toBe(true);
  });
}
```

- [ ] **Step 2: Run and verify missing review routes**

Run: `cd learning-orbit && pnpm vitest run apps/server/test/agent/multimodal-review-fixtures.test.ts`  
Expected: Plan 03 route exists; modality fixture integration assertions fail before this task.

- [ ] **Step 3: Reuse the Plan 03 review/correction owner**

Do not create `modules/review/*`, `/artifacts/:id/correct`, a parallel SessionGateway method, or another payload. Fixtures call `routes.analytics.reviews(roomId)` with generated `AnalyticsReviewCommand`; Plan 03 derives the teacher, stores full detail only in its teacher-only table, broadcasts a content-free immutable correction notice, supersedes prior evidence, and enqueues replay.

- [ ] **Step 4: Prevent review actions from becoming student grading**

Routes expose approve/reject/correct only for artifact fidelity and evidence extraction. They do not accept score, grade, ability, behavior-risk, personality, emotion, or discipline fields; contract tests reject those as additional properties.

- [ ] **Step 5: Run review/replay tests and commit**

Run: `cd learning-orbit && pnpm vitest run apps/server/test/analytics/review-correction-routes.test.ts apps/server/test/agent/multimodal-review-fixtures.test.ts && python3.12 -m unittest services/worker/tests/test_multimodal_review_replay.py -v`  
Expected: PASS; grading fields fail, prior contributions retract, and all three modalities replay to parity.  
Commit:

```bash
git add apps/server/test/agent/multimodal-review-fixtures.test.ts services/worker/tests/test_multimodal_review_replay.py
git commit -m "test(agent): prove multimodal correction through analytics owner"
```

### Task 8: Close Nova and shadow-mode integration gates

**Files:**
- Create: `learning-orbit/tests/integration/agent-shadow-protocol.test.ts`
- Create: `learning-orbit/tests/chaos/agent-worker-restart.test.ts`
- Create: `learning-orbit/docs/runbooks/agent-provider-outage.md`
- Create: `learning-orbit/docs/privacy/provider-data-flow.md`

- [ ] **Step 1: Write UI-independent protocol expectations**

```ts
test("teacher can request, observe, cancel, and review Nova without blocking students", async () => {
  const room = await fourStudentProtocolRoom();
  const trigger = await room.student(1).send("@Nova Agent 我们应检查哪一条证据？");
  const run = await room.student(1).requestAgent(trigger.eventId);
  expect((await room.teacher.getCurrentAgent()).run?.state).toBe("running");
  const human = await room.student(2).send("我先比较两次观察。");
  expect((await room.student(3).eventsAfter(human.roomSeq - 1)).events).toContainEqual(human);
  await room.teacher.cancelAgent(run.agentRunId);
  expect((await room.teacher.getCurrentAgent()).run?.state).toBe("cancelled");
  expect((await room.teacher.getCurrentAgent()).serviceHealth).toBe("healthy");
  await room.teacher.setAgentEnabled(false);
  expect((await room.student(1).getCurrentAgent()).agentEnabled).toBe(false);
});
```

- [ ] **Step 2: Run the test against the pre-gate system**

Run: `cd learning-orbit && pnpm vitest run tests/integration/agent-shadow-protocol.test.ts`  
Expected: FAIL until the generated REST, RoomEvent and WebSocket status paths operate together. This Gate has no dependency on Plan 05 UI.

- [ ] **Step 3: Add worker-restart and duplicate-finalization tests**

Chaos kills Worker before final ack and asserts one approved message. It races cancel, disable, and pause against provider completion; each wins before final append, writes one transition, never marks a cancelled job succeeded, leaks zero chunks, and resume does not resurrect old work.

- [ ] **Step 4: Document fail-closed provider operations**

The outage runbook contains detection, teacher-facing degraded copy, Agent disable action, queue inspection, recovery, replay, and incident evidence. The privacy data-flow lists fields sent to the provider and explicitly excludes student identity, room code, hidden analytics, signed URLs, and logs.

- [ ] **Step 5: Run the complete Gate 4 suite and commit**

Run:

```bash
cd learning-orbit
source .venv/bin/activate
pnpm test:contracts
pnpm vitest run apps/server/test/agent apps/server/test/analytics/review-correction-routes.test.ts
python3.12 -m unittest discover -s services/worker/tests -v
pnpm vitest run tests/integration/agent-shadow-protocol.test.ts
pnpm vitest run tests/chaos/agent-worker-restart.test.ts
```

Expected: PASS with fixture providers; pilot startup remains fail-closed until an approved provider manifest and secrets are present.  
Commit:

```bash
git add tests/integration/agent-shadow-protocol.test.ts tests/chaos docs/runbooks/agent-provider-outage.md docs/privacy/provider-data-flow.md
git commit -m "test(agent): close Nova and multimodal shadow gate"
```

## Gate 4 release criteria

- Nova uses `classroom_room.nova_actor_id`, never global config. Student/teacher requester columns enforce exactly one real FK; cross-room students fail. One active run and Plan 01 Agent-trigger rate limit hold.
- The suite runs inside Plan 01's activated Python 3.12 `.venv`; no system-Python alias or committed environment is assumed.
- Every state change writes head+transition. Cancel/disable sets job `cancel_requested_at` and both run/job cancelled; conditional success cannot win.
- Transition/control repositories and APIs are append-only until Plan 06 cascade. Teacher settings atomically controls enabled/cancel; students cannot.
- Paused rooms reject triggers and cancel active work at each checkpoint/final commit with `ROOM_PAUSED`; resume never restarts old runs.
- Provider chunks stay memory-only. Status/current derive serviceHealth solely from signed persisted health with 30s stale→unavailable.
- Allowed/warned output submits core Nova `message.added` with `mediaIds:[]` and bounded UUID provenance; held/failed sends status only.
- Production Nova output uses the registered core `message.added` payload. Plan 04 registers no production `agent.*` RoomEvent; the conformance test proves an unknown Agent namespace rolls back and only explicit registration permits a transaction. Any future production `agent.*` event requires its own generated payload schema and application-root registration.
- Plan 03 `analytics.*` projection frames remain on their independent projection Outbox and are not registered with `EventPayloadRegistry`.
- Student chat remains available during model, moderation, or worker failure.
- Provider, model, prompt, policy, input sequence range, evidence IDs, latency, tokens, and cost are auditable without storing hidden reasoning.
- ASR/OCR/image results are separate shadow artifacts with fidelity confidence, processor versions, source media, hashes, timestamps/bounding boxes, consent, and warnings.
- Each provider artifact has one `provider_processing_record` containing safe manifest/authorization/purpose/region/hash/version/times; absent approved manifest or consent fails before provider invocation, and no raw payload/secret is stored.
- Every Agent or multimodal provider invocation is durably registered before network I/O with exactly one closed lifecycle mode. Persisting providers implement idempotent delete plus unreadability probe; no-persistence mode requires scoped signed authority. Unknown probes or stale authority block the Plan 06 provider-copy receipt.
- Machine output is never student-authored; low confidence remains `displayStatus=teacher_shadow`, `reviewStatus=unreviewed`, warned and extraction-ineligible.
- ASR/OCR/image-description fixtures reuse Plan 03 generated review route/handler and immutable correction/replay; no `modules/review`, `/artifacts/:id/correct`, parallel gateway, or grading fields exist.
- External providers remain disabled until owner-approved provider and privacy records exist.

## Non-goals

- No autonomous grading, ranking, discipline, emotion, personality, mental-health, face, or voiceprint inference.
- No automatic student-visible publication of machine artifacts in this phase.
- No claim that Nova or multimodal analysis improves learning outcomes.
