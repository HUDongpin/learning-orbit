# Learning Orbit controlled classroom pilot

ECHO-CM and TRACE-AI are original engineering syntheses and research proposals. They are not peer-reviewed SOTA claims, learning-effect evidence, individual assessment instruments, or production SLA proof.

`packages/test-fixtures/prototype/` is synthetic regression evidence only. Production code must never fall back to it when a server, model, media processor, or analytics worker is unavailable.

## Approved plans

- [Controlled-pilot design](docs/plans/learning-orbit-controlled-pilot-design.md)
- [Master implementation plan](docs/plans/learning-orbit-controlled-pilot-implementation-plan.md)
- [Plan 01: Foundation and realtime](docs/plans/learning-orbit-plan-01-foundation-realtime.md)
- [Plan 02: Private media](docs/plans/learning-orbit-plan-02-media.md)
- [Plan 03: Analytics](docs/plans/learning-orbit-plan-03-analytics.md)
- [Plan 04: Agent and multimodal](docs/plans/learning-orbit-plan-04-agent-multimodal.md)
- [Plan 05: Student and teacher UI](docs/plans/learning-orbit-plan-05-student-teacher-ui.md)
- [Plan 06: Reliability and pilot admission](docs/plans/learning-orbit-plan-06-reliability-pilot.md)

## Current local delivery boundary

The canonical high-fidelity browser artifact is
`/Volumes/Starship/Learning Orbit/outputs/learning-orbit-demo.html`; it is a
self-contained synthetic demonstration of chat, multimodal browser controls,
ECHO-CM concept-map updates and TRACE-AI interaction views.  It does not claim
live multiplayer transport, a real LLM, ASR/OCR, or an external storage
provider.

The checked-in worker can deterministically materialize the four analytics
projection keys from PostgreSQL room events and replay an immutable epoch.  A
real PostgreSQL acceptance test covers that path.  Media processing and Agent
execution are registered as explicit fail-closed capability seams: without a
reviewed provider injection they return retryable `*_UNAVAILABLE` outcomes.
The governance layer closes/revokes a room, freezes a deletion surface
manifest, enqueues dependency-ordered lifecycle jobs, and can produce a
content-free receipt for the database-only/no-media fixture.  External
provider-copy and object-store deletion capabilities are intentionally absent
in this checkout: any non-zero media/provider surface remains retryable and no
physical remote deletion is claimed. Lifecycle status is projected from the
worker surface claims (`queued` → `running` → `retryable`/`dead` or
`completed`) and exposes only bounded failure codes; a retryable/dead status
never implies that remote media has been deleted.

ECHO-CM and TRACE-AI are original engineering syntheses backed by the source
and implementation notes in the delivered DOCX reports.  They are not
peer-reviewed SOTA claims, efficacy evidence, or individual assessment
instruments.
