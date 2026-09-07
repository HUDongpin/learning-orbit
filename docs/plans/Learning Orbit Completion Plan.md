# Learning Orbit Completion Plan

Transcribed from the plan artifact
<https://claude.ai/code/artifact/99f1b5db-c662-4e94-8e39-1fa4542fe66d>, which was
mapped against the eight approved plans in `docs/plans/` at commit `81eeec5` on
branch `feat/orbit-canvas-ui`. It is written down here so the scope this work is
measured against lives in the repository rather than only in a chat.

49 tasks close 149 verified gaps in six phases. Effort spread: 5 small,
13 medium, 25 large, 6 extra-large.

## Tasks

| Task | Size | Gaps | What it does | Verify with |
| --- | --- | --- | --- | --- |
| E1 | S | 4·2 | Install the pinned Node 24.19.x toolchain and unbind preflight from the Codex runtime | `node scripts/verify-layout.mjs && node --version` |
| E2 | M | 4·3 | Restore Docker, free port 55432, and reproduce all database evidence on PostgreSQL 18 | `docker compose -f infra/docker-compose.pilot.yml up -d && pnpm db:migrate:test` |
| E3 | S | 4·2 | Re-pin required-test manifest counts and make the DB-gated suites mandatory | `pnpm exec vitest run tests/pilot --project cross-node --allowOnly=false` |
| E4 | S | 3·1 | Write the local development runbook and a one-command bootstrap | `bash docs/runbooks/local-dev.md steps, then open https://localhost:3000/login` |
| R1 | L | 1·1 | Add the media-internal-outcome contract, route and status service | `pnpm --filter @learning-orbit/server exec vitest run test/media` |
| R2 | L | 3·3 | Add internal.agent.complete, the worker submission path and the completion marker | `pnpm --filter @learning-orbit/server exec vitest run test/agent` |
| R3 | L | 1·1 | Add internal.lifecycle.mediaSurface and the media deletion lifecycle store | `pnpm --filter @learning-orbit/server exec vitest run test/governance` |
| R4 | S | 3·1 | Fix internal-route admission: origin exemptions and assertion-before-parse | `pnpm --filter @learning-orbit/server exec vitest run test/security/origin-rate-limit.test.ts` |
| R5 | M | 9 | Complete the realtime signal contract: degraded frames, presence tombstones, frame parsing | `pnpm --filter @learning-orbit/server exec vitest run test/realtime` |
| M1 | M | 1·1 | Add MinIO, ClamAV and transform services to compose with a private-bucket init | `docker compose -f infra/docker-compose.pilot.yml up -d minio clamav && node scripts/init-private-bucket.mjs` |
| M2 | L | 1·1 | Implement the real S3-compatible object-store transport | `pnpm --filter @learning-orbit/server exec vitest run test/media/s3-media-store-boundary.test.ts` |
| M3 | XL | 1·1 | Implement the Python media processor: scan, sanitize, transcode | `.venv/bin/python -m unittest discover -s services/worker/tests -t services/worker` |
| M4 | L | 7·3 | Close the media integrity gaps: janitor, write fence, reconcile and finalize | `pnpm --filter @learning-orbit/server exec vitest run test/media test/integration/media-finalize.test.ts` |
| M5 | L | 4·4 | Prove the media pipeline: server, worker and real-browser suites | `pnpm exec playwright test --config apps/web/playwright.config.ts` |
| N1 | L | 3·3 | Build the provider port: manifest loader, health probe, copy lifecycle, processing tables | `pnpm --filter @learning-orbit/server exec vitest run test/agent && .venv/bin/python -m unittest services.worker.tests.test_provider_health_contract` |
| N2 | L | 1·1 | Implement one reviewed LLM provider adapter behind the manifest | `LO_AGENT_PROVIDER_MANIFEST=... .venv/bin/python -m unittest discover -s services/worker/tests -t services/worker` |
| N3 | XL | 6·4 | Inject the executor and make the run real: context, prompt artifact, safety decisions | `.venv/bin/python -m unittest discover -s services/worker/tests -t services/worker` |
| N4 | M | 3·2 | Reconcile agent run lifecycle with job death, cancel and room transitions | `pnpm --filter @learning-orbit/server exec vitest run test/agent` |
| N5 | M | 2·2 | Wire the web client to request and cancel Nova, with provenance disclosure | `pnpm --filter @learning-orbit/web exec vitest run src/lib/agent` |
| N6 | XL | 4·4 | Build the multimodal derivation pipeline end to end | `.venv/bin/python -m unittest discover -s services/worker/tests -t services/worker` |
| N7 | L | 3·2 | Prove Nova: server suites, shadow protocol and outage runbooks | `pnpm --filter @learning-orbit/server exec vitest run test/agent && pnpm exec vitest run tests/chaos` |
| A1 | M | 1·1 | Fix replay so late events are actually admitted | `.venv/bin/python -m unittest services.worker.tests.unit.test_projector_replay` |
| A2 | M | 2·1 | Allow teacher review and correction after the room closes | `pnpm --filter @learning-orbit/server exec vitest run test/analytics` |
| A3 | M | 7·3 | Make the worker supervisor survive transient failure and classify its errors | `.venv/bin/python -m unittest services.worker.tests.test_main services.worker.tests.test_jobs` |
| A4 | L | 8·3 | Close the Gate 3 analytics evidence bundle | `pnpm analytics:gate3` |
| G1 | L | 2·1 | Introduce the single authorizeRoomAction guard and governed analytics access | `pnpm --filter @learning-orbit/server exec vitest run test/security` |
| G2 | L | 1·1 | Build the signed policy importer and controlled-authority verifier | `pnpm tsx scripts/import-approved-pilot-policy.ts --dry-run` |
| G3 | L | 3·3 | Implement student analytics promotion, its listener and targeted revocation | `pnpm --filter @learning-orbit/server exec vitest run test/analytics test/lifecycle` |
| G4 | L | 1·1 | Add the retention scheduler and the retention.expire-surface.v1 job | `.venv/bin/python -m unittest services.worker.tests.test_lifecycle` |
| G5 | XL | 7·3 | Make deletion complete for a real room and issue an honest receipt | `pnpm --filter @learning-orbit/server exec vitest run test/governance test/integration/governance-deletion.test.ts` |
| G6 | M | 1·1 | Audit every authorization decision, not just deletion and export | `pnpm --filter @learning-orbit/server exec vitest run test/security` |
| U1 | S | 1·1 | Render the server-derived 45-minute countdown | `pnpm --filter @learning-orbit/web exec vitest run app/session` |
| U2 | L | 4·1 | Add the ProjectionCoordinator and honest degraded rendering | `pnpm --filter @learning-orbit/web exec vitest run src/lib/session src/lib/analytics` |
| U3 | M | 2·1 | Move graph/list, scope and window selections into validated URL state | `pnpm --filter @learning-orbit/web exec vitest run src/lib/session/room-route.test.ts` |
| U4 | L | 4·4 | Meet the screen-pixel SNA geometry contract | `pnpm exec playwright test --config apps/web/playwright.config.ts --grep sna` |
| U5 | L | 3·2 | Deepen the teacher review console to the evidence contract | `pnpm --filter @learning-orbit/web exec vitest run src/lib/teacher` |
| U6 | M | 3·1 | Enforce the student-safe view and the claim-ceiling disclosure | `pnpm --filter @learning-orbit/web exec vitest run src/lib/analytics` |
| U7 | M | 1·1 | Add the untrusted-content rendering boundary and security regression suite | `pnpm exec vitest run tests/security --project cross-security` |
| U8 | XL | 10·2 | Complete the Gate 5 accessibility, visual and journey matrix | `pnpm exec playwright test --config apps/web/playwright.config.ts` |
| P1 | L | 1·1 | Wire real OpenTelemetry with redaction on both runtimes | `pnpm --filter @learning-orbit/server exec vitest run test/observability && .venv/bin/python -m unittest services.worker.tests.test_observability` |
| P2 | L | 2·2 | Build the container images and the same-origin production ingress | `node scripts/verify-worker-runtime-sql.mjs` |
| P3 | XL | 2·2 | Add fault-control routes and the chaos suite | `pnpm exec vitest run tests/chaos --project cross-node --sequence.concurrent=false` |
| P4 | L | 3·3 | Restore the missing Plan 01 proofs | `pnpm --filter @learning-orbit/server exec vitest run test/rooms test/realtime` |
| P5 | L | 5·2 | Restore the pinned k6 load harness and make its assertions real | `pnpm load:pilot && pnpm tsx tests/load/assert-pilot-results.ts` |
| Z1 | L | 3·3 | Make the generator emit Python and restore manifest parity | `pnpm contracts:generate && git diff --exit-code` |
| Z2 | M | 1·1 | Emit programmatic route, frame and job coverage manifests | `pnpm --filter @learning-orbit/contracts test` |
| Z3 | L | 1·1 | Write the Task 7 program gate | `pnpm tsx scripts/assert-program-contracts.ts --out test-results/program-contracts.json` |
| Z4 | L | 1·1 | Build the release evidence chain | `pnpm verify:pilot` |
| Z5 | L | 1·1 | Build the authority and shadow evidence tooling | `pnpm tsx scripts/verify-controlled-authority.ts --fixture` |

