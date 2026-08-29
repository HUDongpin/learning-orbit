# Learning Orbit Controlled Classroom Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the self-contained Learning Orbit HTML prototype into a real, supervised 4-student + 1 Nova Agent classroom pilot with durable multimodal chat, replayable ECHO-CM/TRACE-AI projections, teacher review, privacy deletion, and evidence-backed release gates.

**Architecture:** Build a new `learning-orbit/` monorepo around a persistent PostgreSQL room-event ledger, its transactional `outbox_event`, and a separate non-recursive `analysis_projection_outbox`. A responsive Next.js web app consumes REST/WebSocket events and projection pointers, a Fastify modular monolith owns identity/authorization/order, and one Python 3.12 worker deployment handles media, Agent, ECHO-CM, and TRACE-AI jobs; all derived state is versioned and reconstructable from source events.

**Tech Stack:** pnpm monorepo, Next.js App Router/React/TypeScript/CSS Modules, Fastify + `@fastify/websocket`, JSON Schema 2020-12, PostgreSQL 18 SQL migrations with no ORM, Python 3.12, S3-compatible private storage, ClamAV, Pillow, ffmpeg, OpenTelemetry, Vitest, Python unittest, Playwright, Docker Compose.

---

## 1. Source truth and claim ceiling

- Visual/interaction baseline: `../outputs/learning-orbit-demo.html` relative to the future `learning-orbit/` repository.
- Algorithm reference: `../work/learning_orbit_algorithms.py` and `../work/test_learning_orbit_algorithms.py`.
- Approved design: `../outputs/learning-orbit-controlled-pilot-design.md`.
- Current prototype functions locally but has no authentication, database, WebSocket, object storage, model call, OCR/ASR, Python connection, teacher console, or production data lifecycle.
- ECHO-CM and TRACE-AI remain “original engineering synthesis / research proposal, not peer reviewed.”
- Existing 73 Python and 19 HTML tests are regression inputs only. They do not prove extraction accuracy, learning effect, live safety, end-to-end latency, or production readiness.

## 2. Technical basis checked through 2026-08-29

- Use the [Next.js App Router](https://nextjs.org/docs/app) for the responsive web app; the official installation guide supports TypeScript, ESLint and App Router, and the official guides cover self-hosting and Playwright testing.
- Use [Fastify TypeScript](https://fastify.dev/docs/latest/Reference/TypeScript/) and the official [`@fastify/websocket`](https://github.com/fastify/fastify-websocket) plugin; the plugin exposes authenticated WebSocket routes and `injectWS` tests.
- Use [JSON Schema 2020-12](https://json-schema.org/specification) as the cross-language wire authority.
- Use PostgreSQL's [`FOR UPDATE SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html) for queue-like worker claims. PostgreSQL explicitly warns that it is not a general-consistency view, so it is used only for job claiming.
- Use PostgreSQL [`LISTEN/NOTIFY`](https://www.postgresql.org/docs/current/sql-notify.html) only as a commit-time wake-up; all consumers read durable outbox rows.
- Use [OpenTelemetry JavaScript](https://opentelemetry.io/docs/languages/js/) and Python instrumentation for traces/metrics, while keeping student content and secrets out of telemetry.

The first bootstrap commits exact pnpm/Python lockfiles. Later tasks must not rerun floating `latest` commands without an explicit dependency-upgrade review.

## 3. Repository structure

```text
learning-orbit/
├── apps/
│   ├── web/                         # Student responsive web + teacher console
│   │   ├── app/                     # Next.js App Router
│   │   ├── src/{session,auth,chat,media,agent,concept,sna,teacher,student,accessibility}/
│   │   └── app/globals.css
│   └── server/                      # Fastify REST/WS modular monolith
│       ├── src/modules/
│       ├── src/observability/
│       └── test/
├── packages/
│   ├── contracts/
│   │   ├── schemas/                 # Canonical JSON Schema 2020-12
│   │   ├── src/generated/           # Generated TypeScript wire types
│   │   ├── src/routes.ts
│   │   └── src/realtime.ts
│   ├── test-fixtures/               # Seven synthetic events and gold streams
│   └── ui/                          # Shared design tokens/primitives
├── services/
│   └── worker/                      # Python media/Agent/ECHO/TRACE worker
│       ├── src/learning_orbit_worker/
│       └── tests/
├── infra/
│   ├── docker-compose.yml
│   └── postgres/migrations/
├── tests/
│   ├── e2e/
│   ├── chaos/
│   ├── load/
│   ├── security/
│   └── pilot/
├── docs/
│   ├── adr/
│   ├── privacy/
│   ├── security/
│   ├── runbooks/
│   └── pilot/
└── scripts/
```

Each canonical payload exists once in `packages/contracts/schemas/`. TypeScript types are generated into `src/generated/`; Python validates the same schema at worker ingress. Do not maintain handwritten duplicate wire interfaces.

## 4. Subplan dependency graph

```text
Plan 01 Foundation + Realtime
   └── Plan 02 Private Media
          └── Plan 03 ECHO/TRACE Analytics
                  └── Plan 04 Nova + Multimodal Shadow
                          └── Plan 06 governance slice
                              (Tasks 3–4 backend/contracts only)
                                  └── Plan 05 Student/Teacher UI
                                          └── Plan 06 remaining reliability
                                              + pilot-admission work
```

Execution files:

1. `learning-orbit-plan-01-foundation-realtime.md`
2. `learning-orbit-plan-02-media.md`
3. `learning-orbit-plan-03-analytics.md`
4. `learning-orbit-plan-04-agent-multimodal.md`
5. `learning-orbit-plan-05-student-teacher-ui.md`
6. `learning-orbit-plan-06-reliability-pilot.md`

Plan 05 can develop fixture-backed views after Plan 01 contracts freeze, but its integration gate waits for Plans 02–04 plus the explicitly bounded Plan 06 governance slice that owns the two-phase `005_pilot_governance.sql`/`006_enforce_pilot_governance.sql`, export/deletion contracts and lifecycle routes. After Gate 5, return to Plan 06 for its remaining observability, chaos, security, accessibility, load, human-shadow and pilot-admission work. This task-level split is intentional and removes a circular dependency; it does not admit any pilot early.

## 5. Recommended staffing and calendar range

This is an engineering estimate, not a delivery promise:

| Role | Typical allocation | Main responsibility |
|---|---:|---|
| Product/learning researcher | 0.5 FTE | Classroom workflow, claim ceiling, teacher tasks, pilot evidence |
| Frontend engineer | 1–2 FTE | Responsive web, chat/media, graphs, teacher console, accessibility |
| Platform engineer | 1–2 FTE | Identity, REST/WS, PostgreSQL, object storage, operations |
| ML/analytics engineer | 1 FTE | ECHO/TRACE adapters, replay, provider/artifact pipeline |
| QA/security/privacy engineer | 1 FTE | E2E, chaos, threat model, deletion, release evidence |

With five effective contributors, plan for approximately 16–22 calendar weeks including shadow evaluation. With two engineers sharing all roles, plan for approximately 28–36 weeks. School/ethics approval, provider review and real classroom scheduling are external elapsed-time dependencies and must not be hidden inside engineering estimates.

## 6. Master execution tasks

### Task 0: Create the governed implementation repository and freeze baselines

**Files:**
- Create: `learning-orbit/.gitignore`
- Create: `learning-orbit/README.md`
- Create: `learning-orbit/scripts/assert-baseline.mjs`
- Create: `learning-orbit/packages/test-fixtures/prototype/learning-orbit-demo.html`
- Create: `learning-orbit/packages/test-fixtures/prototype/baseline.json`
- Copy exactly: `learning-orbit/docs/plans/{learning-orbit-controlled-pilot-design,learning-orbit-controlled-pilot-implementation-plan,learning-orbit-plan-01-foundation-realtime,learning-orbit-plan-02-media,learning-orbit-plan-03-analytics,learning-orbit-plan-04-agent-multimodal,learning-orbit-plan-05-student-teacher-ui,learning-orbit-plan-06-reliability-pilot}.md`

- [ ] **Step 1: Record source hashes before copying**

Run from the current workspace:

```bash
shasum -a 256 outputs/learning-orbit-demo.html work/learning_orbit_algorithms.py work/test_learning_orbit_algorithms.py
```

Expected current reference hashes:

- HTML: `4cbd52ff587d438b8813450672c15745d2c7c27f0d51f145306b42878f25ee9e`
- Algorithm: `3a2983b0f99cd016b45fb5fd7ee8e1ac4b93b3eee62f3a189a8e20df8c1cf220`
- Algorithm tests: `59ad56baa784fa187b6ea6a7cffcbba6138bfc945e43a2aa38fc6cce78560732`

If a hash differs, stop and inspect the changed source rather than silently updating the baseline.

Before creating the repository, verify local capacity:

```bash
available_kib=$(df -Pk . | awk 'NR==2 {print $4}')
test "$available_kib" -ge 26214400
docker system df
```

Expected: at least 25 GiB free on the workspace volume and a reviewed Docker usage report. This is a conservative engineering preflight for locked images, three builds, browser binaries, disposable databases/object storage and test evidence—not a product requirement. At plan-freeze time the volume had only about 116 MiB free, so implementation must stop until the owner frees or assigns sufficient storage. The execution agent may report candidate caches but may not delete unrelated `/private/tmp`, Docker, repository or user data without explicit scope.

- [ ] **Step 2: Initialize a narrow repository without modifying outputs**

Run:

```bash
mkdir -p learning-orbit/packages/test-fixtures/prototype learning-orbit/scripts learning-orbit/docs/plans
cd learning-orbit
git init -b main
```

Expected: an empty Git repository rooted at `learning-orbit/`; the parent `outputs/` files remain untouched.

All remaining Task 0 commands run with `learning-orbit/` as the current directory; verify with `test "$(basename "$PWD")" = learning-orbit` before writing.

- [ ] **Step 3: Add the baseline assertion script**

```js
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const baseline = JSON.parse(readFileSync(new URL("../packages/test-fixtures/prototype/baseline.json", import.meta.url)));
for (const [name, expected] of Object.entries(baseline.sha256)) {
  const actual = createHash("sha256").update(readFileSync(new URL(`../packages/test-fixtures/prototype/${name}`, import.meta.url))).digest("hex");
  if (actual !== expected) throw new Error(`${name} baseline mismatch: ${actual}`);
}
console.log("prototype baseline: pass");
```

- [ ] **Step 4: Copy the prototype and create a content-only baseline record**

Run:

```bash
cp ../outputs/learning-orbit-demo.html packages/test-fixtures/prototype/learning-orbit-demo.html
plan_names=(
  learning-orbit-controlled-pilot-design.md
  learning-orbit-controlled-pilot-implementation-plan.md
  learning-orbit-plan-01-foundation-realtime.md
  learning-orbit-plan-02-media.md
  learning-orbit-plan-03-analytics.md
  learning-orbit-plan-04-agent-multimodal.md
  learning-orbit-plan-05-student-teacher-ui.md
  learning-orbit-plan-06-reliability-pilot.md
)
for plan_name in "${plan_names[@]}"; do
  cp "../outputs/${plan_name}" "docs/plans/${plan_name}"
done
```

Create `baseline.json` with this exact content:

```json
{
  "sourceDate": "2026-08-28",
  "syntheticDataOnly": true,
  "claimBoundary": "Local interaction and visual regression baseline; not a backend, model, algorithm, safety, latency, or learning-effect proof.",
  "sha256": {
    "learning-orbit-demo.html": "4cbd52ff587d438b8813450672c15745d2c7c27f0d51f145306b42878f25ee9e"
  }
}
```

Create `.gitignore` with this exact content:

```gitignore
.env*
!.env.example
node_modules/
.next/
.venv/
__pycache__/
*.pyc
test-results/
playwright-report/
infra/data/
secrets/
```

Create `README.md` with this opening block, followed by repository-local links to the approved design, master plan, and six sub-plan files under `docs/plans/`:

```markdown
# Learning Orbit controlled classroom pilot

ECHO-CM and TRACE-AI are original engineering syntheses and research proposals. They are not peer-reviewed SOTA claims, learning-effect evidence, individual assessment instruments, or production SLA proof.

`packages/test-fixtures/prototype/` is synthetic regression evidence only. Production code must never fall back to it when a server, model, media processor, or analytics worker is unavailable.
```

- [ ] **Step 5: Assert and commit the repository baseline**

Copy the approved design/master/six sub-plans from the parent `outputs/` directory through the eight-name allowlist above—never a wildcard—and make README links point to `docs/plans/`. Before commit, the same array drives `cmp -s` for each source/copy and requires exactly eight regular files under `docs/plans/`; missing, extra or drifted files fail. The parent files remain untouched and are not treated as mutable runtime dependencies after this baseline commit.

Run:

```bash
plan_names=(
  learning-orbit-controlled-pilot-design.md
  learning-orbit-controlled-pilot-implementation-plan.md
  learning-orbit-plan-01-foundation-realtime.md
  learning-orbit-plan-02-media.md
  learning-orbit-plan-03-analytics.md
  learning-orbit-plan-04-agent-multimodal.md
  learning-orbit-plan-05-student-teacher-ui.md
  learning-orbit-plan-06-reliability-pilot.md
)
node scripts/assert-baseline.mjs
test "$(rg --files docs/plans -g '*.md' | wc -l | tr -d ' ')" = 8
for plan_name in "${plan_names[@]}"; do
  cmp -s "../outputs/${plan_name}" "docs/plans/${plan_name}" || exit 1
done
```

Expected: `prototype baseline: pass`; plan count/equality commands exit `0` with no output.  
Commit:

```bash
git add .gitignore README.md scripts packages/test-fixtures/prototype docs/plans
git commit -m "chore: freeze Learning Orbit prototype baseline"
```

### Task 1: Execute and admit Plan 01

**Plan:** `learning-orbit-plan-01-foundation-realtime.md`

- [ ] Execute Plan 01 task-by-task with a fresh test-first commit for each task.
- [ ] Run: `cd learning-orbit && pnpm test:contracts && pnpm test:server && pnpm test:realtime && pnpm typecheck`.
- [ ] Expected: four students and one teacher complete a real text room; duplicate/lost acknowledgements do not duplicate events; reply/mention/revise/retract survive reconnect.
- [ ] Record schema hashes, migration IDs, commands and exit codes in `test-results/gate-01.json`.
- [ ] Do not start real media or model work while Gate 01 is red.

### Task 2: Execute and admit Plan 02

**Plan:** `learning-orbit-plan-02-media.md`

- [ ] Execute all media contract, storage, scanner, image UI, recorder and lifecycle tasks.
- [ ] Persist every issuing/active upload grant before a URL can be exposed; anchor the ledger to presigner-returned actual times, upload only to staging, conditionally promote one ETag/hash to a write-once original, prove bounded PUT duration/strong exact-key HEAD, and fence finalize/derivative writes with the shared room deletion lock. The first promotion intent also persists the complete room-scoped `media.reconcile-upload.v1` row and immutable correlation; Python calls the exact-audience internal endpoint while TypeScript remains the sole reconciliation owner, and every Node/Python object-store call has a hard total deadline plus lock-release proof.
- [ ] Run the exact Gate 2 command block from Plan 02.
- [ ] Expected: private image/audio messages survive refresh/reconnect, preserve reply provenance, reject cross-room access and close the idempotent media-deletion surface; Plan 02 does not issue the global deletion receipt.
- [ ] Record reports in `test-results/gate-02.json` without signed URLs, captions, media bytes or audio.
- [ ] Keep OCR/ASR/image understanding disabled until Plan 04 shadow gates.

### Task 3: Execute and admit Plan 03

**Plan:** `learning-orbit-plan-03-analytics.md`

- [ ] Hash-pin and copy the tested Python reference into the worker package while preserving the source and its 73-test suite.
- [ ] Freeze internal-to-wire adapters and correct the synthetic event-direction gold fixture.
- [ ] Replace browser hardcoded action packs/metrics with deterministic projection events.
- [ ] Run online/replay, duplicate, revise, retract, late event, version-gap and correction parity tests.
- [ ] Expected: every visible relation has valid evidence; Organization Graph links never appear as factual edges; same event stream yields the same projection hash.

### Task 4: Execute and admit Plan 04

**Plan:** `learning-orbit-plan-04-agent-multimodal.md`

- [ ] Implement explicit Nova trigger/cancellation and provider-neutral execution with fixture tests.
- [ ] Implement fail-closed Agent output safety and final Room Command submission.
- [ ] Implement ASR/OCR/image-description artifacts as teacher-only shadow records with separate confidence dimensions.
- [ ] Use one locked `maybeEnqueueMultimodalDerivation` helper from both `media→ready` and confirmed `message.added` transitions; ready→message, message→ready and concurrent fixtures must each yield exactly one identical job, while provider-open rechecks active message/media lineage so enqueue→retract produces zero external request.
- [ ] Before every provider network call, persist its stable invocation/lifecycle record; require either idempotent remote delete plus unreadability probe or current exact-scope signed no-persistence authority, and keep unknown outcomes fail-closed for the later deletion receipt.
- [ ] Consume Plan 03's single immutable teacher review/correction route for multimodal artifacts and prove downstream replay; do not create a second review owner.
- [ ] Stop before external provider activation unless the owner-approved provider manifest and secret variable names are present; never substitute a fixture or another provider silently.

### Task 4A: Execute the bounded Plan 06 governance prerequisite

**Plan slice:** `learning-orbit-plan-06-reliability-pilot.md`, Tasks 3–4 backend/contracts only

- [ ] Implement and test the two-phase `005_pilot_governance.sql` + `006_enforce_pilot_governance.sql`, signed retention-policy and provider-copy-authority import/mapping, the shared room-scoped authorization guard, per-key student promotion default-deny, inbound/outbound WebSocket reauthorization with 4401/4403/4410 semantics, retention scheduler, frozen upload/media/provider manifests, dependency-ordered deletion, deletion/export schemas and server routes.
- [ ] Do not run or claim the later Plan 06 UI, load, human-shadow or pilot-admission gates in this slice.
- [ ] Expected: Plan 05 can import generated lifecycle contracts and exercise real role-gated ports without a fixture masquerading as a server implementation.
- [ ] Record this bounded prerequisite as `test-results/gate-04a-governance.json`; it is not Gate 6 and does not authorize student-visible analytics.

### Task 5: Execute and admit Plan 05

**Plan:** `learning-orbit-plan-05-student-teacher-ui.md`

- [ ] Rebuild the prototype as focused React modules while preserving its visual hierarchy and responsive contract.
- [ ] Connect all UI state to the real event/projection gateways; production failure never falls back to demo fixtures.
- [ ] Complete student pseudonym and group-safe views plus teacher provenance/review/export/delete controls.
- [ ] Run component, keyboard, screen-reader, five-viewport, reduced-motion, graph/list parity and screen-pixel SNA geometry tests, including dense non-self/mixed port-capacity reflow and the exact canonical student SNA claim-ceiling sentence.
- [ ] Expected: chat, concept and SNA show a common completeness cursor before announcing synchronized completion.

### Task 6: Implement Plan 06 technical controls and freeze pre-shadow tooling

**Plan:** `learning-orbit-plan-06-reliability-pilot.md`

- [ ] Add redacted telemetry and verify no student content/secrets enter logs or traces.
- [ ] Execute Plan 06 Task 3 Step 5 only now, after Gate 5: drive the real Web components through the untrusted-rendering/security regression red state, implementation, green state and separate commit.
- [ ] Run event/worker/outbox/replay chaos, authorization, XSS/media, deletion and load suites, including a signed PUT and derivative write released after the first deletion sweep plus a queued RoomEvent pumped after session revocation.
- [ ] Run all accessibility and screen-pixel graph gates.
- [ ] Complete Plan 06 Task 7 only through its synthetic rehearsal and protocol commit; treat it only as playbook/validator evidence and do not conduct a human shadow yet.
- [ ] Complete Plan 06 Task 8 only through its release-tooling commit. Stop before its final evidence/human-admission step.
- [ ] Expected: all product, test, protocol and release-tooling source is committed, but no external authorization, human shadow, promotion or pilot-ready claim has been manufactured.

### Task 7: Freeze the program gate, then conduct final evidence and authorized human admission

**Files:**
- Create: `learning-orbit/scripts/assert-program-contracts.ts`
- Create: `learning-orbit/docs/release/program-acceptance.md`

- [ ] **Step 1: Compare generated wire types against canonical schema hashes**

The script loads every schema, the generated TypeScript manifest and Python ingress manifest, and rejects missing/extra schema IDs or mismatched SHA-256. At assertion time it also flattens the exported generated `routeContract`, reads the generated realtime discriminators, and invokes the canonical Worker composition root in no-I/O manifest mode to list registered handler names; the matching test manifest must mark each route/frame/job as exercised. No handwritten runtime registry is created for the gate.

- [ ] **Step 2: Assert route and event coverage**

```ts
const generatedManifest = readJson(
  "packages/contracts/src/generated/manifest.json"
);
const pythonIngressManifest = readJson(
  "services/worker/src/learning_orbit_worker/generated/manifest.json"
);
for (const manifest of [generatedManifest, pythonIngressManifest]) {
  assert.deepEqual(Object.keys(manifest).sort(), ["generatedModules", "schemaVersion", "sourceSchemas"]);
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(!("sourceSchemaFiles" in manifest));
  assert.ok(!("schemaSha256" in manifest));
}
const requiredRoomEvents = [
  "room.opened", "room.paused", "room.resumed", "room.closed",
  "message.added", "message.revised", "message.retracted",
  "analytics.review.recorded.v1", "analytics.correction.recorded.v1",
];
const requiredProjectionKeys = [
  "echo.teacher_shadow", "echo.student_approved",
  "trace.teacher_bundle", "trace.student_bundle",
];
const requiredRealtimeFrames = {
  client: ["hello", "command", "presence", "typing", "heartbeat"],
  server: ["welcome", "ack", "reject", "event", "presence", "typing", "projection", "media_status", "agent_status", "resume_complete", "snapshot_required", "degraded", "heartbeat"],
};
const requiredRouteNames = [
  "auth.session", "auth.teacherMagicLink", "rooms.create", "rooms.join", "rooms.get", "rooms.events", "rooms.websocket", "rooms.export", "rooms.delete",
  "media.upload", "media.complete", "media.get", "media.download",
  "internal.rooms.autoClose", "internal.media.reconcileUpload", "internal.media.outcome", "internal.agent.complete", "internal.agent.health", "internal.lifecycle.mediaSurface",
  "analytics.latest", "analytics.patches", "analytics.timeline", "analytics.artifacts", "analytics.reviews",
  "agent.request", "agent.cancel", "agent.current", "agent.settings",
  "deletions.get", "deletions.forRoom",
];
const requiredWorkerJobTypes = [
  "room.auto-close.v1", "media.process.v1", "media.reconcile-upload.v1", "analytics.consume.v1",
  "analytics.replay-room.v1", "agent.execute.v1", "multimodal.derive.v1",
  "retention.expire-surface.v1", "room.delete-surface.v1",
];
const highRiskSchemas = [
  "room-command.v1.json", "room-event-envelope.v1.json",
  "core-room-event-payloads.v1.json", "room-http.v1.json",
  "auth-session.v1.json", "auth-http.v1.json", "realtime-frame.v1.json",
  "media-command.schema.json", "media-status.v1.json",
  "media-attachment-view.v1.json", "media-internal-reconcile.v1.json",
  "media-internal-outcome.v1.json", "room-internal-auto-close.v1.json",
  "agent-internal-command.v1.json", "agent-provider-health.v1.json", "derived-text-artifact.v1.json",
  "derived-text-artifact-page.v1.json", "analysis-projection-envelope.v1.json",
  "analytics-review-command.v1.json",
  "analytics-review-room-event-payloads.v1.json",
  "echo-concept-projection.v1.json",
  "trace-projection.v1.json", "agent-run.schema.json",
  "agent-status.v1.json", "agent-current-state.v1.json",
  "agent-command.v1.json", "moderation-decision.schema.json",
  "deletion-lifecycle.v1.json", "pilot-retention-policy-record.v1.json",
  "provider-copy-authority-record.v1.json", "lifecycle-internal-media-surface.v1.json",
  "pilot-authority-record.v1.json",
];
for (const eventType of requiredRoomEvents) {
  assert.ok(contractManifest.roomEventTypes.includes(eventType), `missing RoomEvent ${eventType}`);
  assert.ok(testManifest.coveredRoomEventTypes.includes(eventType), `untested RoomEvent ${eventType}`);
}
for (const key of requiredProjectionKeys) {
  assert.ok(contractManifest.projectionKeys.includes(key), `missing projection ${key}`);
  assert.ok(testManifest.coveredProjectionKeys.includes(key), `untested projection ${key}`);
}
assert.deepEqual([...contractManifest.realtimeFrames.client].sort(), [...requiredRealtimeFrames.client].sort());
assert.deepEqual([...contractManifest.realtimeFrames.server].sort(), [...requiredRealtimeFrames.server].sort());
for (const routeName of requiredRouteNames) assert.ok(routeManifest.registeredAndTested.includes(routeName), `missing/untested route ${routeName}`);
for (const jobType of requiredWorkerJobTypes) assert.ok(workerManifest.registeredAndDispatched.includes(jobType), `missing/undispatched job ${jobType}`);
assert.deepEqual(contractManifest.schemaFiles, discoverCanonicalSchemasOnDisk());
assert.deepEqual(generatedManifest.sourceSchemas, pythonIngressManifest.sourceSchemas);
assert.deepEqual(contractManifest.schemaFiles, generatedManifest.sourceSchemas.map((source) => source.file));
for (const source of generatedManifest.sourceSchemas) {
  assert.equal(source.sha256, sha256CanonicalSchema(source.file));
  assert.equal(source.id, readCanonicalSchemaId(source.file));
}
for (const schema of highRiskSchemas) {
  assert.ok(contractManifest.schemaFiles.includes(schema), `missing schema ${schema}`);
  assert.ok(generatedManifest.sourceSchemas.some((source) => source.file === schema), `ungenerated schema ${schema}`);
  assert.ok(pythonIngressManifest.sourceSchemas.some((source) => source.file === schema), `missing Python ingress hash ${schema}`);
}
assert.ok(generatedManifest.generatedModules.every((entry) => entry.language === "typescript"));
assert.ok(pythonIngressManifest.generatedModules.every((entry) => entry.language === "python"));
assert.deepEqual(
  pythonIngressManifest.generatedModules.map((entry) => entry.sourceFile).sort(),
  generatedManifest.sourceSchemas.filter((source) => readCanonicalSchema(source.file)["x-learning-orbit-python-ingress"] === true).map((source) => source.file).sort()
);
for (const invariant of [
  "room_lock_node_python_container_parity",
  "service_assertion_full_claim_round_trip",
  "media_checksum_and_single_lineage",
  "provider_copy_closure_two_owner_race",
] as const) {
  assert.equal(testManifest.crossPlanInvariants[invariant], "passed", `unproved invariant ${invariant}`);
}
assert.equal(contractManifest.projectionFramesCreateRoomEvents, false);
```

The sole generator writes deterministic version-1 manifests at `packages/contracts/src/generated/manifest.json` and `services/worker/src/learning_orbit_worker/generated/manifest.json`. Their only allowed top-level keys are `schemaVersion`, `sourceSchemas`, and `generatedModules`; both list the same sorted canonical `{file,id,sha256}` source set, while language-specific module entries differ. Legacy manifest fields fail the gate. The gate loads those exact paths and rejects missing/extra/hash-drifted sources before route tests. Every required route—including named internal and separately guarded health routes—is `registeredAndTested`. Worker evidence proves persisted correlation/claim, scoped heartbeat, the two-command candidate-lock→fresh-snapshot settle protocol, CAS transitions and completion markers. It verifies table permissions/shape, token-hash matching, success-without-marker rejection, cleanup and one family-stable marker in every final business transaction. Each family survives a maximum-attempt kill after marker without external replay; old tokens write zero and cancellation clears leases. No in-memory identity is proof.

The gate also verifies four cross-plan invariants rather than trusting prose. First, Node and Python execute the same database-owned room-lock key SQL and global lock order; the installed Worker image carries byte-identical claim/room-lock SQL. Second, every job-bound internal request contains and signs the complete persisted claim tuple, is produced by the one Worker Ed25519 signer/client, and is consumed by the one server verifier plus `JobClaimAuthority`; provider health is the only separately scoped non-job variant. Third, image/audio uploads carry a browser-computed SHA-256 from grant request through the exact signed checksum header, strong storage HEAD and immutable promotion, while one media ID binds to one logical message lineage. Fourth, retention and teacher deletion converge through one content-free `provider_copy_closure`, so whichever owner wins can remove the locator-bearing processing row without making the other owner mistake missing provenance for success. Each invariant has cross-language, two-order and crash/restart fixtures in the owning sub-plan.

- [ ] **Step 3: Commit the program gate before collecting evidence**

```bash
git add scripts/assert-program-contracts.ts docs/release/program-acceptance.md
git commit -m "chore(release): close Learning Orbit controlled pilot plan"
```

Expected: this is the final source/tooling commit; the working tree is clean, no generated report is staged, and no human shadow has yet been conducted against an earlier commit.

- [ ] **Step 4: Run the full fresh verification story on that exact commit**

Run:

```bash
cd learning-orbit
pnpm verify:pilot
node scripts/verify-python-lock.mjs
.venv/bin/python -c 'import sys; assert sys.version_info[:2] == (3, 12)'
.venv/bin/python -m unittest discover -s services/worker/tests -v
pnpm playwright test
pnpm tsx scripts/assert-program-contracts.ts --out test-results/program-contracts.json
pnpm tsx scripts/build-pilot-evidence.ts \
  --out test-results/pilot-evidence.json \
  --require-report programContracts=test-results/program-contracts.json
pnpm tsx scripts/assert-engineering-ready.ts test-results/pilot-evidence.json
```

If and only if that passes, execute Plan 06 Task 8 Step 5's external-authorization verification, actual non-student teacher shadow and separate student-promotion decision against this exact commit/bundle. Those are controlled human actions, not commands that Codex may synthesize. Then run:

```bash
cd learning-orbit
pnpm tsx scripts/assert-pilot-ready.ts test-results/pilot-evidence.json \
  --authority "$CONTROLLED_AUTHORIZATION_RECORD" \
  --shadow "$CONTROLLED_HUMAN_SHADOW_RECORD" \
  --promotion "$CONTROLLED_STUDENT_PROMOTION_RECORD" \
  --trust-config "$CONTROLLED_AUTHORITY_TRUST_CONFIG"
```

Expected: technical commands and the program-contract assertion pass on one frozen commit, then `build-pilot-evidence.ts` is rerun after those fresh reports and binds their hashes, commit and environment into a new bundle. The engineering assertion rejects a bundle that predates `program-contracts.json`, omits it or names another commit. Only after that pass may the team follow Plan 06 Task 8 Step 5 to validate external authorization, conduct the actual non-student teacher shadow, obtain a separate promotion and run the final pilot assertion. The final assertion passes only with current, linked, non-synthetic, cryptographically verified human-authority records and a controlled trust configuration; otherwise it stops with an explicit authority code without weakening the engineering result. No source commit occurs after the technical evidence or human shadow.

- [ ] **Step 5: Inspect visual/privacy evidence and retain sign-off outside Git**

Review every required viewport screenshot, Agent/analytics degraded state, teacher review flow, deletion receipt, log sample and provider data-flow. Reject the gate for clipped controls, misleading “live” status, unredacted content, personal ranking, stale-source ambiguity or inaccessible graph-only information.
Store reviewed screenshots, command reports, authority-record hashes and named human sign-off in the controlled evidence store. Do not commit transient/private evidence. No source commit may follow the evidence run; any source change invalidates the bundle and requires Steps 4–5 again.

## 7. Release gates and stop conditions

| Gate | Required evidence | Stop condition |
|---|---|---|
| 0 Contracts/privacy | Schema, roles, threat model, consent/retention/deletion policy | No real minor data before approval |
| 1 Realtime classroom | Ordered durable room, auth, reconnect, revise/retract | Any loss, duplicate or cross-role action |
| 2 Media | Private upload, scan, transform, access, deletion | Public/readable/quarantined media leak |
| 3 Analytics | Adapter parity, provenance, replay hash, no hardcoded metrics | Unsupported edge or online/replay drift |
| 4 Agent shadow | Explicit trigger, cancel, policy hold, provider audit, corrections | Agent publishes without final safety/teacher policy |
| 5 Student/teacher UI | Safe views, evidence inspector, graph/list/a11y parity | Ranking, identity leak, inaccessible semantics |
| 6 Pilot admission | Chaos/security/privacy/load bundle plus external authorization, completed human shadow and separate student-promotion record | Any stale, synthetic, unsigned, missing, out-of-scope or cross-commit evidence |

External provider credentials, school approval and research/ethics approval are authority gates. The implementation team must stop, not work around them.

## 8. Definition of “all prototype functions implemented”

The objective is complete only when:

- Four separate student clients and one teacher client can join one authorized room and remain consistent across disconnect/reconnect.
- Text, reply, mention, revise, retract, image and audio are durable, attributable and deletable.
- The header shows the server-derived fixed 45-minute countdown; presence/typing are expiring non-ledger signals with no false online count, and inquiry chips only draft editable text without promising an analysis update.
- Nova runs on explicit triggers, can be muted/cancelled, preserves context provenance and fails safely.
- ECHO-CM and TRACE-AI consume committed events, produce versioned evidence-backed projections and reproduce from replay.
- Concept graph/list/timeline and SNA graph/list with server-generated `recent_10m`/`session_45m` × three structural views are driven by the same server projection versions; SNA presentation pause never pauses chat/concept or fabricates a cursor.
- Teacher corrections propagate through replay; students see only pseudonymous, learner-safe interpretations.
- ECHO and TRACE student visibility is independently default-deny, promotion-scoped and immediately cleared on targeted revocation without disabling chat.
- Every failure mode has honest pending/degraded/stale/rebuilding/failed copy; no fixture masquerades as live behavior.
- Privacy export/deletion, authorization, accessibility, screen-pixel graph routing and controlled-pilot admission gates all pass.

## 9. Explicit non-goals and non-claims

Passing this plan does not prove multi-school production readiness, production SLA, causal Agent benefit, learning outcome improvement, psychological validity or individual student assessment. Those claims require separately approved deployment and research evidence.