## Phases, each with a real exit

The order is not preference. The harness has to be trustworthy before any
result counts; the return path has to exist before media or Nova can report
anything; deletion and promotion are built before student-facing polish because
they are the privacy promises the pilot answers for.

1. **Make the harness honest** — E1 E2 E3 E4.
   Exit: `pnpm verify:local-pilot` produces a passing receipt on PostgreSQL 18
   with Node 24.19.x, and every manifest count matches a real run.
2. **Close the return path** — R1 R2 R3 R4 R5.
   Exit: all six internal routes are registered and tested; a worker result
   changes server state for media, agent and deletion surfaces.
3. **Media and analytics correctness** — M1 M2 M3 M4 M5 A1 A2 A3 A4.
   Exit: an image and an audio clip travel upload to scan to derivative to
   signed playback in a browser; replay admits a late event and reproduces the
   online hash.
4. **Nova and governance** — N1..N7 G1..G6.
   Exit: Nova answers on an explicit trigger and can be cancelled; a promoted
   student sees approved projections and loses them on revocation; a room with
   media deletes to a receipt.
5. **Surfaces and reliability** — U1..U8 P1..P5.
   Exit: Gate 5 accessibility, viewport and geometry suites pass; chaos
   scenarios recover with zero chat loss; the load fixture reports real error
   rates.
6. **Freeze and assert** — Z1 Z2 Z3 Z4 Z5.
   Exit: `assert-program-contracts` and the evidence bundle pass on one frozen
   commit, with no source commit after the evidence run.

## Stop points: four gates engineering cannot open

These are authority gates, not engineering estimates, and they must not be
hidden inside one. Work stops at each until a human with standing acts. What
engineering can do is arrive with everything prepared so the decision is about
the decision, not about missing paperwork.

| Gate | Who decides | Blocks | Engineering prepares |
| --- | --- | --- | --- |
| Model provider review and credentials | Project owner plus whoever reviews data processing | N2, and the honest completion of Gate 4 | The provider manifest format, the exact secret variable names, the copy-lifecycle attestation record, and a fixture-backed adapter that proves the port without a live key. |
| School and research ethics authorization | The school and the ethics or research board | Any session with real students | The threat model, data inventory, retention policy record and deletion receipt format for review. It cannot self-issue the approval. |
| Non-student teacher shadow | A teacher, conducted as a controlled human session | Gate 6 admission | The shadow protocol, evidence templates and the validator that checks a completed record. The rehearsal is synthetic; the shadow itself is not. |
| Student visibility promotion decision | Signed separately from the shadow record | Any student-visible ECHO or TRACE | The promotion record contract, the importer and the targeted revocation path, all default-deny. |

## Claim ceiling

Completing all 49 tasks would prove that the system works: that four students
and a teacher hold a durable, attributable, deletable 45-minute session, that
projections reproduce from replay, and that the privacy and accessibility gates
pass on one frozen commit.

It would not prove learning benefit, production readiness at multi-school
scale, service availability, or any claim about individual students. ECHO-CM
and TRACE-AI remain original engineering syntheses that have not been peer
reviewed. No synthetic rehearsal, and no amount of green test output,
substitutes for the three signed human records that Gate 6 requires.
