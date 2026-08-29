# Learning Orbit Analytics Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 在已批准的受控课堂试点中，把 hash-pinned ECHO-CM / TRACE-AI Python 参考实现接入真实房间事件流，产出可重放、可纠错、可审计且对学习者安全的概念图与群体互动投影。

**Architecture:** Postgres 的 <code>room_event</code> 是唯一事件事实源，每个已提交事件在同一事务中获得一个按 <code>roomSeq</code> 串行消费的 <code>analytics.consume.v1</code> job；Plan 01 的 <code>outbox_event</code> 继续只分发事实事件，独立的 <code>analysis_projection_outbox</code> 只提交已持久化投影的 realtime pointer，绝不回写 RoomEvent。Python 3.12 worker 可从带直接文本的事件生成 <code>DerivedTextArtifact</code>；带媒体但尚无转写的消息仍以回复／提及／广播 metadata 产生 communication/coordination，生命周期及其他 semantic no-op 事件也推进投影 cursor。固定版本的 deterministic extractor 与 ECHO-CM / TRACE-AI reference 经显式 adapter 变为 versioned snapshot/patch。教师 shadow projection 使用房间内 actor/席位课堂化名而非法定姓名；TRACE 学生 bundle 只含 room+analysisEpoch scoped 的不透明 node ID、Plan 01 分配的“探索者 A–D”标签、安全的 communication/uptake 方向结构和四项群体指标。唯一学生 evidence 例外是教师明确批准的 <code>echo.student_approved</code> edge 可保留同一授权房间内的最小 <code>{eventId,start,end}</code> 引用，以支持回看论据；它不携带身份、媒体、存储地址或跨房间引用。

**Tech Stack:** TypeScript 5、JSON Schema 2020-12、AJV 8、Node.js server、Python 3.12、stdlib unittest、psycopg 3、PostgreSQL 18、Vitest、Fastify inject、WebSocket room/projection frames、<code>learning-orbit/infra/docker-compose.yml</code>。

---

> **Claim ceiling:** ECHO-CM 与 TRACE-AI 是 original engineering synthesis / research proposal。hash-pinned Python 文件是可执行参考，不是经过同行评议的算法、SOTA 证明、学习成效证明、关系测量、能力评估或生产性能证明。每个 UI、API、日志和研究材料都必须保留这一边界。

## Dependency contract from Plan 01

本计划只消费 Plan 01 已冻结的基础设施，不重新建表或改变其语义：

- <code>room_event</code>：以 <code>(room_id, room_seq)</code> 排序，以 <code>(room_id, causation_id)</code> 幂等。
- <code>outbox_event</code>：topic 固定为 <code>learning_orbit.room_event.v1</code>，envelope 为 <code>RoomEventEnvelope</code>，schema id 为 <code>https://learning-orbit.local/schemas/room-event-envelope.v1.json</code>。
- <code>worker_job</code>：状态只能是 <code>queued | running | succeeded | retryable | dead | cancelled</code>；analytics 不会把 cancelled job 重新 claim 或当成成功。
- API/WS 根目录：<code>learning-orbit/apps/server/</code>。
- JSON Schema：<code>learning-orbit/packages/contracts/schemas/</code>；生成的 TS types：<code>learning-orbit/packages/contracts/src/generated/</code>。
- Analytics migration 唯一路径：<code>learning-orbit/infra/postgres/migrations/</code>；本计划只新增 <code>003_analytics.sql</code>。
- Server 聚合 HTTP 入口：<code>learning-orbit/apps/server/src/routes.ts</code>；WS 入口：<code>learning-orbit/apps/server/src/realtime.ts</code>。
- <code>RoomEventEnvelope</code> 是聊天事件唯一 wire contract。Pinned reference 的 Python <code>ChatEvent</code> 只是在 worker 内由已验证 envelope 与 <code>DerivedTextArtifact</code> 构造的 adapter input；它不获得第二套 JSON Schema，不经 HTTP/WS 输出，也不成为前端类型。

## Preconditions

Plan 01 creates <code>learning-orbit/.venv</code> with the bundled Python runtime. Before every Python-oriented task, enter the project root, activate that same environment, and assert Python 3.12:

~~~bash
cd learning-orbit
test -f .venv/bin/activate
source .venv/bin/activate
python -c 'import sys; assert sys.version_info[:2] == (3, 12), sys.version'
~~~

Expected: exit 0 and no output. After activation, the existing <code>python3.12</code> commands resolve inside <code>.venv</code>. Do not create a second environment, assume a system Python alias, or hard-code a machine-specific runtime path.

## File map

- Copy: <code>work/learning_orbit_algorithms.py</code> → <code>learning-orbit/services/worker/src/learning_orbit_worker/reference/learning_orbit_algorithms_v1.py</code>; preserve the source file unchanged.
- Create: <code>learning-orbit/services/worker/src/learning_orbit_worker/reference/manifest.json</code>
- Create: <code>learning-orbit/services/worker/src/learning_orbit_worker/reference/README.md</code>
- Create: <code>learning-orbit/packages/contracts/schemas/derived-text-artifact.v1.json</code>
- Create: <code>learning-orbit/packages/contracts/schemas/derived-text-artifact-page.v1.json</code>
- Create: <code>learning-orbit/packages/contracts/schemas/analysis-projection-envelope.v1.json</code>
- Create: <code>learning-orbit/packages/contracts/schemas/analytics-review-command.v1.json</code>
- Create: <code>learning-orbit/packages/contracts/schemas/analytics-review-room-event-payloads.v1.json</code>
- Create: <code>learning-orbit/packages/contracts/schemas/echo-concept-projection.v1.json</code>
- Create: <code>learning-orbit/packages/contracts/schemas/trace-projection.v1.json</code>
- Modify: <code>learning-orbit/packages/contracts/schemas/realtime-frame.v1.json</code>
- Modify: <code>learning-orbit/packages/contracts/src/routes.ts</code>
- Modify: <code>learning-orbit/packages/contracts/test/routes.test.ts</code>
- Generate: <code>learning-orbit/packages/contracts/src/generated/derived-text-artifact.v1.ts</code>
- Generate: <code>learning-orbit/packages/contracts/src/generated/derived-text-artifact-page.v1.ts</code>
- Generate: <code>learning-orbit/packages/contracts/src/generated/analysis-projection-envelope.v1.ts</code>
- Modify: <code>learning-orbit/packages/contracts/src/generated/manifest.json</code>
- Modify: <code>learning-orbit/services/worker/src/learning_orbit_worker/generated/manifest.json</code>
- Generate: <code>learning-orbit/packages/contracts/src/generated/analytics-review-command.v1.ts</code>
- Generate: <code>learning-orbit/packages/contracts/src/generated/analytics-review-room-event-payloads.v1.ts</code>
- Create: <code>learning-orbit/apps/server/src/modules/analytics/register-analytics-review-event-payloads.ts</code>
- Modify: <code>learning-orbit/apps/server/src/app.ts</code>
- Generate: <code>learning-orbit/packages/contracts/src/generated/echo-concept-projection.v1.ts</code>
- Modify: <code>learning-orbit/packages/contracts/test/analytics-contracts.test.ts</code>
- Modify: <code>learning-orbit/packages/contracts/src/routes.ts</code>
- Generate: <code>learning-orbit/packages/contracts/src/generated/trace-projection.v1.ts</code>
- Create: <code>learning-orbit/infra/postgres/migrations/003_analytics.sql</code>
- Create focused Python modules under <code>learning-orbit/services/worker/src/learning_orbit_worker/</code>: <code>domain.py</code>, <code>derived_text.py</code>, <code>extractors.py</code>, <code>echo_adapter.py</code>, <code>trace_adapter.py</code>, <code>projection_store.py</code>, <code>projector.py</code>, <code>replay.py</code> and <code>analytics_handlers.py</code>; modify but do not replace Plan 01's <code>main.py</code>, and leave its <code>jobs.py</code> as the single runner.
- Create server analytics query code: <code>learning-orbit/apps/server/src/modules/analytics/analytics-repository.ts</code> and <code>analytics-policy.ts</code>
- Modify room and realtime routes only at the explicit integration points named in Tasks 10 and 11.
- Create golden fixtures under <code>learning-orbit/packages/test-fixtures/analytics/</code>.

### Task 1: Pin and copy the reference implementation

**Files:**
- Read and preserve: <code>work/learning_orbit_algorithms.py</code>
- Read and preserve: <code>work/test_learning_orbit_algorithms.py</code>
- Copy to: <code>learning-orbit/services/worker/src/learning_orbit_worker/reference/learning_orbit_algorithms_v1.py</code>
- Create: <code>learning-orbit/services/worker/src/learning_orbit_worker/reference/manifest.json</code>
- Create: <code>learning-orbit/services/worker/src/learning_orbit_worker/reference/README.md</code>
- Create: <code>learning-orbit/services/worker/tests/unit/test_reference_pin.py</code>
- Create or modify: <code>learning-orbit/services/worker/pyproject.toml</code>

- [ ] **Step 1: Write the failing hash and claim-ceiling test**

~~~python
import json
import unittest
from hashlib import sha256
from uuid import UUID, uuid5
from pathlib import Path

REFERENCE = (
    Path(__file__).parents[2]
    / "src"
    / "learning_orbit_worker"
    / "reference"
    / "learning_orbit_algorithms_v1.py"
)
SOURCE = Path(__file__).resolve().parents[5] / "work" / "learning_orbit_algorithms.py"
SOURCE_TEST = Path(__file__).resolve().parents[5] / "work" / "test_learning_orbit_algorithms.py"
EXPECTED_SHA256 = "3a2983b0f99cd016b45fb5fd7ee8e1ac4b93b3eee62f3a189a8e20df8c1cf220"
EXPECTED_TEST_SHA256 = "59ad56baa784fa187b6ea6a7cffcbba6138bfc945e43a2aa38fc6cce78560732"


class ReferencePinTests(unittest.TestCase):
    def test_reference_file_is_hash_pinned(self) -> None:
        self.assertTrue(SOURCE.is_file())
        self.assertTrue(REFERENCE.is_file())
        self.assertEqual(
            sha256(SOURCE.read_bytes()).hexdigest(),
            EXPECTED_SHA256,
        )
        self.assertEqual(
            sha256(REFERENCE.read_bytes()).hexdigest(),
            EXPECTED_SHA256,
        )
        self.assertTrue(SOURCE_TEST.is_file())
        self.assertEqual(
            sha256(SOURCE_TEST.read_bytes()).hexdigest(),
            EXPECTED_TEST_SHA256,
        )

    def test_reference_keeps_fixture_claim_ceiling(self) -> None:
        source = REFERENCE.read_text(encoding="utf-8")
        self.assertIn("not natural-language-processing models", source)
        self.assertIn("make no claim of linguistic coverage", source)
~~~

- [ ] **Step 2: Run the test and verify the pre-copy failure**

Run:

~~~bash
cd learning-orbit/services/worker
python3.12 -m unittest -v tests.unit.test_reference_pin
~~~

Expected: FAIL because <code>learning_orbit_algorithms_v1.py</code> does not exist.

- [ ] **Step 3: Copy the exact file and add immutable provenance metadata**

Run from the workspace directory that contains both <code>work/</code> and <code>learning-orbit/</code>:

~~~bash
mkdir -p learning-orbit/services/worker/src/learning_orbit_worker/reference
cp work/learning_orbit_algorithms.py learning-orbit/services/worker/src/learning_orbit_worker/reference/learning_orbit_algorithms_v1.py
shasum -a 256 learning-orbit/services/worker/src/learning_orbit_worker/reference/learning_orbit_algorithms_v1.py
~~~

Expected hash:

~~~text
3a2983b0f99cd016b45fb5fd7ee8e1ac4b93b3eee62f3a189a8e20df8c1cf220
~~~

Create <code>manifest.json</code> with exactly:

~~~json
{
  "referenceVersion": "1.0",
  "sourcePath": "work/learning_orbit_algorithms.py",
  "sourceTestPath": "work/test_learning_orbit_algorithms.py",
  "destinationPath": "services/worker/src/learning_orbit_worker/reference/learning_orbit_algorithms_v1.py",
  "sha256": "3a2983b0f99cd016b45fb5fd7ee8e1ac4b93b3eee62f3a189a8e20df8c1cf220",
  "sourceTestSha256": "59ad56baa784fa187b6ea6a7cffcbba6138bfc945e43a2aa38fc6cce78560732",
  "claimCeiling": "Original engineering synthesis and executable reference; not peer reviewed, not SOTA, not a learning-outcome or production-performance claim.",
  "mutationPolicy": "Do not edit this file. Add wrappers and adapters outside reference/; a changed hash requires a new reference version and a new analysis epoch."
}
~~~

Create <code>README.md</code> with the same claim ceiling and mutation policy. Configure <code>pyproject.toml</code> for Python 3.12 and <code>psycopg[binary]&gt;=3.2,&lt;4</code>; tests use only stdlib <code>unittest</code>.

- [ ] **Step 4: Run the preserved 73-test reference suite and the copy pin**

Run:

~~~bash
python3.12 -m unittest -v work.test_learning_orbit_algorithms
cd learning-orbit/services/worker
python3.12 -m unittest -v tests.unit.test_reference_pin
~~~

Expected: the preserved reference suite reports 73 passing tests; the worker pin test passes; both source hashes remain unchanged.

- [ ] **Step 5: Commit the pinned reference**

~~~bash
git add services/worker/pyproject.toml services/worker/src/learning_orbit_worker/reference services/worker/tests/unit/test_reference_pin.py
git commit -m "chore(analytics): pin ECHO TRACE reference v1"
~~~

### Task 2: Freeze DerivedTextArtifact and projection metadata contracts

**Files:**
- Create: <code>learning-orbit/packages/contracts/schemas/derived-text-artifact.v1.json</code>
- Create: <code>learning-orbit/packages/contracts/schemas/analysis-projection-envelope.v1.json</code>
- Generate: <code>learning-orbit/packages/contracts/src/generated/derived-text-artifact.v1.ts</code>
- Generate: <code>learning-orbit/packages/contracts/src/generated/analysis-projection-envelope.v1.ts</code>
- Modify: <code>learning-orbit/packages/contracts/src/index.ts</code>
- Create: <code>learning-orbit/packages/contracts/test/analytics-contracts.test.ts</code>

- [ ] **Step 1: Write failing schema tests for separated confidence and status**

~~~typescript
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import derivedSchema from "../schemas/derived-text-artifact.v1.json";
import projectionSchema from "../schemas/analysis-projection-envelope.v1.json";

const ajv = new Ajv2020({ allErrors: true, strict: true, strictNumbers: true });
addFormats(ajv);

test("DerivedTextArtifact keeps source fidelity separate", () => {
  const valid = ajv.compile(derivedSchema);
  expect(valid({
    schemaVersion: 1,
    artifactId: "00000000-0000-4000-8000-000000000301",
    lineageId: "00000000-0000-4000-8000-000000000351",
    roomId: "00000000-0000-4000-8000-000000000010",
    eventId: "00000000-0000-4000-8000-000000000101",
    roomSeq: 1,
    sourceMediaId: null,
    sourceModality: "text",
    derivation: "direct",
    text: "太陽提供能量給生產者。",
    normalizedTextSha256: "a".repeat(64),
    sourceConfidenceRaw: 1,
    sourceConfidenceCalibrated: null,
    provider: "learner-authored",
    modelVersion: "direct-text-v1",
    languageTag: "zh-Hant",
    spans: [],
    reviewStatus: "unreviewed",
    displayStatus: "hidden",
    warnings: [],
    supersedesArtifactId: null,
    active: true,
    createdAt: "2026-08-28T09:02:00+08:00"
  })).toBe(true);
});

test("projection requires evidence review and display states", () => {
  const valid = ajv.compile(projectionSchema);
  expect(valid({
    schemaVersion: 1,
    projectionKey: "echo.teacher_shadow",
    roomId: "00000000-0000-4000-8000-000000000010",
    analysisEpoch: "00000000-0000-4000-8000-000000000901",
    algorithmVersion: "echo-cm-reference-v1+adapter-v1",
    parameterHash: "b".repeat(64),
    projectionVersion: 1,
    baseVersion: 0,
    completeThroughRoomSeq: 1,
    watermarkEventTime: "2026-08-28T09:01:55+08:00",
    requiresReplay: false,
    evidenceStatus: "active",
    reviewStatus: "unreviewed",
    displayStatus: "teacher_shadow",
    warnings: [],
    payload: {}
  })).toBe(true);
});

test("generator writes schema-basename modules", () => {
  for (const moduleName of [
    "derived-text-artifact.v1.ts",
    "analysis-projection-envelope.v1.ts"
  ]) {
    expect(existsSync(resolve(process.cwd(), "src/generated", moduleName))).toBe(true);
  }
});

import type {
  DerivedTextArtifact
} from "../src/generated/derived-text-artifact.v1";
import type {
  AnalysisProjectionEnvelope
} from "../src/generated/analysis-projection-envelope.v1";

test("generated modules preserve schema ownership", () => {
  expectTypeOf<DerivedTextArtifact>().toHaveProperty("supersedesArtifactId");
  expectTypeOf<DerivedTextArtifact>().toHaveProperty("lineageId");
  expectTypeOf<DerivedTextArtifact>().toHaveProperty("active");
  expectTypeOf<AnalysisProjectionEnvelope>()
    .toHaveProperty("algorithmVersion");
  expectTypeOf<AnalysisProjectionEnvelope>()
    .toHaveProperty("parameterHash");
});
~~~

- [ ] **Step 2: Run contract tests and verify missing-schema failure**

Run:

~~~bash
cd learning-orbit
pnpm --filter @learning-orbit/contracts test -- analytics-contracts
~~~

Expected: FAIL because both analytics schema files are missing.

- [ ] **Step 3: Create authoritative schemas and generated types**

Create <code>derived-text-artifact.v1.json</code>:

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://learning-orbit.local/schemas/derived-text-artifact.v1.json",
  "title": "DerivedTextArtifact",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion", "artifactId", "lineageId", "roomId", "eventId", "roomSeq", "sourceMediaId",
    "sourceModality", "derivation", "text", "normalizedTextSha256",
    "sourceConfidenceRaw", "sourceConfidenceCalibrated", "provider",
    "modelVersion", "languageTag", "spans", "reviewStatus",
    "displayStatus", "warnings", "supersedesArtifactId", "active", "createdAt"
  ],
  "properties": {
    "schemaVersion": { "const": 1 },
    "artifactId": { "type": "string", "format": "uuid" },
    "lineageId": { "type": "string", "format": "uuid" },
    "roomId": { "type": "string", "format": "uuid" },
    "eventId": { "type": "string", "format": "uuid" },
    "roomSeq": { "type": "integer", "minimum": 1 },
    "sourceMediaId": {
      "oneOf": [
        { "type": "string", "format": "uuid" },
        { "type": "null" }
      ]
    },
    "sourceModality": { "enum": ["text", "audio", "image"] },
    "derivation": {
      "enum": ["direct", "asr", "ocr", "image_description", "human_correction"]
    },
    "text": { "type": "string", "minLength": 1, "maxLength": 20000 },
    "normalizedTextSha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
    "sourceConfidenceRaw": { "type": "number", "minimum": 0, "maximum": 1 },
    "sourceConfidenceCalibrated": {
      "oneOf": [
        { "type": "number", "minimum": 0, "maximum": 1 },
        { "type": "null" }
      ]
    },
    "provider": { "type": "string", "minLength": 1, "maxLength": 100 },
    "modelVersion": { "type": "string", "minLength": 1, "maxLength": 160 },
    "languageTag": { "type": "string", "minLength": 2, "maxLength": 35 },
    "spans": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["start", "end", "confidence"],
        "properties": {
          "start": { "type": "integer", "minimum": 0 },
          "end": { "type": "integer", "minimum": 1 },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
          "startMs": { "type": "integer", "minimum": 0 },
          "endMs": { "type": "integer", "minimum": 0 },
          "boundingBox": {
            "type": "array",
            "items": { "type": "number" },
            "minItems": 4,
            "maxItems": 4
          }
        }
      }
    },
    "reviewStatus": {
      "enum": ["unreviewed", "approved", "rejected", "corrected"]
    },
    "displayStatus": {
      "enum": ["hidden", "teacher_shadow", "student_approved"]
    },
    "warnings": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 }
    },
    "supersedesArtifactId": {
      "oneOf": [
        { "type": "string", "format": "uuid" },
        { "type": "null" }
      ]
    },
    "active": { "type": "boolean" },
    "createdAt": { "type": "string", "format": "date-time" }
  }
}
~~~

Create <code>analysis-projection-envelope.v1.json</code>:

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://learning-orbit.local/schemas/analysis-projection-envelope.v1.json",
  "title": "AnalysisProjectionEnvelope",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion", "projectionKey", "roomId", "analysisEpoch",
    "algorithmVersion", "parameterHash",
    "projectionVersion", "baseVersion", "completeThroughRoomSeq", "watermarkEventTime",
    "requiresReplay", "evidenceStatus", "reviewStatus", "displayStatus",
    "warnings", "payload"
  ],
  "properties": {
    "schemaVersion": { "const": 1 },
    "projectionKey": {
      "enum": [
        "echo.teacher_shadow", "echo.student_approved",
        "trace.teacher_bundle", "trace.student_bundle"
      ]
    },
    "roomId": { "type": "string", "format": "uuid" },
    "analysisEpoch": { "type": "string", "format": "uuid" },
    "algorithmVersion": { "type": "string", "minLength": 1, "maxLength": 160 },
    "parameterHash": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
    "projectionVersion": { "type": "integer", "minimum": 1 },
    "baseVersion": { "type": "integer", "minimum": 0 },
    "completeThroughRoomSeq": { "type": "integer", "minimum": 0 },
    "watermarkEventTime": { "type": "string", "format": "date-time" },
    "requiresReplay": { "type": "boolean" },
    "evidenceStatus": { "enum": ["active", "retracted", "superseded", "requires_replay"] },
    "reviewStatus": {
      "enum": ["unreviewed", "approved", "rejected", "corrected"]
    },
    "displayStatus": {
      "enum": ["hidden", "teacher_shadow", "student_approved", "student_aggregate"]
    },
    "warnings": { "type": "array", "items": { "type": "string", "minLength": 1 } },
    "payload": { "type": "object" }
  }
}
~~~

Generate <code>src/generated/derived-text-artifact.v1.ts</code> and <code>src/generated/analysis-projection-envelope.v1.ts</code> from the matching schema basenames. <code>src/index.ts</code> re-exports both modules. Generated modules are not hand-edited or merged.

- [ ] **Step 4: Generate types and rerun contract tests**

Run:

~~~bash
cd learning-orbit
pnpm --filter @learning-orbit/contracts generate
pnpm --filter @learning-orbit/contracts test -- analytics-contracts
~~~

Expected: PASS; a single collapsed confidence/status field is rejected.

- [ ] **Step 5: Commit the contract spine**

~~~bash
git add packages/contracts services/worker/src/learning_orbit_worker/generated/manifest.json
git commit -m "feat(contracts): freeze analytics artifact and projection metadata"
~~~

### Task 3: Add analytics persistence without duplicating Plan 01

**Files:**
- Create: <code>learning-orbit/infra/postgres/migrations/003_analytics.sql</code>
- Create: <code>learning-orbit/apps/server/test/db/analytics-migration.test.ts</code>

- [ ] **Step 1: Write the failing migration test**

~~~typescript
test("analytics migration creates read models and projection outbox", async () => {
  const rows = await db.any<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema='public'"
  );
  const names = new Set(rows.map((row) => row.table_name));
  for (const name of [
    "derived_text_artifact", "extraction_artifacts",
    "analysis_projection_snapshots", "analysis_projection_patches",
    "analysis_projection_outbox",
    "analysis_room_heads", "analysis_consumer_checkpoints", "analytics_review_detail",
    "analytics_replay_request"
  ]) expect(names.has(name)).toBe(true);

  const artifactColumns = new Set((await db.any<{ column_name: string }>(
    "select column_name from information_schema.columns " +
    "where table_schema='public' and table_name='derived_text_artifact'"
  )).map((row) => row.column_name));
  for (const name of [
    "spans", "created_at", "active", "supersedes_artifact_id"
  ]) expect(artifactColumns.has(name)).toBe(true);

  const patchColumns = new Set((await db.any<{ column_name: string }>(
    "select column_name from information_schema.columns " +
    "where table_schema='public' and table_name='analysis_projection_patches'"
  )).map((row) => row.column_name));
  for (const name of ["algorithm_version", "parameter_hash"]) {
    expect(patchColumns.has(name)).toBe(true);
  }

  await expect(insertWorkerJob({ jobType: "analytics.consume.v1", analyticsOrderSeq: null, analyticsOrderKind: null }))
    .rejects.toThrow(/worker_job_analytics_order_ck/);
  await expect(insertWorkerJob({ jobType: "analytics.replay-room.v1", analyticsOrderSeq: null, analyticsOrderKind: 1 }))
    .rejects.toThrow(/worker_job_analytics_order_ck/);
  await expect(insertWorkerJob({ jobType: "media.process.v1", analyticsOrderSeq: 1, analyticsOrderKind: 0 }))
    .rejects.toThrow(/worker_job_analytics_order_ck/);
  const reconcile = await insertWorkerJob({
    jobType: "media.reconcile-upload.v1", roomId: fixtureRoomId,
    sourceEventId: null, correlationId: fixturePromotionCorrelationId,
    payload: { mediaId: fixtureMediaId },
    analyticsOrderSeq: null, analyticsOrderKind: null
  });
  expect(await rawWorkerJob(reconcile.jobId)).toMatchObject({
    roomId: fixtureRoomId, sourceEventId: null,
    correlationId: fixturePromotionCorrelationId,
    analyticsOrderSeq: null, analyticsOrderKind: null
  });
});
~~~

The same migration test seeds one linked row in every analytics table, deletes the owning <code>classroom_room</code>, and requires zero remaining analytics rows. Every room/event foreign key therefore uses the explicit cascade or set-null action shown below; a restrictive default that blocks the Plan 06 deletion workflow fails Gate 3.

- [ ] **Step 2: Run it and verify the red state**

Run: <code>cd learning-orbit &amp;&amp; pnpm db:migrate:test &amp;&amp; pnpm vitest run apps/server/test/db/analytics-migration.test.ts</code>

Expected: FAIL because <code>derived_text_artifact</code> does not exist.

- [ ] **Step 3: Create migration 003**

~~~sql
alter table worker_job
  add column analytics_order_seq bigint,
  add column analytics_order_kind smallint,
  add constraint worker_job_analytics_order_ck check (
    (job_type='analytics.consume.v1' and analytics_order_seq is not null and analytics_order_kind is not null and analytics_order_seq > 0 and analytics_order_kind=0)
    or (job_type='analytics.replay-room.v1' and analytics_order_seq is not null and analytics_order_kind is not null and analytics_order_seq >= 0 and analytics_order_kind=1)
    or (job_type not in ('analytics.consume.v1','analytics.replay-room.v1') and analytics_order_seq is null and analytics_order_kind is null)
  );

create table analytics_replay_request (
  job_id uuid primary key references worker_job(job_id) on delete cascade,
  room_id uuid not null references classroom_room(room_id) on delete cascade,
  source_event_id uuid references room_event(event_id) on delete cascade,
  reason text not null check (reason in ('late_event','artifact_available','analytics_review','operator_rebuild')),
  requested_through_room_seq bigint not null check (requested_through_room_seq >= 0),
  dedupe_key text not null unique,
  correlation_id uuid not null,
  created_at timestamptz not null default now()
);

create table derived_text_artifact (
  artifact_id uuid primary key,
  lineage_id uuid not null,
  event_id uuid not null references room_event(event_id) on delete cascade,
  room_id uuid not null references classroom_room(room_id) on delete cascade,
  room_seq bigint not null check (room_seq > 0),
  source_media_id uuid null references media_asset(media_id) on delete cascade,
  source_modality text not null check (source_modality in ('text','audio','image')),
  derivation text not null check (
    derivation in ('direct','asr','ocr','image_description','human_correction')
  ),
  text_content text not null check (length(text_content) between 1 and 20000),
  normalized_text_sha256 char(64) not null check (normalized_text_sha256 ~ '^[a-f0-9]{64}$'),
  source_confidence_raw double precision not null check (source_confidence_raw between 0 and 1),
  source_confidence_calibrated double precision null check (
    source_confidence_calibrated is null or source_confidence_calibrated between 0 and 1
  ),
  provider text not null,
  model_version text not null,
  language_tag text not null,
  spans jsonb not null default '[]'::jsonb check (jsonb_typeof(spans)='array'),
  review_status text not null check (
    review_status in ('unreviewed','approved','rejected','corrected')
  ),
  display_status text not null check (
    display_status in ('hidden','teacher_shadow','student_approved')
  ),
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings)='array'),
  supersedes_artifact_id uuid null references derived_text_artifact(artifact_id) on delete set null,
  active boolean not null default true,
  check (derivation <> 'human_correction' or supersedes_artifact_id is not null),
  check (supersedes_artifact_id is null or supersedes_artifact_id <> artifact_id),
  created_at timestamptz not null default now(),
  unique (lineage_id, event_id, derivation, model_version, normalized_text_sha256)
);

create table extraction_artifacts (
  extraction_id uuid primary key,
  artifact_id uuid not null references derived_text_artifact(artifact_id) on delete cascade,
  room_id uuid not null references classroom_room(room_id) on delete cascade,
  room_seq bigint not null check (room_seq > 0),
  algorithm text not null check (algorithm in ('ECHO-CM','TRACE-AI')),
  extractor_version text not null,
  output jsonb not null,
  output_sha256 char(64) not null check (output_sha256 ~ '^[a-f0-9]{64}$'),
  extraction_confidence_raw double precision null check (
    extraction_confidence_raw is null or extraction_confidence_raw between 0 and 1
  ),
  extraction_confidence_calibrated double precision null check (
    extraction_confidence_calibrated is null or extraction_confidence_calibrated between 0 and 1
  ),
  created_at timestamptz not null default now(),
  unique (artifact_id, algorithm, extractor_version, output_sha256)
);

create table analysis_projection_snapshots (
  snapshot_id uuid primary key,
  room_id uuid not null references classroom_room(room_id) on delete cascade,
  algorithm text not null check (algorithm in ('ECHO-CM','TRACE-AI')),
  projection_key text not null,
  analysis_epoch uuid not null,
  version bigint not null check (version >= 1),
  complete_through_seq bigint not null check (complete_through_seq >= 0),
  watermark_event_time timestamptz not null,
  requires_replay boolean not null default false,
  schema_version integer not null check (schema_version = 1),
  algorithm_version text not null,
  parameter_hash char(64) not null check (parameter_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  content_sha256 char(64) not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique (room_id, projection_key, analysis_epoch, version)
);

create table analysis_projection_patches (
  patch_id uuid primary key,
  room_id uuid not null references classroom_room(room_id) on delete cascade,
  projection_key text not null,
  analysis_epoch uuid not null,
  base_version bigint not null check (base_version >= 0),
  version bigint not null check (version = base_version + 1),
  complete_through_seq bigint not null check (complete_through_seq >= 0),
  algorithm_version text not null,
  parameter_hash char(64) not null check (parameter_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  content_sha256 char(64) not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique (room_id, projection_key, analysis_epoch, version)
);

create table analysis_projection_outbox (
  projection_outbox_id bigint generated always as identity primary key,
  room_id uuid not null references classroom_room(room_id) on delete cascade,
  projection_key text not null,
  analysis_epoch uuid not null,
  projection_version bigint not null check (projection_version >= 1),
  complete_through_room_seq bigint not null check (complete_through_room_seq >= 0),
  snapshot_url text not null,
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  publish_attempts integer not null default 0,
  published_at timestamptz,
  last_error text,
  unique (room_id, projection_key, analysis_epoch, projection_version)
);

create table analysis_room_heads (
  room_id uuid not null references classroom_room(room_id) on delete cascade,
  projection_key text not null,
  analysis_epoch uuid not null,
  version bigint not null check (version >= 0),
  complete_through_seq bigint not null check (complete_through_seq >= 0),
  algorithm_version text not null,
  parameter_hash char(64) not null check (parameter_hash ~ '^[a-f0-9]{64}$'),
  max_seen_event_time timestamptz not null,
  watermark_event_time timestamptz not null,
  requires_replay boolean not null default false,
  snapshot_id uuid null references analysis_projection_snapshots(snapshot_id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (room_id, projection_key)
);

create table analysis_consumer_checkpoints (
  consumer_name text not null,
  room_id uuid not null references classroom_room(room_id) on delete cascade,
  last_room_seq bigint not null check (last_room_seq >= 0),
  updated_at timestamptz not null default now(),
  primary key (consumer_name, room_id)
);

create table analytics_review_detail (
  review_detail_id uuid primary key,
  review_event_id uuid not null unique references room_event(event_id) on delete cascade,
  room_id uuid not null references classroom_room(room_id) on delete cascade,
  change_kind text not null check (change_kind in ('review','correction')),
  validated_payload jsonb not null check (jsonb_typeof(validated_payload)='object'),
  reviewer_teacher_id uuid not null references teacher_account(teacher_id),
  created_at timestamptz not null default now()
);

create index derived_text_room_seq_idx on derived_text_artifact(room_id, room_seq);
create unique index derived_text_one_active_lineage_idx
  on derived_text_artifact(lineage_id) where active;
create index derived_text_review_queue_idx
  on derived_text_artifact(room_id, review_status, active, created_at, artifact_id);
create index extraction_room_seq_idx on extraction_artifacts(room_id, room_seq, algorithm);
create index analytics_snapshot_latest_idx
  on analysis_projection_snapshots(room_id, projection_key, analysis_epoch, version desc);
create index analytics_patch_resume_idx
  on analysis_projection_patches(room_id, projection_key, analysis_epoch, version);
create index analytics_projection_outbox_claim_idx
  on analysis_projection_outbox(projection_outbox_id)
  where published_at is null;
~~~

- [ ] **Step 4: Apply migrations twice and rerun the test**

Run:

~~~bash
cd learning-orbit
pnpm --filter @learning-orbit/server db:migrate
pnpm --filter @learning-orbit/server db:migrate
pnpm db:migrate:test
pnpm vitest run apps/server/test/db/analytics-migration.test.ts
~~~

Expected: both migrations exit 0, the second reports no pending migration, and the test passes.

- [ ] **Step 5: Commit**

~~~bash
git add infra/postgres/migrations/003_analytics.sql apps/server/test/db/analytics-migration.test.ts
git commit -m "feat(analytics): add immutable analytics read models"
~~~

### Task 4: Claim Plan 01 jobs with SKIP LOCKED

**Files:**
- Modify: <code>learning-orbit/apps/server/src/db/sql/claim_worker_job.sql</code>
- Verify unchanged: <code>learning-orbit/apps/server/src/db/sql/settle_worker_job_claims.sql</code>
- Modify: <code>learning-orbit/services/worker/src/learning_orbit_worker/jobs.py</code>
- Create: <code>learning-orbit/services/worker/tests/unit/test_analytics_claim_contract.py</code>
- Create: <code>learning-orbit/services/worker/tests/integration/test_job_claim.py</code>

- [ ] **Step 1: Write failing claim and retry tests**

~~~python
import unittest
from pathlib import Path


class WorkerJobTests(unittest.TestCase):
    def test_claim_sql_matches_plan_01(self) -> None:
        sql = Path("../../apps/server/src/db/sql/claim_worker_job.sql").read_text()
        settle = Path("../../apps/server/src/db/sql/settle_worker_job_claims.sql").read_text()
        self.assertIn("FOR UPDATE SKIP LOCKED", sql)
        self.assertIn("status IN('queued','retryable')", sql)
        self.assertIn("status='running'", sql)
        self.assertIn("analytics.replay-room.v1", sql)
        self.assertIn("JOB_LEASE_EXPIRED_MAX_ATTEMPTS", settle)
        self.assertIn("worker_job_completion", settle)
        self.assertIn("c.claim_generation=j.claim_generation", settle)
        self.assertIn("c.claim_token_hash=encode(digest", settle)
        self.assertIn("claim_token=gen_random_uuid()", settle)
        self.assertIn("claim_generation=j.claim_generation+1", settle)
        self.assertIn("attempts=j.attempts+1", settle)
        self.assertIn("analytics_order_seq", sql)
        self.assertIn("earlier.status<>'succeeded'", sql)
~~~

Migration 003 adds nullable `analytics_order_seq bigint` and `analytics_order_kind smallint` to `worker_job` plus a closed check: consume jobs require both non-null and `(roomSeq,0)`, replay jobs require both non-null and `(requestedThroughRoomSeq,1)`, and non-analytics jobs require both null. The explicit `IS NOT NULL` terms are mandatory because PostgreSQL accepts a `CHECK` expression that evaluates to unknown; tests insert each partial/null analytics combination and require rejection. The same test inspects Plan 02's room-scoped `media.reconcile-upload.v1` raw row and requires both order fields NULL, preserving its room/correlation/source contract. Server insertion derives analytics columns from its validated payload; clients cannot supply them. Task 4 extends the claimed `WorkerJob` record with nullable `analytics_order_seq` and `analytics_order_kind`; Plan 02's handlers already default missing pre-Gate-3 fields to NULL, but after this migration `JobStore` must expose the two returned columns and every non-analytics adapter rejects non-NULL values. The callable ABI remains exactly `(WorkerJob, WorkerDeps)`. The integration test inserts <code>roomSeq=1..5</code> consume jobs for each of two rooms in reverse insertion order plus a replay barrier at sequence 3. Two DB connections claim concurrently. A claim may return at most the lowest unfinished analytics order tuple per room; consume 3 precedes replay 3, which precedes consume 4. After each claimed job is marked succeeded, the next round returns the next tuple. Claimed job-id sets must be disjoint, and a deliberately failed/dead barrier keeps every later same-room analytics mutation ineligible while the other room continues.

- [ ] **Step 2: Run and verify the missing ordering rule**

Run: <code>cd learning-orbit/services/worker &amp;&amp; python3.12 -m unittest -v tests.unit.test_analytics_claim_contract tests.integration.test_job_claim</code>

Expected: FAIL because Plan 01's canonical claim SQL does not yet serialize <code>analytics.consume.v1</code> within each room.

- [ ] **Step 3: Implement the exact state machine**

~~~sql
SELECT j.job_id FROM worker_job j
WHERE j.run_after<=now()
  AND (
    (j.status IN('queued','retryable') AND j.claim_token IS NULL
      AND j.locked_at IS NULL AND j.locked_by IS NULL)
    OR (j.status='running' AND j.locked_at<now()-interval '2 minutes')
  )
  AND (
    j.job_type NOT IN ('analytics.consume.v1','analytics.replay-room.v1')
    OR NOT EXISTS (
      SELECT 1 FROM worker_job earlier
      WHERE earlier.room_id=j.room_id
        AND earlier.job_type IN ('analytics.consume.v1','analytics.replay-room.v1')
        AND (earlier.analytics_order_seq,earlier.analytics_order_kind,earlier.job_id)
            < (j.analytics_order_seq,j.analytics_order_kind,j.job_id)
        AND earlier.status<>'succeeded'
    )
  )
ORDER BY j.run_after,j.created_at
FOR UPDATE SKIP LOCKED
LIMIT %s;
~~~

Plan 03 changes only the candidate-lock query by adding the analytics room-order predicate. Plan 01's `settle_worker_job_claims.sql` remains byte-for-byte unchanged and is still the second READ COMMITTED command in the same JobStore transaction. The integration test deliberately begins candidate selection before a final analytics marker commits while its job row is locked: `SKIP LOCKED` omits it, the next claim sees the marker with a fresh snapshot and recovers succeeded, then the room barrier advances. It also combines stale reclaim/old-token fencing in room A with independent progress in room B. A copied one-statement claimant or modified settle checksum fails the test.

- [ ] **Step 4: Run unit and concurrent DB tests**

Run: <code>cd learning-orbit/services/worker &amp;&amp; python3.12 -m unittest -v tests.test_jobs tests.unit.test_analytics_claim_contract tests.integration.test_job_claim</code>

Expected: PASS; the claimed `WorkerJob` exposes nullable analytics-order fields, non-analytics jobs retain NULL, fresh running leases are not stolen, stale running leases receive a new token/generation, old-token transitions and analytics commits fail, exhausted stale work becomes dead, no consume/replay mutation overtakes an earlier same-room tuple, and other rooms continue independently.

- [ ] **Step 5: Commit**

~~~bash
git add apps/server/src/db/sql/claim_worker_job.sql services/worker/src/learning_orbit_worker/jobs.py services/worker/tests/unit/test_analytics_claim_contract.py services/worker/tests/integration/test_job_claim.py
git commit -m "feat(worker): claim analytics jobs with skip locked"
~~~

### Task 5: Fan out every RoomEvent and materialize optional DerivedTextArtifact

**Files:**
- Create: <code>learning-orbit/services/worker/src/learning_orbit_worker/domain.py</code>
- Create: <code>learning-orbit/services/worker/src/learning_orbit_worker/derived_text.py</code>
- Create: <code>learning-orbit/services/worker/tests/unit/test_derived_text.py</code>
- Modify: <code>learning-orbit/apps/server/src/modules/rooms/room-event-repository.ts</code>
- Create: <code>learning-orbit/apps/server/test/rooms/analytics-job-fanout.test.ts</code>

- [ ] **Step 1: Write failing modality-boundary tests**

~~~python
import unittest


def make_room_event(
    text: str = "太陽提供能量給生產者。",
    media_ids: tuple[str, ...] = (),
) -> dict:
    return {
        "eventId": "00000000-0000-4000-8000-000000000101",
        "schemaVersion": 1,
        "roomId": "00000000-0000-4000-8000-000000000010",
        "roomSeq": 1,
        "type": "message.added",
        "actorId": "00000000-0000-4000-8000-000000000301",
        "actorKind": "human",
        "actorRole": "student",
        "revision": 1,
        "operation": "add",
        "eventTime": "2026-08-28T09:00:00Z",
        "ingestTime": "2026-08-28T09:00:01Z",
        "causationId": "00000000-0000-4000-8000-000000000401",
        "correlationId": "00000000-0000-4000-8000-000000000402",
        "payload": {
            "messageId": "00000000-0000-4000-8000-000000000201",
            "text": text,
            "replyTo": None,
            "mentions": [],
            "mediaIds": list(media_ids),
        },
    }


class DerivedTextTests(unittest.TestCase):
    def test_typed_message_becomes_direct_artifact(self) -> None:
        artifact = derive_direct_text(make_room_event())
        self.assertEqual(artifact.derivation, "direct")
        self.assertEqual(artifact.source_confidence_raw, 1.0)
        self.assertIsNone(artifact.source_confidence_calibrated)
        self.assertEqual(artifact.review_status, "unreviewed")
        self.assertEqual(artifact.display_status, "hidden")
        self.assertIsNone(artifact.source_media_id)
        self.assertEqual(artifact.spans, ())
        self.assertEqual(artifact.warnings, ())
        self.assertIsNone(artifact.supersedes_artifact_id)
        self.assertTrue(artifact.active)
        self.assertEqual(artifact.created_at, "2026-08-28T09:00:01Z")

    def test_media_only_event_never_pretends_to_have_asr(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            "direct text requires learner-authored text",
        ):
            derive_direct_text(make_room_event(
                text="",
                media_ids=("00000000-0000-4000-8000-000000000501",),
            ))

    def test_non_text_consume_event_has_no_artifact(self) -> None:
        self.assertIsNone(maybe_derive_direct_text(
            make_room_event(
                text="",
                media_ids=("00000000-0000-4000-8000-000000000501",),
            )
        ))

    def test_nova_text_is_not_marked_learner_authored(self) -> None:
        event = make_room_event(text="Nova 的整理")
        event.update(actorKind="agent", actorRole="socratic_facilitator")
        self.assertIsNone(maybe_derive_direct_text(event))
~~~

The server test appends, in deliberately mixed semantic categories, one direct-text message, one media-only message, <code>room.opened</code>, <code>room.paused</code>, <code>message.retracted</code>, <code>analytics.review.recorded.v1</code> and <code>analytics.correction.recorded.v1</code>. It then asserts:

~~~typescript
const events = await appendCanonicalEventsInOneRoom();
const jobs = await db.any(
  "select job_type,source_event_id,dedupe_key,correlation_id,payload " +
  "from worker_job where room_id=$1 order by (payload->>'roomSeq')::bigint",
  [ROOM_A]
);
expect(jobs).toHaveLength(events.length);
expect(jobs.map((job) => job.source_event_id))
  .toEqual(events.map((event) => event.eventId));
for (const [index, job] of jobs.entries()) {
  const event = events[index];
  expect(job.job_type).toBe("analytics.consume.v1");
  expect(job.dedupe_key).toBe(
    `analytics.consume.v1:${event.roomId}:${event.roomSeq}`
  );
  expect(job.correlation_id).toBe(event.correlationId);
  expect(job.payload).toEqual({
    eventId: event.eventId,
    roomSeq: event.roomSeq,
    eventType: event.type
  });
}
~~~

The same test retries every append by <code>causationId</code> and proves the existing event and consume job are returned without a duplicate. The dedicated projection pointer table is not a RoomEvent source and therefore never enters this fanout.

- [ ] **Step 2: Run and verify both red states**

Run:

~~~bash
cd learning-orbit/services/worker
python3.12 -m unittest -v tests.unit.test_derived_text
cd ../../
pnpm --filter @learning-orbit/server test -- analytics-job-fanout
~~~

Expected: FAIL because artifact and fanout implementations are absent.

- [ ] **Step 3: Implement immutable direct text and idempotent fanout**

~~~python
from dataclasses import dataclass
from hashlib import sha256
from unicodedata import normalize
from uuid import UUID, uuid5

ARTIFACT_NAMESPACE = UUID("2af27c6d-61c8-4a40-997d-80c7d696f871")
LINEAGE_NAMESPACE = UUID("b72003a9-c4aa-5d22-91df-9a4bb77d61ac")


@dataclass(frozen=True)
class DerivedTextArtifact:
    schema_version: int
    artifact_id: str
    lineage_id: str
    room_id: str
    event_id: str
    room_seq: int
    source_media_id: str | None
    source_modality: str
    derivation: str
    text: str
    normalized_text_sha256: str
    source_confidence_raw: float
    source_confidence_calibrated: float | None
    provider: str
    model_version: str
    language_tag: str
    spans: tuple[dict, ...]
    review_status: str
    display_status: str
    warnings: tuple[str, ...]
    supersedes_artifact_id: str | None
    active: bool
    created_at: str


def derive_direct_text(event: dict) -> DerivedTextArtifact:
    payload = event["payload"]
    text = normalize("NFC", str(payload.get("text", ""))).strip()
    if not text:
        raise ValueError("direct text requires learner-authored text")
    digest = sha256(text.encode("utf-8")).hexdigest()
    artifact_id = uuid5(
        ARTIFACT_NAMESPACE,
        event["eventId"] + ":direct:direct-text-v1:" + digest,
    )
    lineage_id = uuid5(LINEAGE_NAMESPACE, payload["messageId"] + ":direct")
    return DerivedTextArtifact(
        schema_version=1,
        artifact_id=str(artifact_id),
        lineage_id=str(lineage_id),
        room_id=event["roomId"],
        event_id=event["eventId"],
        room_seq=int(event["roomSeq"]),
        source_media_id=None,
        source_modality="text",
        derivation="direct",
        text=text,
        normalized_text_sha256=digest,
        source_confidence_raw=1.0,
        source_confidence_calibrated=None,
        provider="learner-authored",
        model_version="direct-text-v1",
        # Plan 01's closed message payload has no languageTag field. Direct
        # learner text remains "und" until a separately versioned detector or
        # reviewed artifact supplies language metadata outside RoomEvent.
        language_tag="und",
        spans=(),
        review_status="unreviewed",
        display_status="hidden",
        warnings=(),
        supersedes_artifact_id=None,
        active=True,
        created_at=event["ingestTime"],
    )


def maybe_derive_direct_text(event: dict) -> DerivedTextArtifact | None:
    payload = event.get("payload", {})
    if (
        event.get("type") not in {"message.added", "message.revised"}
        or event.get("actorKind") != "human"
        or event.get("actorRole") != "student"
        or not str(payload.get("text", "")).strip()
    ):
        return None
    return derive_direct_text(event)
~~~

Persist a non-null artifact with an explicit mapping for every contract field, including <code>lineage_id</code>, <code>spans</code>, <code>created_at</code>, <code>supersedes_artifact_id</code> and <code>active</code>. Direct-text lineage is UUIDv5 of the stable message root plus `direct`; each media derivation lineage is UUIDv5 of message root + media UUID + modality derivation; a human correction inherits the exact prior lineage ID. In one transaction, lock the current active lineage, make a newer message revision, media reprocess or human correction point to and deactivate it, then insert the new active row; only `human_correction` requires a predecessor, while non-correction derivations may have one when they replace an active same-lineage artifact. An identical event retry returns the existing deterministic artifact row. The active partial unique index is on `lineage_id`, and the replay identity unique key includes both `lineage_id` and `event_id`; therefore one message can own up to four media lineages even when two files produce identical normalized text, while a later event/reprocess remains auditable. Tests cover direct revision, ASR/OCR reprocess, four media with identical text/model output, a required correction predecessor, cycle/self-supersession rejection and one-active-row enforcement. In the same Plan 01 append transaction, enqueue every successfully inserted <code>room_event</code> without filtering on type, actor, role, text or media:

~~~typescript
await tx.query(
  "insert into worker_job " +
  "(job_id,job_type,room_id,source_event_id,dedupe_key,correlation_id,payload," +
  "analytics_order_seq,analytics_order_kind,status,attempts,max_attempts,run_after,created_at,updated_at) " +
  "values (gen_random_uuid(),'analytics.consume.v1',$1,$2,$3,$4,$5,$6,0," +
  "'queued',0,5,now(),now(),now()) " +
  "on conflict (dedupe_key) do nothing",
  [
    event.roomId,
    event.eventId,
    `analytics.consume.v1:${event.roomId}:${event.roomSeq}`,
    event.correlationId,
    {
      eventId: event.eventId,
      roomSeq: event.roomSeq,
      eventType: event.type
    },
    event.roomSeq
  ]
);
~~~

This insert is adjacent to the canonical <code>room_event</code> and <code>outbox_event</code> inserts and commits or rolls back with them. It copies the canonical event correlation ID into `worker_job.correlation_id`; tests claim the job and require exact equality across retries. Server identity supplies actor fields; client payload cannot set <code>actorKind</code> or <code>actorRole</code>. The worker reloads the validated <code>RoomEventEnvelope</code> by <code>source_event_id</code>; it never trusts the compact job payload as evidence.

- [ ] **Step 4: Run artifact and fanout tests**

Run:

~~~bash
cd learning-orbit/services/worker
python3.12 -m unittest -v tests.unit.test_derived_text
cd ../../
pnpm --filter @learning-orbit/server test -- analytics-job-fanout
~~~

Expected: PASS; every RoomEvent has exactly one ordered consume job, semantic no-op events are not skipped, and raw media cannot cross the text boundary without an independently versioned ASR/OCR artifact.

- [ ] **Step 5: Commit**

~~~bash
git add services/worker/src/learning_orbit_worker/domain.py services/worker/src/learning_orbit_worker/derived_text.py services/worker/tests/unit/test_derived_text.py apps/server/src/modules/rooms/room-event-repository.ts apps/server/test/rooms/analytics-job-fanout.test.ts
git commit -m "feat(analytics): consume every room event in order"
~~~

### Task 6: Build deterministic extraction and corrected golden fixtures

**Files:**
- Create: <code>learning-orbit/packages/test-fixtures/analytics/golden-room-events.json</code>
- Create: <code>learning-orbit/packages/test-fixtures/analytics/golden-trace-directions.json</code>
- Create: <code>learning-orbit/services/worker/src/learning_orbit_worker/extractors.py</code>
- Create: <code>learning-orbit/services/worker/tests/unit/test_golden_directions.py</code>
- Create: <code>learning-orbit/services/worker/tests/unit/test_deterministic_extractor.py</code>

- [ ] **Step 1: Write failing causal-direction fixtures**

<code>golden-room-events.json</code> contains exactly:

~~~json
[
  {
    "eventKey": "m001",
    "actorId": "yaqing",
    "actorKind": "human",
    "text": "我先把太陽連到生產者。",
    "replyTo": null,
    "mentions": [],
    "expectedCommunication": [["yaqing", "ROOM", 1.0]]
  },
  {
    "eventKey": "m002",
    "actorId": "zilang",
    "actorKind": "human",
    "text": "@雅晴 我同意能量從太陽進來。",
    "replyTo": "m001",
    "mentions": ["yaqing"],
    "expectedCommunication": [["zilang", "yaqing", 1.0]],
    "expectedUptake": [["yaqing", "zilang", 1.0]]
  },
  {
    "eventKey": "m004",
    "actorId": "haoran",
    "actorKind": "human",
    "text": "分解者讓物質回到土壤。",
    "replyTo": null,
    "mentions": [],
    "expectedCommunication": [["haoran", "ROOM", 1.0]]
  },
  {
    "eventKey": "m005",
    "actorId": "nova",
    "actorKind": "agent",
    "agentRole": "socratic_facilitator",
    "text": "你們會用哪一條觀察來反駁？",
    "replyTo": "m004",
    "mentions": [],
    "expectedCommunication": [],
    "expectedFacilitation": [["nova", "haoran", 1.0]]
  },
  {
    "eventKey": "m006",
    "actorId": "meilin",
    "actorKind": "human",
    "text": "@浩然 因為能量會散失成熱，我承接這個觀點。",
    "replyTo": "m005",
    "mentions": ["haoran"],
    "expectedCommunication": [["meilin", "haoran", 0.5], ["meilin", "nova", 0.5]],
    "expectedUptake": [["haoran", "meilin", 1.0]],
    "expectedFacilitation": []
  }
]
~~~

The test converts each fixture to the pinned <code>ChatEvent</code>, applies room sequence, and compares TRACE edges with the expected arrays. It additionally asserts that <code>m006</code> contains <code>haoran → meilin</code> uptake, contains no Nova uptake edge, and that Nova's <code>m005</code> move is represented only in the separate <code>facilitation</code> layer. A second test extracts the same ECHO candidate twice and asserts identical canonical JSON hashes.

- [ ] **Step 2: Run and verify the red state**

Run:

~~~bash
cd learning-orbit/services/worker
python3.12 -m unittest -v tests.unit.test_golden_directions tests.unit.test_deterministic_extractor
~~~

Expected: FAIL because fixture conversion and extractor artifact code are absent. The assertions reject the current demo’s reversed <code>m002</code> and invented <code>m004</code> target.

- [ ] **Step 3: Implement strict conversion and canonical output**

~~~python
import json
from dataclasses import dataclass
from hashlib import sha256

from learning_orbit_worker.reference.learning_orbit_algorithms_v1 import (
    ChatEvent,
    DeterministicEcosystemExtractor,
)

EXTRACTOR_VERSION = "deterministic-ecosystem-v1"


@dataclass(frozen=True)
class ResolvedLineage:
    reply_event_id: str | None
    target_event_id: str | None


class MessageLineageIndex:
    """Replay-local mapping from message root UUID to active RoomEvent UUID."""
    def __init__(self):
        self.active_by_message: dict[str, str] = {}

    def resolve_before(self, event):
        payload = event["payload"]
        reply = self.active_by_message.get(payload.get("replyTo"))
        target = self.active_by_message.get(payload.get("messageId"))
        if payload.get("replyTo") and reply is None:
            raise ValueError("reply message root has no active event")
        if event["operation"] in {"revise", "retract"} and target is None:
            raise ValueError("revision target has no active event")
        return ResolvedLineage(reply_event_id=reply, target_event_id=target)

    def advance(self, event):
        root = event["payload"].get("messageId")
        if not root:
            return
        if event["operation"] == "retract":
            self.active_by_message.pop(root, None)
        else:
            self.active_by_message[root] = event["eventId"]


def canonical_json(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, allow_nan=False,
        separators=(",", ":"), sort_keys=True,
    ).encode("utf-8")


def to_chat_event(room_event: dict, composite, lineage, effective_event_time) -> ChatEvent:
    payload = room_event["payload"]
    before = lineage.resolve_before(room_event)
    event = ChatEvent(
        event_id=room_event["eventId"],
        session_id=room_event["roomId"],
        event_time=effective_event_time.isoformat(),
        ingest_time=room_event["ingestTime"],
        actor_id=room_event["actorId"],
        actor_kind=room_event["actorKind"],
        modality=composite.modality if composite else "text",
        text=composite.text if composite else "",
        source_confidence=composite.source_confidence if composite else 1.0,
        revision=int(room_event["revision"]),
        operation=room_event["operation"],
        reply_to=before.reply_event_id,
        mentions=tuple(payload.get("mentions", [])),
        supersedes=before.target_event_id
        if room_event["operation"] == "revise" else None,
        retracts=before.target_event_id
        if room_event["operation"] == "retract" else None,
        agent_role="summary"
        if room_event.get("actorRole") == "socratic_facilitator"
        and payload.get("sourceEventIds") else None,
    )
    lineage.advance(room_event)
    return event


def extract_echo(event: ChatEvent, context: tuple[ChatEvent, ...]) -> dict:
    candidates = DeterministicEcosystemExtractor().extract(event, context)
    output = {
        "extractorVersion": EXTRACTOR_VERSION,
        "eventId": event.event_id,
        "candidates": [candidate.to_dict() for candidate in candidates],
    }
    return {
        "output": output,
        "outputSha256": sha256(canonical_json(output)).hexdigest(),
    }
~~~

`build_composite_artifact(room_event, active_artifacts)` is an internal replay view, not a new wire or database row. It orders eligible active sources as learner direct text, then the confirmed message's `mediaIds` order, then derivation precedence; it concatenates with explicit separators and retains an offset map back to each artifact/source event span. This yields at most one semantic `ChatEvent` per RoomEvent revision. For a media-only message with reply/mention/broadcast but no derived text, the adapter uses the pinned reference's legal `modality="text", text=""` solely to preserve TRACE communication metadata; the external evidence basis remains `event_metadata`. Lifecycle/review notices do not become ChatEvents and advance only projection cursors. A later ASR/OCR artifact triggers full replay, rebuilding the same event with enriched semantic text but never adding a second communication move. Extracted spans are translated back through the offset map before any `EvidenceRef` is stored.

`MessageLineageIndex` is rebuilt in `roomSeq` order for online catch-up and batch replay. Plan 01's `replyTo` and `messageId` are message-root UUIDs, whereas the pinned reference indexes ChatEvents by event UUID; the adapter therefore resolves replies to the current active target event and resolves revise/retract to the prior active event before advancing the root. Tests use deliberately different message/event UUIDs, two revisions, a retraction, a self-reply, media-only reply/mention and a later ASR replay. They require the old ECHO/TRACE contribution to disappear, the new one to appear once, reply communication to point to the intended actor, and online/batch hashes to match. No nonexistent payload `supersedes` or `retracts` field is read.

For a Plan 04 Nova final message, validate every `sourceEventId` against the same room and current/retracted audit index, require an original human student event, and build pinned `SourceRef` values carrying source actor/event evidence. The wire actor role remains `socratic_facilitator`; only the internal adapter maps a provenance-bearing Nova summary to the pinned reference's `agent_role="summary"` and calls `StreamingInteractionNetwork.apply(chat_event, sources=validated_source_refs)`. Unknown/cross-room/Agent-only sources fail closed and the Agent message receives a warning rather than lineage credit. The golden fixture uses the exact Plan 04 final-message payload, then a student uptake reply, and proves `lineage_adjusted` credits the original student while Nova retains a separate facilitation edge.

<code>to_chat_event</code> 是单向 internal adapter boundary：输入必须先通过 canonical <code>RoomEventEnvelope</code> schema；返回的 reference <code>ChatEvent</code> 只供 Python ECHO/TRACE 调用。任何代码不得把其 <code>to_dict()</code> 当成新的 wire event 或写入 realtime frame。

Before insertion, validate every evidence <code>eventId</code>, text span, enum, finite number and probability. A deterministic contract violation becomes a dead job with a reason code; it cannot commit an artifact or learner-facing state.

- [ ] **Step 4: Run both tests twice**

Run:

~~~bash
cd learning-orbit/services/worker
python3.12 -m unittest -v tests.unit.test_golden_directions tests.unit.test_deterministic_extractor
python3.12 -m unittest -v tests.unit.test_golden_directions tests.unit.test_deterministic_extractor
~~~

Expected: both runs PASS and produce identical output hashes; <code>m006</code> uptake is <code>haoran → meilin</code>, while Nova facilitation remains a separate layer.

- [ ] **Step 5: Commit**

~~~bash
git add packages/test-fixtures/analytics services/worker/src/learning_orbit_worker/extractors.py services/worker/tests/unit/test_golden_directions.py services/worker/tests/unit/test_deterministic_extractor.py
git commit -m "feat(analytics): add deterministic extractor and causal fixtures"
~~~

### Task 7: Freeze the ECHO-CM internal-to-wire adapter

**Files:**
- Create: <code>learning-orbit/packages/contracts/schemas/echo-concept-projection.v1.json</code>
- Generate: <code>learning-orbit/packages/contracts/src/generated/echo-concept-projection.v1.ts</code>
- Modify: <code>learning-orbit/packages/contracts/src/generated/manifest.json</code>
- Modify: <code>learning-orbit/services/worker/src/learning_orbit_worker/generated/manifest.json</code>
- Modify: <code>learning-orbit/packages/contracts/test/analytics-contracts.test.ts</code>
- Create: <code>learning-orbit/services/worker/src/learning_orbit_worker/echo_adapter.py</code>
- Create: <code>learning-orbit/services/worker/tests/unit/test_echo_adapter.py</code>
- Create: <code>learning-orbit/packages/test-fixtures/analytics/golden-echo-projection.json</code>

- [ ] **Step 1: Write failing adapter tests**

~~~python
import unittest

from learning_orbit_worker.echo_adapter import (
    diff_echo_snapshots,
    project_echo_snapshot,
)


def make_echo_projection(
    approved_edge_ids: set[str] | None = None,
    approved_node_ids: set[str] | None = None,
) -> dict:
    internal = reference_echo_snapshot_from_events(golden_echo_events())
    metadata = {
        "roomId": "00000000-0000-4000-8000-000000000010",
        "analysisEpoch": "00000000-0000-4000-8000-000000000901",
        "algorithmVersion": "echo-cm-reference-v1+adapter-v1",
        "parameterHash": "b" * 64,
        "projectionVersion": 1,
        "baseVersion": 0,
        "completeThroughRoomSeq": 1,
        "watermarkEventTime": "2026-08-28T09:01:55+08:00",
        "requiresReplay": False,
        "warnings": [],
    }
    evidence = {
        "evidence-1": {
            "evidenceId": "evidence-1",
            "eventId": "00000000-0000-4000-8000-000000000101",
            "start": 0,
            "end": 9,
        }
    }
    return project_echo_snapshot(
        internal,
        metadata,
        evidence,
        approved_edge_ids or set(),
        approved_node_ids or set(),
    )


class EchoAdapterTests(unittest.TestCase):
    def test_activity_is_not_presented_as_correctness(self) -> None:
        edge = make_echo_projection()["teacher"]["payload"]["edges"][0]
        self.assertEqual(
            edge["edgeId"],
            "e9d17530-a4bb-5717-9d50-11ba588f51f1",
        )
        self.assertNotIn("edge-1", json.dumps(make_echo_projection()))
        self.assertIn(
            edge["evidenceStatus"],
            {"supported", "challenged", "uncertain", "disputed"},
        )
        self.assertEqual(edge["reviewStatus"], "unreviewed")
        self.assertEqual(edge["displayStatus"], "provisional")
        self.assertIn("activityScore", edge)
        self.assertNotIn("confidence", edge)
        self.assertTrue(edge["evidenceRefs"][0]["eventId"])

    def test_unreviewed_edge_is_hidden_from_student(self) -> None:
        projections = make_echo_projection(approved_edge_ids=set())
        self.assertEqual(projections["student"]["payload"]["edges"], [])
        self.assertEqual(projections["student"]["payload"]["nodes"], [])

    def test_student_nodes_are_only_approved_edge_endpoints(self) -> None:
        projections = make_echo_projection(approved_edge_ids={
            "e9d17530-a4bb-5717-9d50-11ba588f51f1"
        })
        self.assertEqual(
            {node["nodeId"] for node in projections["student"]["payload"]["nodes"]},
            {"sun", "producers"},
        )
        self.assertNotIn("orphan", json.dumps(projections["student"]))

    def test_explicitly_approved_isolated_node_is_visible(self) -> None:
        projections = make_echo_projection(approved_node_ids={"orphan"})
        self.assertEqual(
            [node["nodeId"] for node in projections["student"]["payload"]["nodes"]],
            ["orphan"],
        )

    def test_snapshot_diff_emits_incremental_concept_patch(self) -> None:
        current = make_echo_projection()["teacher"]
        previous = {
            **current,
            "projectionVersion": 0,
            "baseVersion": 0,
            "payload": {"nodes": [], "edges": []},
        }
        patch = diff_echo_snapshots(
            previous,
            current,
            {
                "analysisEpoch": current["analysisEpoch"],
                "algorithmVersion": current["algorithmVersion"],
                "parameterHash": current["parameterHash"],
                "projectionVersion": 1,
                "baseVersion": 0,
                "completeThroughRoomSeq": 1,
                "requiresReplay": False,
                "warnings": [],
                "reasonCodes": ["event_applied"],
            },
        )
        self.assertEqual(len(patch["nodesAdded"]), 2)
        self.assertEqual(len(patch["edgesAdded"]), 1)
        self.assertEqual(patch["edgesUpdated"], [])
        self.assertEqual(patch["edgesHidden"], [])
        self.assertEqual(
            patch["evidenceRefs"][0]["eventId"],
            "00000000-0000-4000-8000-000000000101",
        )
        self.assertNotIn("confidence", patch["edgesAdded"][0])
~~~

Add this compile-time ownership test to <code>packages/contracts/test/analytics-contracts.test.ts</code>:

~~~typescript
import echoSchema from "../schemas/echo-concept-projection.v1.json";
import goldenEchoProjection
  from "../../test-fixtures/analytics/golden-echo-projection.json";
import type {
  ConceptMapPatch,
  ConceptMapSnapshot
} from "../src/generated/echo-concept-projection.v1";

test("echo schema-basename module owns snapshot and patch", () => {
  expectTypeOf<ConceptMapSnapshot>().toBeObject();
  expectTypeOf<ConceptMapPatch>().toHaveProperty("nodesAdded");
  expectTypeOf<ConceptMapPatch>().toHaveProperty("edgesUpdated");
  expectTypeOf<ConceptMapPatch>().not.toHaveProperty("confidence");
});

test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  "echo wire rejects non-finite numeric values: %s",
  (badNumber) => {
    const valid = ajv.compile(echoSchema);
    const candidate = structuredClone(goldenEchoProjection);
    candidate.payload.edges[0].channels.support = badNumber;
    expect(valid(candidate)).toBe(false);
  }
);
~~~

- [ ] **Step 2: Run and verify import failure**

Run: <code>cd learning-orbit/services/worker &amp;&amp; python3.12 -m unittest -v tests.unit.test_echo_adapter</code>

Expected: FAIL because <code>echo_adapter.py</code> does not exist.

- [ ] **Step 3: Implement the adapter outside the pinned reference**

Create <code>echo-concept-projection.v1.json</code> with generated definitions for both <code>ConceptMapSnapshot</code> and <code>ConceptMapPatch</code>. The patch definition is closed to additional properties and requires:

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://learning-orbit.local/schemas/echo-concept-projection.v1.json",
  "title": "EchoConceptProjection",
  "oneOf": [
    { "$ref": "#/$defs/ConceptMapSnapshot" },
    { "$ref": "#/$defs/ConceptMapPatch" }
  ],
  "$defs": {
    "EvidenceRef": {
      "type": "object",
      "additionalProperties": false,
      "required": ["eventId", "start", "end"],
      "properties": {
        "eventId": { "type": "string", "format": "uuid" },
        "start": { "type": "integer", "minimum": 0 },
        "end": { "type": "integer", "minimum": 1 }
      }
    },
    "Position": {
      "type": "object",
      "additionalProperties": false,
      "required": ["x", "y"],
      "properties": {
        "x": { "type": "number", "minimum": 0, "maximum": 1 },
        "y": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    },
    "ConceptNode": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "nodeId", "label", "nodeKind", "evidenceStatus",
        "reviewStatus", "displayStatus", "position"
      ],
      "properties": {
        "nodeId": { "type": "string", "minLength": 1, "maxLength": 160 },
        "label": { "type": "string", "minLength": 1, "maxLength": 160 },
        "nodeKind": { "const": "concept" },
        "evidenceStatus": {
          "enum": [
            "supported", "challenged", "uncertain", "disputed",
            "retracted", "superseded", "requires_replay"
          ]
        },
        "reviewStatus": {
          "enum": ["unreviewed", "approved", "rejected", "corrected"]
        },
        "displayStatus": {
          "enum": ["confirmed", "provisional", "disputed", "inactive"]
        },
        "position": { "$ref": "#/$defs/Position" }
      }
    },
    "ConceptChannels": {
      "type": "object",
      "additionalProperties": false,
      "required": ["support", "challenge", "uncertain", "question"],
      "properties": {
        "support": { "type": "number", "minimum": 0 },
        "challenge": { "type": "number", "minimum": 0 },
        "uncertain": { "type": "number", "minimum": 0 },
        "question": { "type": "number", "minimum": 0 }
      }
    },
    "ConceptEdge": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "edgeId", "head", "predicate", "tail", "relationFamily",
        "evidenceStatus", "reviewStatus", "displayStatus",
        "channels", "activityScore", "evidenceRefs"
      ],
      "properties": {
        "edgeId": { "type": "string", "format": "uuid" },
        "head": { "type": "string", "minLength": 1, "maxLength": 160 },
        "predicate": { "type": "string", "minLength": 1 },
        "tail": { "type": "string", "minLength": 1, "maxLength": 160 },
        "relationFamily": { "type": "string", "minLength": 1, "maxLength": 80 },
        "evidenceStatus": {
          "enum": [
            "supported", "challenged", "uncertain", "disputed",
            "retracted", "superseded", "requires_replay"
          ]
        },
        "reviewStatus": {
          "enum": ["unreviewed", "approved", "rejected", "corrected"]
        },
        "displayStatus": {
          "enum": ["confirmed", "provisional", "disputed", "inactive"]
        },
        "channels": { "$ref": "#/$defs/ConceptChannels" },
        "activityScore": { "type": "number", "minimum": 0 },
        "evidenceRefs": {
          "type": "array",
          "minItems": 1,
          "items": { "$ref": "#/$defs/EvidenceRef" }
        }
      }
    },
    "PositionUpdate": {
      "type": "object",
      "additionalProperties": false,
      "required": ["nodeId", "x", "y"],
      "properties": {
        "nodeId": { "type": "string", "minLength": 1, "maxLength": 160 },
        "x": { "type": "number", "minimum": 0, "maximum": 1 },
        "y": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    },
    "ConceptMapSnapshot": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "schemaVersion", "projectionKey", "roomId", "analysisEpoch",
        "algorithmVersion", "parameterHash",
        "projectionVersion", "baseVersion", "completeThroughRoomSeq",
        "watermarkEventTime", "requiresReplay", "evidenceStatus",
        "reviewStatus", "displayStatus", "warnings", "payload"
      ],
      "properties": {
        "schemaVersion": { "const": 1 },
        "projectionKey": {
          "enum": ["echo.teacher_shadow", "echo.student_approved"]
        },
        "roomId": { "type": "string", "format": "uuid" },
        "analysisEpoch": { "type": "string", "format": "uuid" },
        "algorithmVersion": { "type": "string", "minLength": 1, "maxLength": 160 },
        "parameterHash": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
        "projectionVersion": { "type": "integer", "minimum": 1 },
        "baseVersion": { "type": "integer", "minimum": 0 },
        "completeThroughRoomSeq": { "type": "integer", "minimum": 0 },
        "watermarkEventTime": { "type": "string", "format": "date-time" },
        "requiresReplay": { "type": "boolean" },
        "evidenceStatus": {
          "enum": ["active", "retracted", "superseded", "requires_replay"]
        },
        "reviewStatus": {
          "enum": ["unreviewed", "approved", "rejected", "corrected"]
        },
        "displayStatus": {
          "enum": ["hidden", "teacher_shadow", "student_approved"]
        },
        "warnings": {
          "type": "array",
          "items": { "type": "string", "minLength": 1, "maxLength": 160 }
        },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["nodes", "edges"],
          "properties": {
            "nodes": {
              "type": "array",
              "items": { "$ref": "#/$defs/ConceptNode" }
            },
            "edges": {
              "type": "array",
              "items": { "$ref": "#/$defs/ConceptEdge" }
            }
          }
        }
      }
    },
    "ConceptMapPatch": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "analysisEpoch", "algorithmVersion", "parameterHash",
        "projectionVersion", "baseVersion",
        "completeThroughRoomSeq", "requiresReplay", "warnings",
        "nodesAdded", "nodesUpdated", "nodesHidden",
        "edgesAdded", "edgesUpdated", "edgesHidden",
        "positionUpdates", "changeScore", "reasonCodes", "evidenceRefs"
      ],
      "properties": {
        "analysisEpoch": { "type": "string", "format": "uuid" },
        "algorithmVersion": { "type": "string", "minLength": 1, "maxLength": 160 },
        "parameterHash": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
        "projectionVersion": { "type": "integer", "minimum": 1 },
        "baseVersion": { "type": "integer", "minimum": 0 },
        "completeThroughRoomSeq": { "type": "integer", "minimum": 0 },
        "requiresReplay": { "type": "boolean" },
        "warnings": { "type": "array", "items": { "type": "string" } },
        "nodesAdded": {
          "type": "array", "items": { "$ref": "#/$defs/ConceptNode" }
        },
        "nodesUpdated": {
          "type": "array", "items": { "$ref": "#/$defs/ConceptNode" }
        },
        "nodesHidden": {
          "type": "array",
          "items": { "type": "string", "minLength": 1, "maxLength": 160 }
        },
        "edgesAdded": { "type": "array", "items": { "$ref": "#/$defs/ConceptEdge" } },
        "edgesUpdated": { "type": "array", "items": { "$ref": "#/$defs/ConceptEdge" } },
        "edgesHidden": { "type": "array", "items": { "type": "string", "format": "uuid" } },
        "positionUpdates": {
          "type": "array", "items": { "$ref": "#/$defs/PositionUpdate" }
        },
        "changeScore": { "type": "number", "minimum": 0, "maximum": 1 },
        "reasonCodes": {
          "type": "array",
          "items": { "type": "string", "minLength": 1, "maxLength": 160 }
        },
        "evidenceRefs": {
          "type": "array",
          "items": { "$ref": "#/$defs/EvidenceRef" }
        }
      }
    }
  }
}
~~~

The same schema defines <code>ConceptMapSnapshot</code> as the full ECHO projection envelope with <code>payload.nodes</code> and <code>payload.edges</code>. Generate <code>ConceptMapSnapshot</code> and <code>ConceptMapPatch</code> only in <code>packages/contracts/src/generated/echo-concept-projection.v1.ts</code>; <code>src/index.ts</code> may re-export them. Plan 05 imports that canonical module or the index re-export and defines no local substitutes.

The adapter converts the reference implementation's internal edge key to a deterministic UUIDv5 using namespace <code>e9dd1cf5-3f28-5fe7-9d73-8f98f8bca0e1</code> and the canonical JSON array <code>[roomId,NFC(head),NFC(predicate),NFC(tail),NFC(relationFamily)]</code>. The example edge therefore maps exactly to <code>e9d17530-a4bb-5717-9d50-11ba588f51f1</code>. That UUID is the review <code>targetId</code> when <code>targetType="projection"</code>; display labels such as “c17” and internal keys such as <code>edge-1</code> are input-only and never enter snapshots, patches, fixtures, review payloads or realtime frames. Tests prove online and replay produce the same UUID and that an ID from another room cannot be reviewed.

The adapter test input must be the actual pinned `StreamingConceptMap.snapshot()` result produced from the golden events, not a dictionary pre-shaped like the wire. Reference nodes contain `nodeId,label,conceptType,x,y` and no status: validate that shape, map the supported reference concept types to wire `nodeKind:"concept"`, derive node evidence state from incident edge channels with the documented precedence above, and map reference coordinates from `[-1,1]` to `[0,1]` using `(value+1)/2`. Reference channel/activity values are non-negative decayed accumulations and may exceed 1; they are not probabilities or confidence. This adapter formula/version participates in `algorithmVersion` and `parameterHash`. Multi-evidence fixtures force channel/activity values above 1, negative reference coordinates and a node with no incident edge so schema/parity tests cannot be satisfied by the old hand-shaped fixture.

<code>golden-echo-projection.json</code> contains the UUID above as its only <code>edgeId</code>. A fixture assertion recursively rejects the literal <code>edge-1</code> anywhere in the serialized golden wire object.

~~~python
import json
from unicodedata import normalize
from uuid import UUID, uuid5

ECHO_EDGE_NAMESPACE = UUID("e9dd1cf5-3f28-5fe7-9d73-8f98f8bca0e1")


def normalize_position(value: float) -> float:
    if not -1.0 <= value <= 1.0:
        raise ValueError("reference ECHO position outside [-1,1]")
    return (value + 1.0) / 2.0


def node_evidence_status(node_id: str, edges: list[dict]) -> str:
    incident = [edge for edge in edges if node_id in (edge["head"], edge["tail"])]
    has_support = any(edge["channels"]["support"] > 0 for edge in incident)
    has_challenge = any(edge["channels"]["challenge"] > 0 for edge in incident)
    if has_support and has_challenge:
        return "disputed"
    if has_support:
        return "supported"
    if has_challenge:
        return "challenged"
    return "uncertain"


def visual_status(evidence_status: str, approved: bool, inactive: bool) -> str:
    if inactive:
        return "inactive"
    if evidence_status == "disputed":
        return "disputed"
    if approved and evidence_status == "supported":
        return "confirmed"
    return "provisional"


def echo_wire_edge_id(room_id: str, edge: dict) -> str:
    name = json.dumps(
        [
            room_id,
            normalize("NFC", edge["head"]),
            normalize("NFC", edge["predicate"]),
            normalize("NFC", edge["tail"]),
            normalize("NFC", edge["relationFamily"]),
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return str(uuid5(ECHO_EDGE_NAMESPACE, name))


def project_echo_snapshot(
    internal: dict,
    metadata: dict,
    evidence_index: dict[str, dict],
    approved_edge_ids: set[str],
    approved_node_ids: set[str],
) -> dict[str, dict]:
    teacher_edges = []
    student_edges = []
    approved_endpoint_ids: set[str] = set()
    for edge in internal["edges"]:
        channels = edge["channels"]
        wire_id = echo_wire_edge_id(metadata["roomId"], edge)
        approved = wire_id in approved_edge_ids
        projected = {
            "edgeId": wire_id,
            "head": edge["head"],
            "predicate": edge["predicate"],
            "tail": edge["tail"],
            "relationFamily": edge["relationFamily"],
            "evidenceStatus": edge["status"],
            "reviewStatus": "approved" if approved else "unreviewed",
            "displayStatus": visual_status(
                edge["status"], approved, metadata["requiresReplay"]
            ),
            "channels": channels,
            "activityScore": max(
                channels["support"],
                channels["challenge"],
                channels["uncertain"],
                channels["question"],
            ),
            "evidenceRefs": [
                evidence_index[evidence_id]
                for evidence_id in edge["evidenceIds"]
            ],
        }
        teacher_edges.append(projected)
        if approved:
            student_edges.append(projected)
            approved_endpoint_ids.update((edge["head"], edge["tail"]))
    student_node_ids = approved_node_ids | approved_endpoint_ids
    teacher_nodes = []
    student_nodes = []
    for node in internal["nodes"]:
        approved = node["nodeId"] in student_node_ids
        node_status = node_evidence_status(node["nodeId"], internal["edges"])
        teacher_node = {
            "nodeId": node["nodeId"],
            "label": node["label"],
            "nodeKind": "concept",
            "evidenceStatus": node_status,
            "reviewStatus": "approved" if approved else "unreviewed",
            "displayStatus": visual_status(
                node_status, approved, metadata["requiresReplay"]
            ),
            "position": {
                "x": normalize_position(node["x"]),
                "y": normalize_position(node["y"]),
            },
        }
        teacher_nodes.append(teacher_node)
        if approved:
            student_nodes.append(teacher_node)
    common = {
        "schemaVersion": 1,
        "roomId": metadata["roomId"],
        "analysisEpoch": metadata["analysisEpoch"],
        "algorithmVersion": metadata["algorithmVersion"],
        "parameterHash": metadata["parameterHash"],
        "projectionVersion": metadata["projectionVersion"],
        "baseVersion": metadata["baseVersion"],
        "completeThroughRoomSeq": metadata["completeThroughRoomSeq"],
        "watermarkEventTime": metadata["watermarkEventTime"],
        "requiresReplay": metadata["requiresReplay"],
        "evidenceStatus": "requires_replay"
        if metadata["requiresReplay"] else "active",
        "warnings": list(metadata["warnings"]),
    }
    return {
        "teacher": {
            **common, "projectionKey": "echo.teacher_shadow",
            "reviewStatus": "unreviewed", "displayStatus": "teacher_shadow",
            "payload": {"nodes": teacher_nodes, "edges": teacher_edges},
        },
        "student": {
            **common, "projectionKey": "echo.student_approved",
            "reviewStatus": "approved"
            if (student_edges or student_nodes) else "unreviewed",
            "displayStatus": "student_approved",
            "payload": {"nodes": student_nodes, "edges": student_edges},
        },
    }


def diff_echo_snapshots(
    previous: dict,
    current: dict,
    metadata: dict,
) -> dict:
    previous_nodes = {
        node["nodeId"]: node for node in previous["payload"]["nodes"]
    }
    current_nodes = {
        node["nodeId"]: node for node in current["payload"]["nodes"]
    }
    previous_edges = {
        edge["edgeId"]: edge for edge in previous["payload"]["edges"]
    }
    current_edges = {
        edge["edgeId"]: edge for edge in current["payload"]["edges"]
    }
    nodes_added = [
        current_nodes[key] for key in sorted(current_nodes.keys() - previous_nodes)
    ]
    nodes_updated = [
        current_nodes[key]
        for key in sorted(current_nodes.keys() & previous_nodes)
        if current_nodes[key] != previous_nodes[key]
    ]
    edges_added = [
        current_edges[key] for key in sorted(current_edges.keys() - previous_edges)
    ]
    edges_updated = [
        current_edges[key]
        for key in sorted(current_edges.keys() & previous_edges)
        if current_edges[key] != previous_edges[key]
    ]
    changed_nodes = nodes_added + nodes_updated
    position_updates = [
        {
            "nodeId": node["nodeId"],
            "x": node["position"]["x"],
            "y": node["position"]["y"],
        }
        for node in changed_nodes
        if "position" in node
    ]
    evidence_by_key = {}
    for edge in edges_added + edges_updated:
        for ref in edge["evidenceRefs"]:
            key = (ref["eventId"], ref["start"], ref["end"])
            evidence_by_key[key] = ref
    change_count = (
        len(nodes_added) + len(nodes_updated)
        + len(previous_nodes.keys() - current_nodes)
        + len(edges_added) + len(edges_updated)
        + len(previous_edges.keys() - current_edges)
    )
    denominator = max(1, len(previous_nodes) + len(previous_edges))
    return {
        "analysisEpoch": metadata["analysisEpoch"],
        "algorithmVersion": metadata["algorithmVersion"],
        "parameterHash": metadata["parameterHash"],
        "projectionVersion": metadata["projectionVersion"],
        "baseVersion": metadata["baseVersion"],
        "completeThroughRoomSeq": metadata["completeThroughRoomSeq"],
        "requiresReplay": metadata["requiresReplay"],
        "warnings": list(metadata["warnings"]),
        "nodesAdded": nodes_added,
        "nodesUpdated": nodes_updated,
        "nodesHidden": sorted(previous_nodes.keys() - current_nodes),
        "edgesAdded": edges_added,
        "edgesUpdated": edges_updated,
        "edgesHidden": sorted(previous_edges.keys() - current_edges),
        "positionUpdates": position_updates,
        "changeScore": min(1.0, change_count / denominator),
        "reasonCodes": list(metadata["reasonCodes"]),
        "evidenceRefs": [
            evidence_by_key[key] for key in sorted(evidence_by_key)
        ],
    }
~~~

Evidence index comes from immutable extraction artifacts; the adapter never reads reference-model private attributes. Organization/similarity edges are excluded. Before serialization, the adapter validates that every numeric position, channel, activity and change score is finite and inside its schema range; any failure aborts the projection transaction with a redacted deterministic contract code.

For <code>echo.student_approved</code>, the node set must equal the union of explicitly teacher-approved node IDs and the endpoints of teacher-approved edges. An endpoint inherits <code>reviewStatus=approved</code> only for this filtered student projection; unrelated internal nodes never hitchhike into the payload. Student ECHO edges retain only the teacher-approved <code>EvidenceRef {eventId,start,end}</code> objects needed to reopen a claim's source inside the same authorized room. This is the sole student evidence-reference exception: the referenced event must resolve in the requested room, the resolver reruns the room access guard, and no actor identity, raw media, media ID, storage key, provider field or signed URL is added. TRACE student bundles remain evidence-free.

<code>algorithmVersion</code> identifies the pinned reference plus adapter release and <code>parameterHash</code> is SHA-256 over canonical JSON of every extractor/adapter parameter. Both fields are stored and emitted unchanged in snapshot and patch metadata; a version/hash change starts a new <code>analysisEpoch</code> rather than extending an old patch chain.

- [ ] **Step 4: Generate schema types and run adapter tests**

Run:

~~~bash
cd learning-orbit
pnpm --filter @learning-orbit/contracts generate
pnpm --filter @learning-orbit/contracts test -- analytics-contracts
cd services/worker
python3.12 -m unittest -v tests.unit.test_echo_adapter
~~~

Expected: PASS and golden JSON equality.

- [ ] **Step 5: Commit**

~~~bash
git add packages/contracts/schemas/echo-concept-projection.v1.json packages/contracts/src/generated/echo-concept-projection.v1.ts packages/contracts/src/generated/manifest.json packages/contracts/src/index.ts packages/contracts/test/analytics-contracts.test.ts packages/test-fixtures/analytics/golden-echo-projection.json services/worker/src/learning_orbit_worker/generated/manifest.json services/worker/src/learning_orbit_worker/echo_adapter.py services/worker/tests/unit/test_echo_adapter.py
git commit -m "feat(analytics): freeze ECHO wire adapter"
~~~

### Task 8: Freeze TRACE-AI teacher and learner-safe adapters

**Files:**
- Create: <code>learning-orbit/packages/contracts/schemas/trace-projection.v1.json</code>
- Generate: <code>learning-orbit/packages/contracts/src/generated/trace-projection.v1.ts</code>
- Modify: <code>learning-orbit/packages/contracts/src/generated/manifest.json</code>
- Modify: <code>learning-orbit/services/worker/src/learning_orbit_worker/generated/manifest.json</code>
- Create: <code>learning-orbit/packages/contracts/src/trace-interpretation.ts</code>
- Modify: <code>learning-orbit/packages/contracts/src/index.ts</code>
- Modify: <code>learning-orbit/packages/contracts/test/analytics-contracts.test.ts</code>
- Create: <code>learning-orbit/services/worker/src/learning_orbit_worker/trace_adapter.py</code>
- Create: <code>learning-orbit/services/worker/tests/unit/test_trace_adapter.py</code>
- Create: <code>learning-orbit/packages/test-fixtures/analytics/golden-trace-projections.json</code>

- [ ] **Step 1: Write failing direction and data-leak tests**

~~~python
import json
import unittest

from learning_orbit_worker.trace_adapter import project_trace, scoped_node_id


def make_trace_projections(human_count: int = 4) -> tuple[dict, dict]:
    reference_snapshot = reference_trace_snapshot_from_events(golden_trace_events())
    metadata = {
        "roomId": "00000000-0000-4000-8000-000000000010",
        "analysisEpoch": "00000000-0000-4000-8000-000000000901",
        "algorithmVersion": "trace-ai-reference-v1+adapter-v1",
        "parameterHash": "c" * 64,
        "projectionVersion": 1,
        "baseVersion": 0,
        "completeThroughRoomSeq": 5,
        "watermarkEventTime": "2026-08-28T09:13:55+08:00",
        "requiresReplay": False,
        "warnings": [],
        "teacherActorMapping": {
            "yaqing": {"actorId": "00000000-0000-4000-8000-000000000101", "pseudonym": "探索者 A", "kind": "learner"},
            "zilang": {"actorId": "00000000-0000-4000-8000-000000000102", "pseudonym": "探索者 B", "kind": "learner"},
            "meilin": {"actorId": "00000000-0000-4000-8000-000000000103", "pseudonym": "探索者 C", "kind": "learner"},
            "haoran": {"actorId": "00000000-0000-4000-8000-000000000104", "pseudonym": "探索者 D", "kind": "learner"},
        },
    }
    pseudonyms = {
        "yaqing": {"nodeId": "p-1111111111111111", "label": "探索者 A", "kind": "learner"},
        "zilang": {"nodeId": "p-2222222222222222", "label": "探索者 B", "kind": "learner"},
        "meilin": {"nodeId": "p-3333333333333333", "label": "探索者 C", "kind": "learner"},
        "haoran": {"nodeId": "p-4444444444444444", "label": "探索者 D", "kind": "learner"},
        "nova": {"nodeId": "p-aaaaaaaaaaaaaaaa", "label": "Nova Agent", "kind": "agent"},
        "ROOM": {"nodeId": "p-bbbbbbbbbbbbbbbb", "label": "共學聊天室", "kind": "room"},
    }
    return project_trace(
        {"recent_10m": reference_snapshot, "session_45m": reference_snapshot},
        {
            "recent_10m": {"windowStartEventTime": "2026-08-28T09:08:00Z", "windowEndEventTime": "2026-08-28T09:18:00Z"},
            "session_45m": {"windowStartEventTime": "2026-08-28T09:00:00Z", "windowEndEventTime": "2026-08-28T09:18:00Z"},
        },
        metadata, pseudonyms,
        golden_trace_evidence_index(), human_count,
    )


class TraceAdapterTests(unittest.TestCase):
    def test_teacher_projection_preserves_causal_directions(self) -> None:
        teacher, student = make_trace_projections()
        self.assertEqual(teacher["projectionKey"], "trace.teacher_bundle")
        self.assertEqual(student["projectionKey"], "trace.student_bundle")
        for field in (
            "analysisEpoch", "projectionVersion", "baseVersion",
            "completeThroughRoomSeq", "algorithmVersion", "parameterHash",
        ):
            self.assertEqual(teacher[field], student[field])
        self.assertEqual(set(teacher["payload"]["windows"]), {"recent_10m", "session_45m"})
        for window in teacher["payload"]["windows"].values():
            self.assertEqual(set(window["views"]), {"observed", "human_only", "lineage_adjusted"})
        edges = {
            (edge["sourceId"], edge["targetId"], edge["layer"])
            for edge in teacher["payload"]["windows"]["recent_10m"]["views"]["observed"]["edges"]
        }
        self.assertIn(("zilang", "yaqing", "communication"), edges)
        self.assertIn(("yaqing", "zilang", "uptake"), edges)
        self.assertIn(("haoran", "ROOM", "communication"), edges)
        self.assertIn(("nova", "haoran", "facilitation"), edges)
        self.assertIn(("haoran", "meilin", "uptake"), edges)
        self.assertNotIn(("yaqing", "zilang", "communication"), edges)
        self.assertEqual(
            teacher["payload"]["actorMapping"]["yaqing"]["pseudonym"],
            "探索者 A",
        )

    def test_student_projection_uses_session_pseudonyms(self) -> None:
        unused_teacher, student = make_trace_projections(human_count=4)
        self.assertEqual(set(student["payload"]["windows"]), {"recent_10m", "session_45m"})
        serialized = json.dumps(student, sort_keys=True)
        for field in (
            "actorId", "sourceId", "targetId", "evidenceIds",
            "weightedInStrength", "weightedOutStrength",
            "actorMapping", "identityMapping", "evidenceRefs", "weight",
            "yaqing", "zilang", "meilin", "haoran",
        ):
            self.assertNotIn(field, serialized)
        self.assertEqual(
            student["payload"]["windows"]["recent_10m"]["views"]["observed"]["nodes"][0]["nodeId"],
            "p-1111111111111111",
        )
        self.assertIn(
            {
                "sourceNodeId": "p-2222222222222222",
                "targetNodeId": "p-1111111111111111",
                "layer": "communication",
            },
            student["payload"]["windows"]["recent_10m"]["views"]["observed"]["edges"],
        )
        self.assertEqual(
            student["payload"]["windows"]["recent_10m"]["views"]["observed"]["metrics"]["participationBalance"],
            0.78,
        )
        self.assertEqual(
            set(student["payload"]["windows"]["recent_10m"]["views"]["observed"]["metrics"]),
            {"participationBalance", "reciprocity", "agentShare", "semanticCoverage"},
        )
        self.assertIn(
            "small_group_interpretation_warning",
            student["payload"]["windows"]["recent_10m"]["views"]["observed"]["warnings"],
        )

    def test_human_only_and_lineage_views_fail_closed(self) -> None:
        teacher, unused_student = make_trace_projections()
        for window in ("recent_10m", "session_45m"):
            human = teacher["payload"]["windows"][window]["views"]["human_only"]
            self.assertTrue(all(node["kind"] == "learner" for node in human["nodes"]))
            self.assertNotIn("ROOM", json.dumps(human))
            self.assertNotIn("nova", json.dumps(human))
            lineage = teacher["payload"]["windows"][window]["views"]["lineage_adjusted"]
            self.assertTrue(all(edge["layer"] == "uptake" for edge in lineage["edges"]))
            self.assertTrue(all(edge["evidenceRefs"] for edge in lineage["edges"]))

    def test_student_node_ids_rotate_with_analysis_epoch(self) -> None:
        first = scoped_node_id(b"room-key", "room-a", "epoch-a", "yaqing")
        second = scoped_node_id(b"room-key", "room-a", "epoch-b", "yaqing")
        self.assertRegex(first, r"^p-[a-f0-9]{16}$")
        self.assertNotEqual(first, second)
        self.assertNotIn("yaqing", first)
~~~

Add this compile-time ownership test to <code>packages/contracts/test/analytics-contracts.test.ts</code>:

~~~typescript
import traceSchema from "../schemas/trace-projection.v1.json";
import goldenTrace
  from "../../test-fixtures/analytics/golden-trace-projections.json";
import type {
  SnaProjectionBundle
} from "../src/generated/trace-projection.v1";

test("trace schema-basename module owns the atomic bundle", () => {
  expectTypeOf<SnaProjectionBundle>().toHaveProperty("payload");
  expectTypeOf<SnaProjectionBundle["payload"]>().toHaveProperty("windows");
});

test.each([
  ["actorId", "00000000-0000-4000-8000-000000000001"],
  ["evidenceRefs", []],
  ["weightedInStrength", 0.9],
  ["rank", 1],
  ["risk", "high"]
])("student TRACE rejects forbidden field %s", (field, value) => {
  const valid = ajv.compile(traceSchema);
  const student = structuredClone(goldenTrace.student);
  Object.assign(student.payload.windows.recent_10m.views.observed.nodes[0], { [field]: value });
  expect(valid(student)).toBe(false);
});
~~~

- [ ] **Step 2: Run and verify import failure**

Run: <code>cd learning-orbit/services/worker &amp;&amp; python3.12 -m unittest -v tests.unit.test_trace_adapter</code>

Expected: FAIL because <code>trace_adapter.py</code> is absent.

- [ ] **Step 3: Implement role-separated projection**

Create <code>trace-projection.v1.json</code> as the generated-type authority for <code>SnaProjectionBundle</code>:

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://learning-orbit.local/schemas/trace-projection.v1.json",
  "title": "SnaProjectionBundle",
  "oneOf": [
    { "$ref": "#/$defs/TeacherBundle" },
    { "$ref": "#/$defs/StudentBundle" }
  ],
  "$defs": {
    "EvidenceRef": {
      "type": "object",
      "additionalProperties": false,
      "required": ["eventId", "start", "end", "basis"],
      "properties": {
        "eventId": { "type": "string", "format": "uuid" },
        "start": { "type": ["integer", "null"], "minimum": 0 },
        "end": { "type": ["integer", "null"], "minimum": 1 },
        "basis": { "enum": ["text_span", "event_metadata"] }
      },
      "allOf": [
        { "if": { "properties": { "basis": { "const": "event_metadata" } } }, "then": { "properties": { "start": { "type": "null" }, "end": { "type": "null" } } } },
        { "if": { "properties": { "basis": { "const": "text_span" } } }, "then": { "properties": { "start": { "type": "integer", "minimum": 0 }, "end": { "type": "integer", "minimum": 1 } } } }
      ]
    },
    "GroupMetrics": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "participationBalance", "reciprocity", "agentShare", "semanticCoverage"
      ],
      "properties": {
        "participationBalance": { "type": "number", "minimum": 0, "maximum": 1 },
        "reciprocity": { "type": "number", "minimum": 0, "maximum": 1 },
        "agentShare": { "type": "number", "minimum": 0, "maximum": 1 },
        "semanticCoverage": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    },
    "TeacherNode": {
      "type": "object",
      "additionalProperties": false,
      "required": ["nodeId", "label", "kind"],
      "properties": {
        "nodeId": { "type": "string", "minLength": 1, "maxLength": 160 },
        "label": { "type": "string", "minLength": 1, "maxLength": 160 },
        "kind": { "enum": ["learner", "agent", "room"] }
      }
    },
    "HumanTeacherNode": {
      "type": "object",
      "additionalProperties": false,
      "required": ["nodeId", "label", "kind"],
      "properties": {
        "nodeId": { "type": "string", "minLength": 1, "maxLength": 160 },
        "label": { "type": "string", "minLength": 1, "maxLength": 160 },
        "kind": { "const": "learner" }
      }
    },
    "TraceChannels": {
      "type": "object",
      "additionalProperties": false,
      "required": ["positive", "challenge", "uncertain"],
      "properties": {
        "positive": { "type": "number", "minimum": 0 },
        "challenge": { "type": "number", "minimum": 0 },
        "uncertain": { "type": "number", "minimum": 0 }
      }
    },
    "TeacherEdge": {
      "type": "object",
      "additionalProperties": false,
      "required": ["edgeId", "sourceId", "targetId", "layer", "channels", "weight", "evidenceRefs"],
      "properties": {
        "edgeId": { "type": "string", "format": "uuid" },
        "sourceId": { "type": "string", "minLength": 1, "maxLength": 160 },
        "targetId": { "type": "string", "minLength": 1, "maxLength": 160 },
        "layer": { "enum": ["communication", "uptake", "stance", "coordination", "facilitation"] },
        "channels": { "$ref": "#/$defs/TraceChannels" },
        "weight": { "type": "number", "exclusiveMinimum": 0 },
        "evidenceRefs": {
          "type": "array", "minItems": 1,
          "items": { "$ref": "#/$defs/EvidenceRef" }
        }
      }
    },
    "HumanTeacherEdge": {
      "type": "object",
      "additionalProperties": false,
      "required": ["edgeId", "sourceId", "targetId", "layer", "channels", "weight", "evidenceRefs"],
      "properties": {
        "edgeId": { "type": "string", "format": "uuid" },
        "sourceId": { "type": "string", "minLength": 1, "maxLength": 160 },
        "targetId": { "type": "string", "minLength": 1, "maxLength": 160 },
        "layer": { "enum": ["communication", "uptake", "stance", "coordination"] },
        "channels": { "$ref": "#/$defs/TraceChannels" },
        "weight": { "type": "number", "exclusiveMinimum": 0 },
        "evidenceRefs": {
          "type": "array", "minItems": 1,
          "items": { "$ref": "#/$defs/EvidenceRef" }
        }
      }
    },
    "LineageTeacherEdge": {
      "type": "object",
      "additionalProperties": false,
      "required": ["edgeId", "sourceId", "targetId", "layer", "channels", "weight", "evidenceRefs"],
      "properties": {
        "edgeId": { "type": "string", "format": "uuid" },
        "sourceId": { "type": "string", "minLength": 1, "maxLength": 160 },
        "targetId": { "type": "string", "minLength": 1, "maxLength": 160 },
        "layer": { "const": "uptake" },
        "channels": { "$ref": "#/$defs/TraceChannels" },
        "weight": { "type": "number", "exclusiveMinimum": 0 },
        "evidenceRefs": {
          "type": "array", "minItems": 1,
          "items": { "$ref": "#/$defs/EvidenceRef" }
        }
      }
    },
    "TeacherView": {
      "type": "object",
      "additionalProperties": false,
      "required": ["nodes", "edges", "metrics", "warnings"],
      "properties": {
        "nodes": { "type": "array", "items": { "$ref": "#/$defs/TeacherNode" } },
        "edges": { "type": "array", "items": { "$ref": "#/$defs/TeacherEdge" } },
        "metrics": { "$ref": "#/$defs/GroupMetrics" },
        "warnings": {
          "type": "array", "items": { "type": "string", "minLength": 1 }
        }
      }
    },
    "HumanTeacherView": {
      "type": "object",
      "additionalProperties": false,
      "required": ["nodes", "edges", "metrics", "warnings"],
      "properties": {
        "nodes": { "type": "array", "items": { "$ref": "#/$defs/HumanTeacherNode" } },
        "edges": { "type": "array", "items": { "$ref": "#/$defs/HumanTeacherEdge" } },
        "metrics": { "$ref": "#/$defs/GroupMetrics" },
        "warnings": {
          "type": "array", "items": { "type": "string", "minLength": 1 }
        }
      }
    },
    "LineageTeacherView": {
      "type": "object",
      "additionalProperties": false,
      "required": ["nodes", "edges", "metrics", "warnings"],
      "properties": {
        "nodes": { "type": "array", "items": { "$ref": "#/$defs/HumanTeacherNode" } },
        "edges": { "type": "array", "items": { "$ref": "#/$defs/LineageTeacherEdge" } },
        "metrics": { "$ref": "#/$defs/GroupMetrics" },
        "warnings": {
          "type": "array", "items": { "type": "string", "minLength": 1 }
        }
      }
    },
    "StudentNode": {
      "type": "object",
      "additionalProperties": false,
      "required": ["nodeId", "label", "kind"],
      "properties": {
        "nodeId": { "type": "string", "pattern": "^p-[a-f0-9]{16}$" },
        "label": { "type": "string", "minLength": 1, "maxLength": 80 },
        "kind": { "enum": ["learner", "agent", "room"] }
      }
    },
    "StudentHumanNode": {
      "type": "object",
      "additionalProperties": false,
      "required": ["nodeId", "label", "kind"],
      "properties": {
        "nodeId": { "type": "string", "pattern": "^p-[a-f0-9]{16}$" },
        "label": { "type": "string", "minLength": 1, "maxLength": 80 },
        "kind": { "const": "learner" }
      }
    },
    "StudentEdge": {
      "type": "object",
      "additionalProperties": false,
      "required": ["sourceNodeId", "targetNodeId", "layer"],
      "properties": {
        "sourceNodeId": { "type": "string", "pattern": "^p-[a-f0-9]{16}$" },
        "targetNodeId": { "type": "string", "pattern": "^p-[a-f0-9]{16}$" },
        "layer": { "enum": ["communication", "uptake"] }
      }
    },
    "StudentLineageEdge": {
      "type": "object",
      "additionalProperties": false,
      "required": ["sourceNodeId", "targetNodeId", "layer"],
      "properties": {
        "sourceNodeId": { "type": "string", "pattern": "^p-[a-f0-9]{16}$" },
        "targetNodeId": { "type": "string", "pattern": "^p-[a-f0-9]{16}$" },
        "layer": { "const": "uptake" }
      }
    },
    "StudentWarnings": {
      "type": "array",
      "contains": { "const": "small_group_interpretation_warning" },
      "minContains": 1,
      "items": {
        "enum": [
          "small_group_interpretation_warning", "recent_group_interaction_only",
          "requires_replay", "insufficient_window"
        ]
      }
    },
    "StudentView": {
      "type": "object",
      "additionalProperties": false,
      "required": ["nodes", "edges", "metrics", "warnings"],
      "properties": {
        "nodes": { "type": "array", "items": { "$ref": "#/$defs/StudentNode" } },
        "edges": { "type": "array", "items": { "$ref": "#/$defs/StudentEdge" } },
        "metrics": { "$ref": "#/$defs/GroupMetrics" },
        "warnings": { "$ref": "#/$defs/StudentWarnings" }
      }
    },
    "StudentHumanView": {
      "type": "object",
      "additionalProperties": false,
      "required": ["nodes", "edges", "metrics", "warnings"],
      "properties": {
        "nodes": { "type": "array", "items": { "$ref": "#/$defs/StudentHumanNode" } },
        "edges": { "type": "array", "items": { "$ref": "#/$defs/StudentEdge" } },
        "metrics": { "$ref": "#/$defs/GroupMetrics" },
        "warnings": { "$ref": "#/$defs/StudentWarnings" }
      }
    },
    "StudentLineageView": {
      "type": "object",
      "additionalProperties": false,
      "required": ["nodes", "edges", "metrics", "warnings"],
      "properties": {
        "nodes": { "type": "array", "items": { "$ref": "#/$defs/StudentHumanNode" } },
        "edges": { "type": "array", "items": { "$ref": "#/$defs/StudentLineageEdge" } },
        "metrics": { "$ref": "#/$defs/GroupMetrics" },
        "warnings": { "$ref": "#/$defs/StudentWarnings" }
      }
    },
    "TeacherWindow": {
      "type": "object",
      "additionalProperties": false,
      "required": ["windowStartEventTime", "windowEndEventTime", "views"],
      "properties": {
        "windowStartEventTime": { "type": "string", "format": "date-time" },
        "windowEndEventTime": { "type": "string", "format": "date-time" },
        "views": {
          "type": "object",
          "additionalProperties": false,
          "required": ["observed", "human_only", "lineage_adjusted"],
          "properties": {
            "observed": { "$ref": "#/$defs/TeacherView" },
            "human_only": { "$ref": "#/$defs/HumanTeacherView" },
            "lineage_adjusted": { "$ref": "#/$defs/LineageTeacherView" }
          }
        }
      }
    },
    "StudentWindow": {
      "type": "object",
      "additionalProperties": false,
      "required": ["windowStartEventTime", "windowEndEventTime", "views"],
      "properties": {
        "windowStartEventTime": { "type": "string", "format": "date-time" },
        "windowEndEventTime": { "type": "string", "format": "date-time" },
        "views": {
          "type": "object",
          "additionalProperties": false,
          "required": ["observed", "human_only", "lineage_adjusted"],
          "properties": {
            "observed": { "$ref": "#/$defs/StudentView" },
            "human_only": { "$ref": "#/$defs/StudentHumanView" },
            "lineage_adjusted": { "$ref": "#/$defs/StudentLineageView" }
          }
        }
      }
    },
    "BaseBundle": {
      "type": "object",
      "required": [
        "schemaVersion", "roomId", "analysisEpoch", "algorithmVersion",
        "parameterHash", "projectionVersion", "baseVersion",
        "completeThroughRoomSeq", "watermarkEventTime", "requiresReplay",
        "evidenceStatus", "reviewStatus", "displayStatus", "warnings"
      ],
      "properties": {
        "schemaVersion": { "const": 1 },
        "roomId": { "type": "string", "format": "uuid" },
        "analysisEpoch": { "type": "string", "format": "uuid" },
        "algorithmVersion": { "type": "string", "minLength": 1, "maxLength": 160 },
        "parameterHash": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
        "projectionVersion": { "type": "integer", "minimum": 1 },
        "baseVersion": { "type": "integer", "minimum": 0 },
        "completeThroughRoomSeq": { "type": "integer", "minimum": 0 },
        "watermarkEventTime": { "type": "string", "format": "date-time" },
        "requiresReplay": { "type": "boolean" },
        "evidenceStatus": {
          "enum": ["active", "retracted", "superseded", "requires_replay"]
        },
        "reviewStatus": {
          "enum": ["unreviewed", "approved", "rejected", "corrected"]
        },
        "displayStatus": {
          "enum": ["hidden", "teacher_shadow", "student_aggregate"]
        },
        "warnings": { "type": "array", "items": { "type": "string" } }
      }
    },
    "TeacherBundle": {
      "allOf": [
        { "$ref": "#/$defs/BaseBundle" },
        {
          "type": "object",
          "required": ["projectionKey", "payload"],
          "properties": {
            "projectionKey": { "const": "trace.teacher_bundle" },
            "displayStatus": { "const": "teacher_shadow" },
            "payload": {
              "type": "object",
              "additionalProperties": false,
              "required": ["windows", "actorMapping"],
              "properties": {
                "windows": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["recent_10m", "session_45m"],
                  "properties": {
                    "recent_10m": { "$ref": "#/$defs/TeacherWindow" },
                    "session_45m": { "$ref": "#/$defs/TeacherWindow" }
                  }
                },
                "actorMapping": {
                  "type": "object",
                  "propertyNames": { "type": "string", "minLength": 1 },
                  "additionalProperties": {
                    "type": "object", "additionalProperties": false,
                    "required": ["actorId", "pseudonym", "kind"],
                    "properties": {
                      "actorId": { "type": "string", "format": "uuid" },
                      "pseudonym": { "enum": ["探索者 A", "探索者 B", "探索者 C", "探索者 D", "Nova Agent", "共學聊天室"] },
                      "kind": { "enum": ["learner", "agent", "room"] }
                    }
                  }
                }
              }
            }
          }
        }
      ],
      "unevaluatedProperties": false
    },
    "StudentBundle": {
      "allOf": [
        { "$ref": "#/$defs/BaseBundle" },
        {
          "type": "object",
          "required": ["projectionKey", "payload"],
          "properties": {
            "projectionKey": { "const": "trace.student_bundle" },
            "reviewStatus": { "const": "approved" },
            "displayStatus": { "const": "student_aggregate" },
            "warnings": { "$ref": "#/$defs/StudentWarnings" },
            "payload": {
              "type": "object",
              "additionalProperties": false,
              "required": ["windows", "interpretation"],
              "properties": {
                "windows": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["recent_10m", "session_45m"],
                  "properties": {
                    "recent_10m": { "$ref": "#/$defs/StudentWindow" },
                    "session_45m": { "$ref": "#/$defs/StudentWindow" }
                  }
                },
                "interpretation": { "const": "此圖呈現系統觀測到的近期互動事件，不等同友情、地位、能力、貢獻價值、學習成績、心理關係或 Agent 因果效果。" }
              }
            }
          }
        }
      ],
      "unevaluatedProperties": false
    }
  }
}
~~~

Generate <code>SnaProjectionBundle</code> only in <code>packages/contracts/src/generated/trace-projection.v1.ts</code>; <code>src/index.ts</code> may re-export it. Plan 05 imports that canonical module or the index re-export and does not define a local bundle type.

~~~python
from hashlib import sha256
from hmac import new as hmac_new
import json
from uuid import UUID, uuid5


TRACE_EDGE_NAMESPACE = UUID("7dd764bf-8848-5e96-8683-6f14bd1f7941")


def trace_wire_edge_id(room_id: str, edge: dict) -> str:
    name = json.dumps(
        [room_id, edge["edgeId"], edge["sourceId"],
         edge["targetId"], edge["layer"]],
        separators=(",", ":"),
    )
    return str(uuid5(TRACE_EDGE_NAMESPACE, name))


def normalize_reference_snapshot(
    snapshot: dict,
    room_id: str,
    actor_index: dict[str, dict],
    evidence_index: dict[str, dict],
) -> dict[str, dict]:
    observed = snapshot["views"]["observed"]
    nodes = [
        {"nodeId": node["nodeId"],
         "label": actor_index[node["nodeId"]]["label"],
         "kind": actor_index[node["nodeId"]]["kind"]}
        for node in observed["nodes"]
    ]
    edges = [{
        "edgeId": trace_wire_edge_id(room_id, edge),
        "sourceId": edge["sourceId"],
        "targetId": edge["targetId"],
        "layer": edge["layer"],
        "channels": dict(edge["channels"]),
        "weight": edge["weight"],
        "evidenceRefs": [dict(evidence_index[eid]) for eid in edge["evidenceIds"]],
    } for edge in observed["edges"]]
    human_ids = {node["nodeId"] for node in nodes if node["kind"] == "learner"}
    human_edges = [edge for edge in edges
                   if edge["sourceId"] in human_ids
                   and edge["targetId"] in human_ids]
    lineage_edges = [edge for edge in human_edges
                     if edge["layer"] == "uptake" and edge["evidenceRefs"]]
    return build_three_views_with_recomputed_metrics(
        observed_nodes=nodes,
        observed_edges=edges,
        human_ids=human_ids,
        human_edges=human_edges,
        lineage_edges=lineage_edges,
        source_warnings=snapshot.get("warnings", []),
    )


def scoped_node_id(
    room_pseudonym_key: bytes,
    room_id: str,
    analysis_epoch: str,
    internal_node_id: str,
) -> str:
    digest = hmac_new(
        room_pseudonym_key,
        (room_id + "\0" + analysis_epoch + "\0" + internal_node_id).encode("utf-8"),
        sha256,
    ).hexdigest()
    return "p-" + digest[:16]


STUDENT_METRICS = {
    "participationBalance": "participationBalance",
    "reciprocity": "weightedReciprocity",
    "agentShare": "agentShare",
    "semanticCoverage": "semanticCoverage",
}
STUDENT_EDGE_LAYERS = {"communication", "uptake"}
STUDENT_WARNINGS = {
    "small_group_interpretation_warning",
    "recent_group_interaction_only",
    "requires_replay",
    "insufficient_window",
}
TRACE_STUDENT_INTERPRETATION_ZH_HANT = (
    "此圖呈現系統觀測到的近期互動事件，不等同友情、地位、能力、"
    "貢獻價值、學習成績、心理關係或 Agent 因果效果。"
)


def validate_internal_views(internal_views: dict[str, dict]) -> None:
    expected = {"observed", "human_only", "lineage_adjusted"}
    if set(internal_views) != expected:
        raise ValueError("TRACE bundle requires exactly three views")
    human = internal_views["human_only"]
    human_ids = {node["nodeId"] for node in human["nodes"]}
    if any(node["kind"] != "learner" for node in human["nodes"]):
        raise ValueError("human_only contains Agent or ROOM")
    if any(
        edge["sourceId"] not in human_ids or edge["targetId"] not in human_ids
        for edge in human["edges"]
    ):
        raise ValueError("human_only edge leaves human node set")
    lineage = internal_views["lineage_adjusted"]
    lineage_ids = {node["nodeId"] for node in lineage["nodes"]}
    if any(node["kind"] != "learner" for node in lineage["nodes"]):
        raise ValueError("lineage_adjusted contains Agent or ROOM")
    if any(
        edge["layer"] != "uptake"
        or not edge.get("evidenceRefs")
        or edge["sourceId"] not in lineage_ids
        or edge["targetId"] not in lineage_ids
        for edge in lineage["edges"]
    ):
        raise ValueError("lineage_adjusted requires evidence-backed uptake")


def _project_trace_single(
    reference_snapshot: dict,
    window_name: str,
    metadata: dict,
    pseudonym_index: dict[str, dict],
    evidence_index: dict[str, dict],
    human_count: int,
) -> tuple[dict, dict]:
    common = {
        "schemaVersion": 1,
        "roomId": metadata["roomId"],
        "analysisEpoch": metadata["analysisEpoch"],
        "algorithmVersion": metadata["algorithmVersion"],
        "parameterHash": metadata["parameterHash"],
        "projectionVersion": metadata["projectionVersion"],
        "baseVersion": metadata["baseVersion"],
        "completeThroughRoomSeq": metadata["completeThroughRoomSeq"],
        "watermarkEventTime": metadata["watermarkEventTime"],
        "requiresReplay": metadata["requiresReplay"],
        "evidenceStatus": "requires_replay"
        if metadata["requiresReplay"] else "active",
    }
    actor_index = {
        key: {"label": value["pseudonym"], "kind": value["kind"]}
        for key, value in metadata["teacherActorMapping"].items()
    } | {
        "nova": {"label": "Nova Agent", "kind": "agent"},
        "ROOM": {"label": "共學聊天室", "kind": "room"},
    }
    internal_views = normalize_reference_snapshot(
        reference_snapshot, metadata["roomId"], actor_index, evidence_index
    )
    expected_views = {"observed", "human_only", "lineage_adjusted"}
    validate_internal_views(internal_views)
    teacher_views = {}
    student_views = {}
    for name in sorted(expected_views):
        internal = internal_views[name]
        group_metrics = {
            output: internal["metrics"][source]
            for output, source in STUDENT_METRICS.items()
        }
        teacher_views[name] = {
            "nodes": internal["nodes"],
            "edges": internal["edges"],
            "metrics": group_metrics,
            "warnings": list(internal["warnings"]),
        }
        warnings = [
            warning for warning in internal["warnings"]
            if warning in STUDENT_WARNINGS
        ]
        if window_name == "recent_10m" and "recent_group_interaction_only" not in warnings:
            warnings.append("recent_group_interaction_only")
        if human_count < 5:
            if "small_group_interpretation_warning" not in warnings:
                warnings.append("small_group_interpretation_warning")
        nodes = [
            dict(pseudonym_index[node["nodeId"]])
            for node in internal["nodes"]
            if node["nodeId"] in pseudonym_index
        ]
        edges = []
        for edge in internal["edges"]:
            if edge["layer"] not in STUDENT_EDGE_LAYERS:
                continue
            source = pseudonym_index.get(edge["sourceId"])
            target = pseudonym_index.get(edge["targetId"])
            if source is None or target is None:
                continue
            edges.append({
                "sourceNodeId": source["nodeId"],
                "targetNodeId": target["nodeId"],
                "layer": edge["layer"],
            })
        student_views[name] = {
            "nodes": nodes,
            "edges": edges,
            "metrics": group_metrics,
            "warnings": warnings,
        }
    teacher = {
        **common,
        "projectionKey": "trace.teacher_bundle",
        "reviewStatus": "unreviewed",
        "displayStatus": "teacher_shadow",
        "warnings": list(metadata["warnings"]),
        "payload": {
            "views": teacher_views,
            "actorMapping": dict(metadata["teacherActorMapping"]),
        },
    }
    student = {
        **common,
        "projectionKey": "trace.student_bundle",
        "reviewStatus": "approved",
        "displayStatus": "student_aggregate",
        "warnings": [
            warning for warning in metadata["warnings"]
            if warning in STUDENT_WARNINGS
        ] + (["small_group_interpretation_warning"] if human_count < 5 else []),
        "payload": {
            "views": student_views,
            "interpretation": TRACE_STUDENT_INTERPRETATION_ZH_HANT,
        },
    }
    return teacher, student


def project_trace(
    reference_snapshots: dict[str, dict],
    window_bounds: dict[str, dict],
    metadata: dict,
    pseudonym_index: dict[str, dict],
    evidence_index: dict[str, dict],
    human_count: int,
) -> tuple[dict, dict]:
    if set(reference_snapshots) != {"recent_10m", "session_45m"}:
        raise ValueError("TRACE requires both fixed windows")
    teacher_windows, student_windows = {}, {}
    teacher_bundle = student_bundle = None
    for window_name in ("recent_10m", "session_45m"):
        teacher, student = _project_trace_single(
            reference_snapshots[window_name], window_name, metadata,
            pseudonym_index, evidence_index, human_count,
        )
        bounds = window_bounds[window_name]
        window_base = {
            "windowStartEventTime": bounds["windowStartEventTime"],
            "windowEndEventTime": bounds["windowEndEventTime"],
        }
        teacher_windows[window_name] = {
            **window_base, "views": teacher["payload"]["views"]
        }
        student_windows[window_name] = {
            **window_base, "views": student["payload"]["views"]
        }
        teacher_bundle, student_bundle = teacher, student
    teacher_bundle["payload"] = {
        "windows": teacher_windows,
        "actorMapping": teacher_bundle["payload"]["actorMapping"],
    }
    student_bundle["payload"] = {
        "windows": student_windows,
        "interpretation": student_bundle["payload"]["interpretation"],
    }
    return teacher_bundle, student_bundle
~~~

For each projection version the Worker deterministically replays the pinned event records twice at the same watermark: `recent_10m` includes events with effective event time in `[watermark−600s, watermark]`, while `session_45m` includes `[room.starts_at, min(watermark, room.closes_at)]` and is capped by the fixed 2,700-second room. Late-event/watermark policy is identical in both; no browser filtering or timestamp inference occurs. Each replay produces an actual `StreamingInteractionNetwork.snapshot()` plus exact window bounds, then the same adapter creates `teacher_windows` and `student_windows`. Every golden/parity test starts from those two real reference snapshots; it never accepts a fixture pre-shaped with `evidenceRefs`, labels or wire IDs. Reference edges `{edgeId,sourceId,targetId,layer,channels,weight,evidenceIds}` are explicitly mapped: edge identity becomes room-scoped UUIDv5, all three non-negative accumulated channels and raw decayed weight are preserved for the teacher and may exceed 1, evidence IDs resolve through the immutable evidence index to either a text span or an `event_metadata` reference, and unknown IDs fail closed. Reference nodes are joined to the room actor/seat index. The adapter deliberately reconstructs `human_only` from observed learner nodes/incident edges, removing Agent and ROOM even if the reference virtual view retained a broadcast; it similarly derives evidence-backed human uptake for `lineage_adjusted` and recomputes the four safe group metrics separately in each window. Multi-event dyads, actor→ROOM broadcast, boundary-time events and media-only reply fixtures make these transformations observable.

The teacher and student branches are separate closed schemas, not one permissive view with optional identity fields. Teacher <code>actorMapping</code> contains only the room actor UUID, server-assigned seat pseudonym and structural kind; no legal name exists in this pilot. Student nodes allow exactly <code>nodeId/label/kind</code>; student edges allow exactly <code>sourceNodeId/targetNodeId/layer</code>; metrics allow exactly participation balance, reciprocity, Agent share and semantic coverage. Extra identity, evidence, channel, weight, strength, centrality, rank, risk, latent-trait or arbitrary warning fields fail schema validation. The student schema also fixes `payload.interpretation` to the exact `TRACE_STUDENT_INTERPRETATION_ZH_HANT` claim ceiling. `trace-interpretation.ts` exports that literal for the Web, and a contract test reads the schema `const` and asserts exact equality; the Python adapter test asserts its constant is byte-for-byte identical. Any shortened or translated substitute fails. Because one persisted student bundle serves the room, node IDs are HMAC-derived from a server key plus <code>roomId + analysisEpoch + actorId</code>, match <code>p-[a-f0-9]{16}</code>, rotate across rooms/epochs, and remain stable for all four clients reading that exact bundle. They are not session-personalized and never hash actor ID without the secret/scope.

Both schema and adapter enforce, independently inside `recent_10m` and `session_45m`, that <code>human_only</code> contains learner nodes and learner-to-learner edges only—Agent and <code>ROOM</code> are rejected rather than silently copied. <code>lineage_adjusted</code> contains only human-to-human uptake edges with at least one valid teacher-side <code>EvidenceRef</code>; the student adapter strips those refs after enforcing the invariant. Nova's observed move remains the separate teacher-side <code>facilitation</code> layer and is never relabeled as uptake.

- [ ] **Step 4: Generate contracts and run tests**

Run:

~~~bash
cd learning-orbit
pnpm --filter @learning-orbit/contracts generate
pnpm --filter @learning-orbit/contracts test -- analytics-contracts
cd services/worker
python3.12 -m unittest -v tests.unit.test_trace_adapter tests.unit.test_golden_directions
~~~

Expected: PASS; both real windowed reference snapshots map all edge channels/evidence, boundary events enter exactly the correct window, weights above 1 remain valid for teachers, reference human-only broadcast leakage is removed, four learners receive the Plan 01 classroom pseudonyms, and students receive only safe communication/uptake directions, four group metrics, the full immutable Traditional-Chinese interpretation sentence and <code>small_group_interpretation_warning</code> with no stable actor/evidence ID.

- [ ] **Step 5: Commit**

~~~bash
git add packages/contracts/schemas/trace-projection.v1.json packages/contracts/src/generated/trace-projection.v1.ts packages/contracts/src/generated/manifest.json packages/contracts/src/trace-interpretation.ts packages/contracts/src/index.ts packages/contracts/test/analytics-contracts.test.ts packages/test-fixtures/analytics/golden-trace-projections.json services/worker/src/learning_orbit_worker/generated/manifest.json services/worker/src/learning_orbit_worker/trace_adapter.py services/worker/tests/unit/test_trace_adapter.py
git commit -m "feat(analytics): add teacher TRACE and safe student aggregate"
~~~

### Task 9: Implement cursor, watermark, version and replay semantics

**Files:**
- Create: <code>learning-orbit/services/worker/src/learning_orbit_worker/projection_store.py</code>
- Create: <code>learning-orbit/services/worker/src/learning_orbit_worker/projector.py</code>
- Create: <code>learning-orbit/services/worker/src/learning_orbit_worker/replay.py</code>
- Create: <code>learning-orbit/services/worker/src/learning_orbit_worker/replay_jobs.py</code>
- Create: <code>learning-orbit/services/worker/tests/unit/test_projection_versions.py</code>
- Create: <code>learning-orbit/services/worker/tests/unit/test_replay_jobs.py</code>
- Create: <code>learning-orbit/services/worker/tests/integration/test_online_replay_parity.py</code>

- [ ] **Step 1: Write failing gap, late-event and parity tests**

~~~python
import unittest
from datetime import datetime, timezone

from learning_orbit_worker.echo_adapter import diff_echo_snapshots
from learning_orbit_worker.projector import (
    advance_watermark,
    make_semantic_noop_patch,
    next_patch_metadata,
    sequence_decision,
)

class ProjectionVersionTests(unittest.TestCase):
    def test_patch_is_exact_successor(self) -> None:
        self.assertEqual(
            next_patch_metadata(base_version=4),
            {"baseVersion": 4, "projectionVersion": 5},
        )

    def test_room_seq_gap_does_not_advance(self) -> None:
        self.assertEqual(sequence_decision(3, 1), "room_seq_gap")
        self.assertEqual(sequence_decision(2, 1), "next")
        self.assertEqual(sequence_decision(1, 1), "duplicate")

    def test_snapshot_diff_carries_resume_metadata(self) -> None:
        previous = {"payload": {"nodes": [], "edges": []}}
        current = {
            "payload": {
                "nodes": [{
                    "nodeId": "sun", "label": "太陽", "nodeKind": "concept",
                    "evidenceStatus": "supported", "reviewStatus": "unreviewed",
                    "displayStatus": "teacher_shadow",
                    "position": {"x": 0.1, "y": 0.2},
                }],
                "edges": [],
            }
        }
        patch = diff_echo_snapshots(
            previous,
            current,
            {
                "analysisEpoch": "00000000-0000-4000-8000-000000000901",
                "algorithmVersion": "echo-cm-reference-v1+adapter-v1",
                "parameterHash": "b" * 64,
                "projectionVersion": 5,
                "baseVersion": 4,
                "completeThroughRoomSeq": 8,
                "requiresReplay": False,
                "warnings": [],
                "reasonCodes": ["event_applied"],
            },
        )
        self.assertEqual(patch["baseVersion"], 4)
        self.assertEqual(patch["projectionVersion"], 5)
        self.assertEqual(patch["nodesAdded"][0]["nodeId"], "sun")
        self.assertEqual(patch["positionUpdates"][0]["x"], 0.1)

    def test_semantic_noop_still_advances_room_cursor(self) -> None:
        patch = make_semantic_noop_patch(
            event_type="room.paused",
            analysis_epoch="00000000-0000-4000-8000-000000000901",
            algorithm_version="echo-cm-reference-v1+adapter-v1",
            parameter_hash="b" * 64,
            base_version=4,
            room_seq=9,
        )
        self.assertEqual(patch["projectionVersion"], 5)
        self.assertEqual(patch["completeThroughRoomSeq"], 9)
        self.assertEqual(patch["nodesAdded"], [])
        self.assertEqual(patch["edgesAdded"], [])
        self.assertEqual(patch["changeScore"], 0.0)
        self.assertEqual(patch["reasonCodes"], ["semantic_noop:room.paused"])

    def test_late_event_does_not_pollute_head(self) -> None:
        utc = timezone.utc
        result = advance_watermark(
            datetime(2026, 8, 28, 9, 0, 0, tzinfo=utc),
            datetime(2026, 8, 28, 9, 0, 12, tzinfo=utc),
            datetime(2026, 8, 28, 9, 0, 10, tzinfo=utc),
            datetime(2026, 8, 28, 9, 0, 5, tzinfo=utc),
        )
        self.assertTrue(result.too_late)

    def test_future_client_time_is_clamped_before_reference_algorithms(self) -> None:
        result = project_future_then_normal_fixture()
        self.assertEqual(result.future_effective_time, result.future_ingest_time)
        self.assertIn("client_time_future_clamped", result.future_warnings)
        self.assertFalse(result.normal_event_marked_late)
        self.assertIn("normal-event", result.final_evidence_ids)
~~~

The integration test <code>test_online_replay_parity.py</code> performs the full late-event no-pollution assertion and compares semantic content hashes across distinct epochs. The projector computes `CursorDecision` first and passes `effective_event_time`—never raw client `eventTime`—to `to_chat_event` and therefore into both pinned algorithms. Raw event time remains only in the immutable RoomEvent audit. Online and replay clamp every future client time to its server `ingestTime`; a +1-day poisoning fixture immediately followed by a normal event proves the latter is not falsely late, the watermark does not jump past server progress, and online/replay semantic hashes match.

- [ ] **Step 2: Run and verify the red state**

Run:

~~~bash
cd learning-orbit/services/worker
python3.12 -m unittest -v tests.unit.test_projection_versions tests.unit.test_replay_jobs tests.integration.test_online_replay_parity
~~~

Expected: FAIL because projection storage and replay code are absent.

- [ ] **Step 3: Implement the bounded event-time policy and transactional head update**

~~~python
from dataclasses import dataclass
from datetime import datetime, timedelta

ALLOWED_LATENESS = timedelta(seconds=5)
FUTURE_CLOCK_WARNING = timedelta(seconds=30)


@dataclass(frozen=True)
class CursorDecision:
    effective_event_time: datetime
    max_seen_event_time: datetime
    watermark_event_time: datetime
    too_late: bool
    warnings: tuple[str, ...]


def advance_watermark(
    event_time: datetime,
    ingest_time: datetime,
    previous_max_seen: datetime,
    previous_watermark: datetime,
) -> CursorDecision:
    # Client clocks may order past events, but never advance event-time authority
    # beyond the server's durable ingest timestamp.
    effective = min(event_time, ingest_time)
    max_seen = max(previous_max_seen, effective)
    watermark = max(previous_watermark, max_seen - ALLOWED_LATENESS)
    return CursorDecision(
        effective,
        max_seen,
        watermark,
        effective < previous_watermark,
        ("client_time_future_clamped",)
        if event_time - ingest_time > FUTURE_CLOCK_WARNING else (),
    )


def next_patch_metadata(base_version: int) -> dict[str, int]:
    if base_version < 0:
        raise ValueError("base_version must be non-negative")
    return {"baseVersion": base_version, "projectionVersion": base_version + 1}


def sequence_decision(room_seq: int, complete_through_seq: int) -> str:
    if room_seq <= complete_through_seq:
        return "duplicate"
    if room_seq == complete_through_seq + 1:
        return "next"
    return "room_seq_gap"


def make_semantic_noop_patch(
    event_type: str,
    analysis_epoch: str,
    algorithm_version: str,
    parameter_hash: str,
    base_version: int,
    room_seq: int,
) -> dict:
    return {
        "analysisEpoch": analysis_epoch,
        "algorithmVersion": algorithm_version,
        "parameterHash": parameter_hash,
        "projectionVersion": base_version + 1,
        "baseVersion": base_version,
        "completeThroughRoomSeq": room_seq,
        "requiresReplay": False,
        "warnings": [],
        "nodesAdded": [], "nodesUpdated": [], "nodesHidden": [],
        "edgesAdded": [], "edgesUpdated": [], "edgesHidden": [],
        "positionUpdates": [], "changeScore": 0.0,
        "reasonCodes": ["semantic_noop:" + event_type],
        "evidenceRefs": [],
    }
~~~

`replay_jobs.py` is the one enqueue authority shared by late-event handling, review/correction consumption and Plan 04 multimodal artifacts:

~~~python
from hashlib import sha256


REPLAY_REASONS = frozenset({
    "late_event", "artifact_available", "analytics_review", "operator_rebuild",
})
REPLAY_JOB_NAMESPACE = UUID("00000000-0000-5000-8000-000000000033")


def enqueue_analytics_replay(
    tx,
    *,
    room_id: str,
    source_event_id: str | None,
    requested_through_room_seq: int,
    reason: str,
    dedupe_token: str,
    correlation_id: str,
) -> None:
    if reason not in REPLAY_REASONS or requested_through_room_seq < 0:
        raise DeterministicContractError("INVALID_REPLAY_REQUEST")
    dedupe_hash = sha256(
        f"{room_id}\0{reason}\0{dedupe_token}".encode("utf-8")
    ).hexdigest()
    dedupe_key = "analytics.replay-room.v1:" + dedupe_hash
    job_id = str(uuid5(REPLAY_JOB_NAMESPACE, dedupe_key))
    tx.execute(
        "insert into worker_job "
        "(job_id,job_type,room_id,source_event_id,dedupe_key,payload,correlation_id,"
        "analytics_order_seq,analytics_order_kind,status) "
        "values (%s,'analytics.replay-room.v1',%s,%s,%s,%s,%s,%s,1,'queued') "
        "on conflict (dedupe_key) do nothing",
        (
            job_id,
            room_id,
            source_event_id,
            dedupe_key,
            {"reason": reason,
             "requestedThroughRoomSeq": requested_through_room_seq},
            correlation_id,
            requested_through_room_seq,
        ),
    )
    tx.execute(
        "insert into analytics_replay_request "
        "(job_id,room_id,source_event_id,reason,requested_through_room_seq,"
        "dedupe_key,correlation_id) values (%s,%s,%s,%s,%s,%s,%s) "
        "on conflict (job_id) do nothing",
        (job_id, room_id, source_event_id, reason,
         requested_through_room_seq, dedupe_key, correlation_id),
    )
~~~

The helper accepts the cause token only for the SHA-256 dedupe key; it never puts artifact IDs into payload. It derives a deterministic job UUID, inserts job plus immutable `analytics_replay_request` authority in one transaction, and idempotent retries reproduce both identities. Tests assert exact payload, order tuple, non-null correlation, job/authority equality, no cause collisions and DB rejection of partial order columns.

Within one transaction:

1. Execute Plan 01's canonical `lock_room_xact.sql` (never a local hash/advisory query), then lock `classroom_room` and insert any missing <code>analysis_room_heads</code> row at version 0.
2. Lock it:

~~~sql
select *
from analysis_room_heads
where room_id=%s and projection_key=%s
for update;
~~~

3. Reload the canonical <code>room_event</code> by <code>source_event_id</code>, verify job <code>roomId/roomSeq/eventType</code> against it, and require <code>room_seq = complete_through_seq + 1</code>. Larger is retryable; equal or lower is idempotent success.
4. Run optional direct-text derivation only when the event contains learner-authored message text. Media-only, lifecycle, system, retraction and review facts produce no fabricated text artifact, but remain consumed events.
5. Apply the event to all four projection keys in one transaction. Semantic changes write a new immutable snapshot for every key; ECHO also writes a validated incremental patch. Semantic no-op events write identical-content snapshots with advanced metadata, an empty ECHO delta carrying <code>semantic_noop:{eventType}</code>, and new TRACE teacher/student bundle snapshots so all heads expose the same <code>completeThroughRoomSeq</code>. TRACE never emits a partial-view patch.
6. A too-late event leaves semantic payload/hash unchanged but still advances all four <code>complete_through_seq</code> values, writes no-op transition metadata with <code>requiresReplay=true</code>, and calls `enqueue_analytics_replay(..., reason="late_event", requested_through_room_seq=roomSeq, dedupe_token=eventId, correlation_id=event.correlationId)`. The helper alone writes the closed payload, non-null order tuple and deterministic dedupe key.
7. Snapshot, optional ECHO patch, four head rows, <code>analysis_consumer_checkpoints</code> and dedicated projection pointers commit atomically. Only after that transaction commits may the consume job succeed. Any key failure rolls back every head and checkpoint, so room/media/system events cannot create hidden gaps.
8. Wire <code>projectionVersion = baseVersion + 1</code>. Stored snapshot/patch/head metadata must share <code>algorithmVersion</code> and <code>parameterHash</code>; a parameter change starts a new epoch. Semantic content hash excludes epoch, projection versions, timestamps and DB IDs but includes algorithm version, parameter hash and semantic payload.
9. Replay treats payload `requestedThroughRoomSeq` as a minimum trigger cursor, not permission to roll the room back. If the current checkpoint is below it, the job is retryable; otherwise replay captures the current checkpoint plus all four head `(epoch,version,completeThrough)` tuples and rebuilds through that captured current cursor. It reads every stored <code>room_event</code>—including semantic no-ops—in <code>room_seq</code> order and never calls a model. It computes a new epoch outside the write transaction, then executes Plan 01's canonical `lock_room_xact.sql`, locks the room/head rows in the global order, locks the exact Worker job last, and performs a compare-and-swap. If any checkpoint/head advanced, replay discards its candidate and retries with the new current target; it can never swap a lower cursor or older base over newer work. A successful atomic swap updates both ECHO projections plus both windowed TRACE bundles only when all four keys reach the same final sequence. Tests insert an artifact replay barrier behind an already-completed consume, block/release replay around a later consume, crash before/after CAS, and prove head/checkpoint monotonicity, one visible epoch, online/replay parity and no rollback.

- [ ] **Step 4: Run tests twice**

Run:

~~~bash
cd learning-orbit/services/worker
python3.12 -m unittest -v tests.unit.test_projection_versions tests.unit.test_replay_jobs tests.integration.test_online_replay_parity
python3.12 -m unittest -v tests.unit.test_projection_versions tests.unit.test_replay_jobs tests.integration.test_online_replay_parity
~~~

Expected: both runs PASS; semantic hashes match, epochs differ, every RoomEvent advances the shared complete-through cursor, and no duplicate patches or hidden sequence gaps appear.

- [ ] **Step 5: Commit**

~~~bash
git add services/worker/src/learning_orbit_worker/projection_store.py services/worker/src/learning_orbit_worker/projector.py services/worker/src/learning_orbit_worker/replay.py services/worker/src/learning_orbit_worker/replay_jobs.py services/worker/tests/unit/test_projection_versions.py services/worker/tests/unit/test_replay_jobs.py services/worker/tests/integration/test_online_replay_parity.py
git commit -m "feat(analytics): add versioned projections and deterministic replay"
~~~

### Task 10: Persist patches and implement snapshot resync

**Files:**
- Create: <code>learning-orbit/apps/server/src/modules/analytics/analytics-repository.ts</code>
- Create: <code>learning-orbit/apps/server/src/modules/analytics/analytics-policy.ts</code>
- Create: <code>learning-orbit/apps/server/src/modules/analytics/analytics-room-access-port.ts</code>
- Create: <code>learning-orbit/apps/server/src/modules/analytics/projection-outbox-repository.ts</code>
- Modify: <code>learning-orbit/packages/contracts/schemas/echo-concept-projection.v1.json</code>
- Modify: <code>learning-orbit/packages/contracts/schemas/realtime-frame.v1.json</code>
- Generate: <code>learning-orbit/packages/contracts/src/generated/{echo-concept-projection.v1,realtime-frame.v1}.ts</code>
- Modify: <code>learning-orbit/packages/contracts/src/generated/manifest.json</code>
- Modify: <code>learning-orbit/services/worker/src/learning_orbit_worker/generated/manifest.json</code>
- Modify: <code>learning-orbit/apps/server/src/routes.ts</code>
- Modify: <code>learning-orbit/apps/server/src/realtime.ts</code>
- Create: <code>learning-orbit/apps/server/test/analytics/snapshot-resync.test.ts</code>
- Create: <code>learning-orbit/apps/server/test/analytics/analytics-authorization.test.ts</code>
- Create: <code>learning-orbit/apps/server/test/analytics/projection-outbox.test.ts</code>

- [ ] **Step 1: Write failing resync and role tests**

~~~typescript
test("epoch mismatch requires snapshot resync", async () => {
  const response = await server.inject({
    method: "GET",
    url: "/v1/rooms/00000000-0000-4000-8000-000000000010/analytics/trace.teacher_bundle/patches" +
      "?analysisEpoch=00000000-0000-4000-8000-000000000999&afterProjectionVersion=4",
    headers: teacherHeaders
  });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({
    code: "SNAPSHOT_RESYNC_REQUIRED",
    snapshotUrl: "/v1/rooms/00000000-0000-4000-8000-000000000010/analytics/trace.teacher_bundle/latest"
  });
});

test("student cannot read a teacher projection", async () => {
  const response = await server.inject({
    method: "GET",
    url: "/v1/rooms/00000000-0000-4000-8000-000000000010/analytics/trace.teacher_bundle/latest",
    headers: studentHeaders
  });
  expect(response.statusCode).toBe(403);
});

test.each(["latest", "patches", "timeline"])(
  "%s applies the same room-scoped analytics guard",
  async (surface) => {
    expect((await requestAnalyticsSurface(surface, crossRoomTeacherHeaders)).statusCode)
      .toBe(404);
    expect((await requestAnalyticsSurface(surface, expiredTeacherHeaders)).statusCode)
      .toBe(401);
    expect((await requestAnalyticsSurface(surface, expiredRoomTeacherHeaders)).statusCode)
      .toBe(410);
    expect((await requestAnalyticsSurface(surface, deletingRoomTeacherHeaders)).statusCode)
      .toBe(410);
  }
);

test("projection frame is filtered by current room grant", async () => {
  const own = await connectSocket(activeStudentRoomA);
  const crossRoom = await connectSocket(activeStudentRoomB);
  const expired = await connectSocket(expiredStudentRoomA);
  const expiredRoom = await connectSocket(activeStudentExpiredRoomA);
  const deleting = await connectSocket(activeStudentDeletingRoomA);
  await publishProjectionPointer(pointerForRoomA);
  expect(own.frames("projection")).toHaveLength(1);
  expect(crossRoom.frames("projection")).toHaveLength(0);
  expect(expired.closeCode).toBe(4401);
  expect(expiredRoom.closeCode).toBe(4410);
  expect(deleting.closeCode).toBe(4410);
});

test("student projection stays inaccessible before signed promotion", async () => {
  expect((await student.get(echoStudentLatestUrl)).status).toBe(403);
  expect((await student.get(traceStudentLatestUrl)).body.code)
    .toBe("STUDENT_ANALYTICS_NOT_PROMOTED");
  await publishProjectionPointer(studentPointer);
  expect(studentSocket.frames("projection")).toHaveLength(0);
});

test("student promotion is enforced independently for each projection key", async () => {
  await promoteStudentKeys(roomId, ["echo.student_approved"]);
  expect((await student.get(echoStudentLatestUrl)).status).toBe(200);
  expect((await student.get(traceStudentLatestUrl)).body.code)
    .toBe("STUDENT_ANALYTICS_NOT_PROMOTED");
  await publishProjectionPointer(traceStudentPointer);
  expect(studentSocket.frames("projection")).toHaveLength(0);
  await publishProjectionPointer(echoStudentPointer);
  expect(studentSocket.frames("projection")).toHaveLength(1);
});

test("patch endpoint rejects a corrupt middle or truncated chain", async () => {
  await seedEchoPatches([
    patch({ baseVersion: 4, projectionVersion: 5 }),
    patch({ baseVersion: 99, projectionVersion: 100 }),
    patch({ baseVersion: 6, projectionVersion: 7 })
  ]);
  const corrupt = await teacher.get(echoPatchesUrl({ afterProjectionVersion: 4 }));
  expect(corrupt.status).toBe(409);
  expect(corrupt.body.code).toBe("SNAPSHOT_RESYNC_REQUIRED");
  await replaceMiddleWithSchemaValidPatch({ baseVersion: 5, projectionVersion: 6 });
  await deletePatchVersion(7);
  const truncated = await teacher.get(echoPatchesUrl({ afterProjectionVersion: 4 }));
  expect(truncated.status).toBe(409);
});

test("projection commit uses only the dedicated projection outbox", async () => {
  await commitProjection(testProjection);
  expect(await countRows("analysis_projection_outbox")).toBe(1);
  expect(await countRows("room_event")).toBe(0);
  expect(await countRows("outbox_event")).toBe(0);
});
~~~

- [ ] **Step 2: Run and verify 404**

Run: <code>cd learning-orbit &amp;&amp; pnpm --filter @learning-orbit/server test -- snapshot-resync analytics-authorization</code>

Expected: FAIL because analytics routes are not registered.

- [ ] **Step 3: Implement fail-closed policy and repository**

~~~typescript
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import echoConceptSchema
  from "@learning-orbit/contracts/schemas/echo-concept-projection.v1.json"
  with { type: "json" };
import type { ConceptMapPatch }
  from "@learning-orbit/contracts";

const patchAjv = new Ajv2020({ allErrors: true, strict: true, strictNumbers: true });
addFormats(patchAjv);
const validateConceptMapPatch = patchAjv.compile({
  $schema: echoConceptSchema.$schema,
  $id: "https://learning-orbit.local/runtime/concept-map-patch.v1.json",
  $defs: echoConceptSchema.$defs,
  ...echoConceptSchema.$defs.ConceptMapPatch
});

function parseConceptMapPatch(value: unknown): ConceptMapPatch | null {
  return validateConceptMapPatch(value) ? value as ConceptMapPatch : null;
}

export const STUDENT_PROJECTIONS = new Set([
  "trace.student_bundle",
  "echo.student_approved"
]);

type AnalyticsCapability =
  | "student_read" | "teacher_read" | "teacher_write" | "projection_frame";

export async function requireRoomAnalyticsAccess(
  context: RequestContext,
  roomId: string,
  capability: AnalyticsCapability
): Promise<{ role: "student" | "teacher"; roomId: string; studentProjectionAllowlist: ReadonlySet<string> }> {
  const principal = await context.auth.requireCurrentSession(context.now);
  if (principal.kind !== "student" && principal.kind !== "teacher") {
    throw httpError(403, "ANALYTICS_ROLE_NOT_APPROVED");
  }
  const grant = await context.roomAccess.findAnalyticsGrant(principal, roomId);
  if (grant === null) {
    throw httpError(404, "ROOM_NOT_FOUND");
  }
  if (grant.deletionState !== "none") {
    throw httpError(410, "ROOM_DELETION_IN_PROGRESS");
  }
  if (grant.retentionState === "expired") {
    throw httpError(410, "ROOM_RETENTION_EXPIRED");
  }
  if (
    (capability === "teacher_read" || capability === "teacher_write")
    && principal.kind !== "teacher"
  ) {
    throw httpError(403, "ANALYTICS_TEACHER_ONLY");
  }
  return { role: principal.kind, roomId: grant.roomId,
    studentProjectionAllowlist: new Set(grant.studentProjectionAllowlist) };
}

export function assertProjectionAccess(
  grant: { role: "student" | "teacher"; studentProjectionAllowlist: ReadonlySet<string> },
  projectionKey: string
): void {
  if (grant.role === "student" && !STUDENT_PROJECTIONS.has(projectionKey)) {
    throw httpError(403, "PROJECTION_FORBIDDEN");
  }
  if (grant.role === "student" && !grant.studentProjectionAllowlist.has(projectionKey)) {
    throw httpError(403, "STUDENT_ANALYTICS_NOT_PROMOTED");
  }
}

export async function latestSnapshot(
  db: DbClient,
  roomId: string,
  projectionKey: string
) {
  return db.oneOrNone(
    "select s.payload from analysis_projection_snapshots s " +
    "join analysis_room_heads h on h.snapshot_id=s.snapshot_id " +
    "where h.room_id=$1 and h.projection_key=$2",
    [roomId, projectionKey]
  );
}

export async function patchesAfter(
  db: DbClient,
  roomId: string,
  projectionKey: string,
  epoch: string,
  afterProjectionVersion: number
) {
  const head = await db.one(
    "select analysis_epoch,version,algorithm_version,parameter_hash " +
    "from analysis_room_heads " +
    "where room_id=$1 and projection_key=$2",
    [roomId, projectionKey]
  );
  if (head.analysis_epoch !== epoch || afterProjectionVersion > head.version) {
    return { kind: "resync" as const };
  }
  if (projectionKey.startsWith("trace.") && afterProjectionVersion < head.version) {
    return { kind: "resync" as const };
  }
  const rows = await db.any(
    "select payload from analysis_projection_patches " +
    "where room_id=$1 and projection_key=$2 and analysis_epoch=$3 " +
    "and version>$4 and version<=$5 order by version limit 201",
    [roomId, projectionKey, epoch, afterProjectionVersion, head.version]
  );
  if (rows.length > 200) {
    return { kind: "resync" as const };
  }
  let expectedBase = afterProjectionVersion;
  const patches = [];
  for (const row of rows) {
    const patch = parseConceptMapPatch(row.payload);
    if (
      patch === null
      || patch.analysisEpoch !== epoch
      || patch.algorithmVersion !== head.algorithm_version
      || patch.parameterHash !== head.parameter_hash
      || patch.baseVersion !== expectedBase
      || patch.projectionVersion !== expectedBase + 1
    ) return { kind: "resync" as const };
    patches.push(patch);
    expectedBase = patch.projectionVersion;
  }
  if (expectedBase !== head.version) {
    return { kind: "resync" as const };
  }
  return { kind: "patches" as const, patches };
}
~~~

`RoomAnalyticsAccessPort` is an explicit composition boundary. Before Plan 06, only a `NODE_ENV=test`/`PILOT_ADMISSION_DISABLED=1` adapter may synthesize deletion/retention/promotion states for the tests above; non-test startup with that adapter fails. The pre-governance server can run teacher-only synthetic Gate 3 fixtures, but it cannot claim pilot authorization or expose student projections. Plan 06 Task 3 supplies the sole durable adapter backed by current sessions, room membership, deletion tombstone, immutable retention policy and signed per-key student promotion, then reruns these same route/frame tests. Thus the deleting/expired/promoted fixtures here validate fail-closed policy semantics without pretending migrations 005/006 already exist.

<code>requireCurrentSession</code> rejects expired or revoked sessions with 401. <code>findAnalyticsGrant</code> returns a row only for the owning teacher or an active <code>room_member</code> in the requested room, and folds the Plan 06 retention/deletion/promotion adapters into <code>retentionState/deletionState/studentProjectionAllowlist</code>; expired retention and deletion-in-progress both return 410. Until Plan 06 installs and validates a live promotion record, the promotion adapter returns an empty set—never both keys by implication. Each HTTP read and each WebSocket projection send checks the exact requested key, so promotion of ECHO cannot expose TRACE and promotion of TRACE cannot expose ECHO. A missing grant deliberately produces the same 404 for a nonexistent room and another teacher's room. Only the Plan 01 <code>student | teacher</code> principal union is accepted; no third-role type, branch or bypass exists in this phase. All latest, patch, timeline, review and artifact handlers call this guard before parsing projection IDs, cursors or bodies. Gate 3 may inject an explicitly named synthetic promoted-policy port only inside tests; it is not production configuration.

The patch endpoint returns patches only when the entire requested-to-head chain is present and every row passes the generated <code>ConceptMapPatch</code> validator plus epoch, algorithm, parameter, base and successor checks. A corrupt first, middle or final patch, duplicate/gap, chain over 200, truncated chain, epoch/version mismatch, or TRACE bundle request returns 409 with the latest snapshot URL; no valid prefix is returned.

Register exact endpoints in <code>src/routes.ts</code>:

- <code>GET /v1/rooms/:roomId/analytics/:projectionKey/latest</code>
- <code>GET /v1/rooms/:roomId/analytics/:projectionKey/patches</code>
- <code>GET /v1/rooms/:roomId/analytics/:projectionKey/timeline</code> for ECHO keys only

Extend the ECHO schema with closed generated `ConceptTimelineQuery {analysisEpoch,limit}` and `ConceptTimelineWindow {schemaVersion,projectionKey,analysisEpoch,baseSnapshot,patches,truncatedBeforeVersion,headVersion}`. Freeze the canonical builders as `routes.analytics.latest(roomId, projectionKey)`, `routes.analytics.patches(roomId, projectionKey, {analysisEpoch,afterProjectionVersion})`, and `routes.analytics.timeline(roomId, echoProjectionKey, {analysisEpoch,limit})`; each uses `encodeURIComponent`, a deterministic query order, exact UUID/integer bounds, and accepts no extra query fields. `echoProjectionKey` is generated/narrowed to `echo.student_approved | echo.teacher_shadow`; TRACE timeline calls fail before fetch. The endpoint validates `limit` in 1–200, loads the newest contiguous suffix ending at the head, and returns the immediately preceding persisted snapshot as `baseSnapshot`; every patch is schema/epoch/algorithm/parameter/base/version validated and the final version must equal `headVersion`. When older changes exist, `truncatedBeforeVersion` is the first omitted version; otherwise it is null. Corruption yields 409 latest-snapshot resync, never a partial window. Route tests assert exact URL strings, encoding, deterministic query order and rejection of zero/201 limits, invalid epochs and TRACE keys. Refresh, epoch replacement and new-device tests reconstruct every cursor in the returned window and verify future hides do not alter earlier frames.

Extend <code>realtime-frame.v1.json</code> with a separate projection frame:

~~~json
{
  "type": "projection",
  "roomId": "00000000-0000-4000-8000-000000000010",
  "projectionKey": "trace.student_bundle",
  "analysisEpoch": "00000000-0000-4000-8000-000000000901",
  "projectionVersion": 5,
  "completeThroughRoomSeq": 12,
  "snapshotUrl": "/v1/rooms/00000000-0000-4000-8000-000000000010/analytics/trace.student_bundle/latest"
}
~~~

Add that object as a closed <code>oneOf</code> branch in <code>realtime-frame.v1.json</code> with all seven fields required:

~~~json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "type", "roomId", "projectionKey", "analysisEpoch",
    "projectionVersion", "completeThroughRoomSeq", "snapshotUrl"
  ],
  "properties": {
    "type": { "const": "projection" },
    "roomId": { "type": "string", "format": "uuid" },
    "projectionKey": {
      "enum": [
        "echo.teacher_shadow", "echo.student_approved",
        "trace.teacher_bundle", "trace.student_bundle"
      ]
    },
    "analysisEpoch": { "type": "string", "format": "uuid" },
    "projectionVersion": { "type": "integer", "minimum": 1 },
    "completeThroughRoomSeq": { "type": "integer", "minimum": 0 },
    "snapshotUrl": { "type": "string", "pattern": "^/v1/rooms/" }
  }
}
~~~

The server claims durable pointers with:

~~~sql
with picked as (
  select projection_outbox_id
  from analysis_projection_outbox
  where published_at is null
    and available_at<=now()
    and (locked_at is null or locked_at<now()-interval '30 seconds')
  order by projection_outbox_id
  for update skip locked
  limit $1
)
update analysis_projection_outbox p
set locked_at=now(),locked_by=$2,publish_attempts=p.publish_attempts+1
from picked
where p.projection_outbox_id=picked.projection_outbox_id
returning p.*;
~~~

<code>src/realtime.ts</code> serializes those rows directly as <code>projection</code> frames. Before each socket send it reruns <code>requireRoomAnalyticsAccess(...,"projection_frame")</code> against current session expiry, membership and deletion state, then applies <code>assertProjectionAccess</code>; unauthorized sockets receive no frame and expired/deleting sockets close with 4401/4410. The publisher may mark a durable pointer published after evaluating all current sockets because reconnects recover from the authorized snapshot endpoint. It never creates <code>RoomEventEnvelope</code>, <code>room_event</code>, or Plan 01 <code>outbox_event</code>.

- [ ] **Step 4: Run route, authorization and realtime tests**

Run: <code>cd learning-orbit &amp;&amp; pnpm contracts:generate &amp;&amp; pnpm test:contracts &amp;&amp; pnpm --filter @learning-orbit/server test -- snapshot-resync analytics-authorization projection-outbox realtime</code>

Expected: PASS; changed schema hashes and both manifests are regenerated, the full patch chain is validated or returns 409, cross-room access returns 404, expired/deleting access is denied, projection commits create one dedicated outbox row and zero room-ledger rows, students receive only authorized projection frames, and every frame validates against the shared schema.

- [ ] **Step 5: Commit**

~~~bash
git add packages/contracts services/worker/src/learning_orbit_worker/generated/manifest.json apps/server/src/modules/analytics apps/server/src/routes.ts apps/server/src/realtime.ts apps/server/test/analytics
git commit -m "feat(server): add analytics snapshot resync and role gates"
~~~

### Task 11: Add the teacher artifact queue, shadow review and immutable correction events

**Files:**
- Create: <code>learning-orbit/packages/contracts/schemas/derived-text-artifact-page.v1.json</code>
- Generate: <code>learning-orbit/packages/contracts/src/generated/derived-text-artifact-page.v1.ts</code>
- Create: <code>learning-orbit/packages/contracts/schemas/analytics-review-command.v1.json</code>
- Create: <code>learning-orbit/packages/contracts/schemas/analytics-review-room-event-payloads.v1.json</code>
- Generate: <code>learning-orbit/packages/contracts/src/generated/analytics-review-command.v1.ts</code>
- Generate: <code>learning-orbit/packages/contracts/src/generated/analytics-review-room-event-payloads.v1.ts</code>
- Modify: <code>learning-orbit/packages/contracts/src/generated/manifest.json</code>
- Modify: <code>learning-orbit/services/worker/src/learning_orbit_worker/generated/manifest.json</code>
- Modify: <code>learning-orbit/packages/contracts/test/analytics-contracts.test.ts</code>
- Modify: <code>learning-orbit/packages/contracts/src/routes.ts</code>
- Modify: <code>learning-orbit/apps/server/src/modules/analytics/analytics-repository.ts</code>
- Create: <code>learning-orbit/apps/server/src/modules/analytics/register-analytics-review-event-payloads.ts</code>
- Modify: <code>learning-orbit/apps/server/src/app.ts</code>
- Modify: <code>learning-orbit/apps/server/src/routes.ts</code>
- Modify: <code>learning-orbit/apps/server/src/modules/rooms/room-event-repository.ts</code>
- Create: <code>learning-orbit/services/worker/src/learning_orbit_worker/analytics_handlers.py</code>
- Create: <code>learning-orbit/services/worker/tests/integration/test_review_correction.py</code>
- Create: <code>learning-orbit/apps/server/test/analytics/review-correction-routes.test.ts</code>
- Create: <code>learning-orbit/apps/server/test/analytics/event-payload-registration.test.ts</code>
- Create: <code>learning-orbit/apps/server/test/analytics/artifact-review-queue.test.ts</code>

- [ ] **Step 1: Write failing permission and replay tests**

~~~typescript
const validApproval = {
  targetType: "evidence",
  targetId: "00000000-0000-4000-8000-000000000701",
  decision: "approve",
  rationale: "Teacher checked the quoted source span.",
  expectedAnalysisEpoch: "00000000-0000-4000-8000-000000000901",
  expectedProjectionVersion: 4
};

const validCorrection = {
  targetArtifactId: "00000000-0000-4000-8000-000000000301",
  correctionKind: "replace_text",
  replacement: {
    text: "分解者把物質轉成可回到土壤的養分。",
    languageTag: "zh-Hant"
  },
  reason: "Learner corrected the transcript and teacher verified it.",
  expectedAnalysisEpoch: "00000000-0000-4000-8000-000000000901",
  expectedProjectionVersion: 4
};

const correctionCases = [
  validCorrection,
  {
    correctionKind: "replace_evidence_span",
    targetProjectionEdgeId: "e9d17530-a4bb-5717-9d50-11ba588f51f1",
    target: {
      eventId: "00000000-0000-4000-8000-000000000101", start: 0, end: 9
    },
    replacement: {
      eventId: "00000000-0000-4000-8000-000000000101", start: 0, end: 12
    },
    reason: "Teacher corrected the quoted span.",
    expectedAnalysisEpoch: "00000000-0000-4000-8000-000000000901",
    expectedProjectionVersion: 4
  },
  {
    correctionKind: "replace_relation",
    targetProjectionEdgeId: "e9d17530-a4bb-5717-9d50-11ba588f51f1",
    replacement: {
      head: "sun", predicate: "provides energy to",
      tail: "producers", relationFamily: "energy_flow"
    },
    reason: "Teacher corrected the extracted relation.",
    expectedAnalysisEpoch: "00000000-0000-4000-8000-000000000901",
    expectedProjectionVersion: 4
  },
  {
    correctionKind: "merge_alias",
    targetCanonicalNodeId: "producers",
    replacement: { aliasNodeId: "plants" },
    reason: "Teacher verified both labels denote the same classroom concept.",
    expectedAnalysisEpoch: "00000000-0000-4000-8000-000000000901",
    expectedProjectionVersion: 4
  },
  {
    correctionKind: "split_alias",
    targetCanonicalNodeId: "decomposer",
    replacement: {
      aliasNodeId: "soil_nutrients",
      newCanonicalNodeId: "soil_nutrients_v2",
      newLabel: "土壤養分"
    },
    reason: "Teacher separated two classroom concepts.",
    expectedAnalysisEpoch: "00000000-0000-4000-8000-000000000901",
    expectedProjectionVersion: 4
  },
  {
    correctionKind: "undo_merge",
    targetCorrectionEventId: "00000000-0000-4000-8000-000000000721",
    replacement: {},
    reason: "Teacher reversed the cited merge correction.",
    expectedAnalysisEpoch: "00000000-0000-4000-8000-000000000901",
    expectedProjectionVersion: 4
  },
  {
    correctionKind: "retract",
    targetType: "projection",
    targetId: "e9d17530-a4bb-5717-9d50-11ba588f51f1",
    replacement: {},
    reason: "Teacher retracted unsupported output.",
    expectedAnalysisEpoch: "00000000-0000-4000-8000-000000000901",
    expectedProjectionVersion: 4
  }
] as const;

function makeAnalyticsReviewAppend() {
  return {
    eventId: "00000000-0000-4000-8000-000000000711",
    roomId: "00000000-0000-4000-8000-000000000010",
    type: "analytics.review.recorded.v1",
    actorId: "00000000-0000-4000-8000-000000000001",
    actorKind: "human",
    actorRole: "teacher",
    revision: 1,
    operation: "add",
    eventTime: "2026-08-28T09:20:00Z",
    causationId: "00000000-0000-4000-8000-000000000712",
    correlationId: "00000000-0000-4000-8000-000000000713",
    payload: { changeKind: "review" }
  };
}

const ROOM_A = "00000000-0000-4000-8000-000000000010";
const ROOM_B = "00000000-0000-4000-8000-000000000020";

function artifact(artifactId: string, roomId: string, time: string) {
  const roomSeq = Number(artifactId.slice(-3)) - 300;
  return {
    schemaVersion: 1,
    artifactId,
    roomId,
    eventId: artifactId,
    roomSeq,
    sourceMediaId: null,
    sourceModality: "text",
    derivation: "direct",
    text: "太陽提供能量給生產者。",
    normalizedTextSha256: "a".repeat(64),
    sourceConfidenceRaw: 1,
    sourceConfidenceCalibrated: null,
    provider: "learner-authored",
    modelVersion: "direct-text-v1",
    languageTag: "zh-Hant",
    spans: [],
    reviewStatus: "unreviewed",
    displayStatus: "hidden",
    warnings: [],
    supersedesArtifactId: null,
    active: true,
    createdAt: "2026-08-28T" + time
  };
}

test("student cannot read the teacher artifact queue", async () => {
  const response = await server.inject({
    method: "GET",
    url: routes.analytics.artifacts(
      "00000000-0000-4000-8000-000000000010",
      { reviewStatus: "unreviewed", limit: 50 }
    ),
    headers: studentHeaders
  });
  expect(response.statusCode).toBe(403);
});

test("artifact queue is room-scoped and cursor-stable", async () => {
  await seedArtifacts([
    artifact("00000000-0000-4000-8000-000000000301", ROOM_A, "09:00:00Z"),
    artifact("00000000-0000-4000-8000-000000000302", ROOM_A, "09:00:00Z"),
    artifact("00000000-0000-4000-8000-000000000303", ROOM_A, "09:01:00Z"),
    artifact("00000000-0000-4000-8000-000000000304", ROOM_B, "09:00:00Z"),
    {
      ...artifact("00000000-0000-4000-8000-000000000305", ROOM_A, "09:02:00Z"),
      active: false,
      supersedesArtifactId: null
    }
  ]);
  const first = await teacherA.get(
    routes.analytics.artifacts(ROOM_A, {
      reviewStatus: "unreviewed",
      limit: 2
    })
  );
  expect(first.body.items.map((item: { artifactId: string }) => item.artifactId))
    .toEqual([
      "00000000-0000-4000-8000-000000000301",
      "00000000-0000-4000-8000-000000000302"
    ]);
  expect(first.body.nextAfterArtifactId)
    .toBe("00000000-0000-4000-8000-000000000302");
  const second = await teacherA.get(
    routes.analytics.artifacts(ROOM_A, {
      reviewStatus: "unreviewed",
      afterArtifactId: first.body.nextAfterArtifactId,
      limit: 2
    })
  );
  expect(second.body.items.map((item: { artifactId: string }) => item.artifactId))
    .toEqual(["00000000-0000-4000-8000-000000000303"]);
  expect(JSON.stringify(first.body)).not.toMatch(
    /providerSecret|rawMedia|signedUrl|objectKey|storageKey/
  );
  expect(await teacherA.get(
    routes.analytics.artifacts(ROOM_B, {
      reviewStatus: "unreviewed",
      limit: 2
    })
  )).toMatchObject({ status: 404 });
  const history = await teacherA.get(
    routes.analytics.artifacts(ROOM_A, {
      reviewStatus: "unreviewed",
      includeHistory: true,
      limit: 10
    })
  );
  expect(history.body.items.map((item: { artifactId: string }) => item.artifactId))
    .toContain("00000000-0000-4000-8000-000000000305");
});

test("artifact queue rejects a limit over 100", async () => {
  const response = await teacherA.get(
    routes.analytics.artifacts(ROOM_A, {
      reviewStatus: "unreviewed",
      limit: 101
    })
  );
  expect(response.status).toBe(400);
});

test("student cannot approve analytics", async () => {
  const response = await server.inject({
    method: "POST",
    url: routes.analytics.reviews(ROOM_A),
    headers: studentHeaders,
    payload: validApproval
  });
  expect(response.statusCode).toBe(403);
});

test.each(["reviews", "artifacts"])(
  "%s rejects cross-room, expired and deleting access before body/cursor parsing",
  async (surface) => {
    expect((await requestTeacherSurface(surface, crossRoomTeacherHeaders)).status)
      .toBe(404);
    expect((await requestTeacherSurface(surface, expiredTeacherHeaders)).status)
      .toBe(401);
    expect((await requestTeacherSurface(surface, expiredRoomTeacherHeaders)).status)
      .toBe(410);
    expect((await requestTeacherSurface(surface, deletingRoomTeacherHeaders)).status)
      .toBe(410);
  }
);

test.each(correctionCases)(
  "teacher correction $correctionKind is room-bound, versioned and replayed",
  async (payload) => {
    const accepted = await teacherA.post(
      routes.analytics.reviews(ROOM_A), payload
    );
    expect(accepted.status).toBe(201);
    expect(await replayJobCount(ROOM_A)).toBe(1);
    const retry = await teacherA.post(
      routes.analytics.reviews(ROOM_A), payload
    );
    expect(retry.status).toBe(200);
    expect(retry.json().eventId).toBe(accepted.json().eventId);
    expect(await countEvents("analytics.correction.recorded.v1")).toBe(1);
    expect(await replayJobCount(ROOM_A)).toBe(1);
    const crossRoom = await teacherB.post(
      routes.analytics.reviews(ROOM_A), payload
    );
    expect(crossRoom.status).toBe(404);
    const stale = await teacherA.post(
      routes.analytics.reviews(ROOM_A),
      { ...payload, expectedProjectionVersion: 3 }
    );
    expect(stale.status).toBe(409);
  }
);

test("correction kind rejects fields owned by another branch", async () => {
  const response = await teacherA.post(
    routes.analytics.reviews(ROOM_A),
    { ...validCorrection, targetProjectionEdgeId:
      "e9d17530-a4bb-5717-9d50-11ba588f51f1" }
  );
  expect(response.status).toBe(400);
  expect(await countEvents("analytics.correction.recorded.v1")).toBe(0);
  expect(await replayJobCount(ROOM_A)).toBe(0);
});

test("teacher approval appends room_event", async () => {
  const response = await server.inject({
    method: "POST",
    url: routes.analytics.reviews(ROOM_A),
    headers: teacherHeaders,
    payload: validApproval
  });
  expect(response.statusCode).toBe(201);
  expect(response.json().type).toBe("analytics.review.recorded.v1");
  expect(response.json().payload).toEqual({ changeKind: "review" });
  expect(await reviewDetail(response.json().eventId)).toMatchObject({
    roomId: ROOM_A, validatedPayload: validApproval
  });
  expect(JSON.stringify(await outboxEnvelope(response.json().eventId)))
    .not.toContain(validApproval.rationale);
});

test("unregistered analytics review rolls back ledger and outbox", async () => {
  const registry = createCoreEventPayloadRegistry();
  const repository = makeRoomEventRepository({ registry });
  await expect(
    repository.append(makeAnalyticsReviewAppend())
  ).rejects.toThrow("UNKNOWN_EVENT_TYPE:analytics.review.recorded.v1");
  expect(await countRows("room_event")).toBe(0);
  expect(await countRows("outbox_event")).toBe(0);
});

test("analytics module registers only human review facts", async () => {
  const registry = createCoreEventPayloadRegistry();
  registerAnalyticsReviewEventPayloads(registry);
  expect(() => registry.assert(
    "analytics.review.recorded.v1",
    { changeKind: "review" }
  )).not.toThrow();
  expect(() => registry.assert(
    "analytics.correction.recorded.v1",
    { changeKind: "correction" }
  )).not.toThrow();
  expect(() => registry.assert(
    "analytics.review.recorded.v1", validApproval
  )).toThrow("INVALID_EVENT_PAYLOAD");
  expect(() => registry.assert(
    "analytics.concept_patch.v1",
    {}
  )).toThrow("UNKNOWN_EVENT_TYPE:analytics.concept_patch.v1");
});
~~~

Add this compile-time ownership test:

~~~typescript
import type {
  AnalyticsReviewCommand,
  AnalyticsCorrectionInput,
  AnalyticsReviewInput
} from "../src/generated/analytics-review-command.v1";
import type {
  AnalyticsCorrectionNoticePayload,
  AnalyticsReviewNoticePayload
} from "../src/generated/analytics-review-room-event-payloads.v1";
import type {
  DerivedTextArtifactPage
} from "../src/generated/derived-text-artifact-page.v1";

test("command and safe fact modules have separate ownership", () => {
  expectTypeOf<AnalyticsReviewCommand>()
    .toMatchTypeOf<AnalyticsReviewInput | AnalyticsCorrectionInput>();
  expectTypeOf<AnalyticsReviewInput>().toHaveProperty("decision");
  expectTypeOf<AnalyticsCorrectionInput>()
    .toHaveProperty("correctionKind");
  expectTypeOf<AnalyticsReviewNoticePayload>()
    .toEqualTypeOf<{ changeKind: "review" }>();
  expectTypeOf<AnalyticsCorrectionNoticePayload>()
    .toEqualTypeOf<{ changeKind: "correction" }>();
  expectTypeOf<DerivedTextArtifactPage>().toHaveProperty("items");
  expectTypeOf<DerivedTextArtifactPage>()
    .toHaveProperty("nextAfterArtifactId");
});
~~~

The Python stdlib-unittest integration case uses <code>subTest</code> over all seven correction kinds. <code>replace_text</code> must create a new active <code>human_correction</code> artifact with complete spans/status/warnings/createdAt lineage and deactivate—but never mutate—the prior artifact. Replace-evidence, replace-relation, merge, split, undo and retract must produce deterministic overlays. Every accepted kind yields exactly one replay job; a cross-room target, mixed-branch payload or stale version yields none.

- [ ] **Step 2: Run and verify missing route/handler**

Run:

~~~bash
cd learning-orbit
pnpm --filter @learning-orbit/server test -- artifact-review-queue review-correction-routes event-payload-registration
cd services/worker
python3.12 -m unittest -v tests.integration.test_review_correction
~~~

Expected: artifact queue route receives 404, unregistered append rolls back with <code>UNKNOWN_EVENT_TYPE</code>, and Python test fails to import <code>handlers</code>.

- [ ] **Step 3: Freeze payloads and implement append-only transitions**

Create <code>derived-text-artifact-page.v1.json</code>:

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://learning-orbit.local/schemas/derived-text-artifact-page.v1.json",
  "title": "DerivedTextArtifactPage",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "items", "nextAfterArtifactId", "hasMore"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "items": {
      "type": "array",
      "items": { "$ref": "derived-text-artifact.v1.json" }
    },
    "nextAfterArtifactId": {
      "oneOf": [
        { "type": "string", "format": "uuid" },
        { "type": "null" }
      ]
    },
    "hasMore": { "type": "boolean" }
  }
}
~~~

Generate <code>DerivedTextArtifactPage</code> only in <code>packages/contracts/src/generated/derived-text-artifact-page.v1.ts</code>; <code>src/index.ts</code> re-exports it. Plan 05 imports that exact type.

Extend the existing shared builder in <code>packages/contracts/src/routes.ts</code>:

~~~typescript
type ArtifactReviewStatus =
  | "unreviewed" | "approved" | "rejected" | "corrected";

export type ArtifactPageQuery = {
  reviewStatus: ArtifactReviewStatus;
  afterArtifactId?: string;
  includeHistory?: boolean;
  limit?: number;
};

export const routes = {
  analytics: {
    artifacts(roomId: string, input: ArtifactPageQuery): string {
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("artifact_page_limit_must_be_1_to_100");
      }
      const query = new URLSearchParams();
      query.set("reviewStatus", input.reviewStatus);
      if (input.afterArtifactId) {
        query.set("afterArtifactId", input.afterArtifactId);
      }
      if (input.includeHistory === true) {
        query.set("includeHistory", "true");
      }
      query.set("limit", String(limit));
      return (
        "/v1/rooms/" + encodeURIComponent(roomId)
        + "/analytics/artifacts?" + query.toString()
      );
    }
  }
};
~~~

The existing <code>routes.analytics.latest</code>, <code>patches</code> and <code>reviews</code> members remain in the same object; this step adds <code>artifacts</code> without replacing them. Plan 05 calls exactly <code>routes.analytics.artifacts(roomId, { reviewStatus, afterArtifactId, includeHistory, limit })</code> and normally omits <code>includeHistory</code>.

Register teacher-only <code>GET /v1/rooms/:roomId/analytics/artifacts</code> in <code>apps/server/src/routes.ts</code>. It first calls <code>requireRoomAnalyticsAccess(...,"teacher_read")</code>; cross-room returns 404, expired session 401 and deletion-in-progress 410 before cursor parsing or artifact lookup. Default <code>reviewStatus</code> is <code>unreviewed</code>, default <code>includeHistory=false</code>, default limit is 50 and maximum is 100. Unknown status, invalid UUID cursor, cursor outside the authorized room/filter and invalid limit return 400 without disclosing whether another room contains that artifact.

Repository ordering and cursor SQL:

~~~sql
with cursor_row as (
  select created_at,artifact_id
  from derived_text_artifact
  where room_id=$1 and review_status=$2
    and artifact_id=$3::uuid
    and ($5::boolean or active=true)
)
select
  artifact_id,lineage_id,event_id,room_id,room_seq,source_media_id,
  source_modality,derivation,text_content,normalized_text_sha256,
  source_confidence_raw,source_confidence_calibrated,
  provider,model_version,language_tag,spans,
  review_status,display_status,warnings,
  supersedes_artifact_id,active,created_at
from derived_text_artifact a
where a.room_id=$1
  and a.review_status=$2
  and ($5::boolean or a.active=true)
  and (
    $3::uuid is null
    or (a.created_at,a.artifact_id) >
       (select created_at,artifact_id from cursor_row)
  )
order by a.created_at asc,a.artifact_id asc
limit $4 + 1;
~~~

The repository first verifies that a non-null cursor resolves inside the already authorized room and the same <code>reviewStatus/includeHistory</code> filter. It fetches <code>limit + 1</code>, returns at most <code>limit</code>, and derives <code>hasMore</code> plus <code>nextAfterArtifactId</code> from the last returned item. Default pages contain active artifacts only; <code>includeHistory=true</code> returns inactive superseded lineage to the teacher. The row mapper explicitly converts <code>lineage_id→lineageId</code>, <code>text_content→text</code>, other snake-case columns to generated camel-case fields, JSON spans/warnings to arrays, and returns every required <code>DerivedTextArtifact</code> field. It never joins media storage and never returns provider credentials, raw media bytes, object/storage keys, cookies, tokens, signed URLs or hidden prompts.

This queue owns only <code>DerivedTextArtifact</code> fidelity/review targets. Concept-edge targets continue to come from generated <code>echo.teacher_shadow</code> snapshots and are not copied into this page.

Approval payload:

~~~json
{
  "targetType": "evidence",
  "targetId": "00000000-0000-4000-8000-000000000701",
  "decision": "approve",
  "rationale": "Teacher checked the quoted source span.",
  "expectedAnalysisEpoch": "00000000-0000-4000-8000-000000000901",
  "expectedProjectionVersion": 4
}
~~~

Correction payload:

~~~json
{
  "targetArtifactId": "00000000-0000-4000-8000-000000000301",
  "correctionKind": "replace_text",
  "replacement": {
    "text": "分解者把物質轉成可回到土壤的養分。",
    "languageTag": "zh-Hant"
  },
  "reason": "Learner corrected the transcript and teacher verified it.",
  "expectedAnalysisEpoch": "00000000-0000-4000-8000-000000000901",
  "expectedProjectionVersion": 4
}
~~~

Define the teacher-only HTTP input union in <code>analytics-review-command.v1.json</code>. It is never used as a RoomEvent payload or sent on the room WebSocket:

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://learning-orbit.local/schemas/analytics-review-command.v1.json",
  "title": "AnalyticsReviewCommand",
  "oneOf": [
    { "$ref": "#/$defs/AnalyticsReviewInput" },
    { "$ref": "#/$defs/AnalyticsCorrectionInput" }
  ],
  "$defs": {
    "AnalyticsReviewInput": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "targetType", "targetId", "decision", "rationale",
        "expectedAnalysisEpoch", "expectedProjectionVersion"
      ],
      "properties": {
        "targetType": { "enum": ["derived_text", "evidence", "projection"] },
        "targetId": { "type": "string", "format": "uuid" },
        "decision": {
          "enum": [
            "review_pass", "review_concerns", "review_fail",
            "approve", "reject", "revoke"
          ]
        },
        "rationale": { "type": "string", "minLength": 1, "maxLength": 2000 },
        "expectedAnalysisEpoch": { "type": "string", "format": "uuid" },
        "expectedProjectionVersion": { "type": "integer", "minimum": 1 }
      }
    },
    "AnalyticsCorrectionInput": {
      "oneOf": [
        { "$ref": "#/$defs/ReplaceTextCorrection" },
        { "$ref": "#/$defs/ReplaceEvidenceSpanCorrection" },
        { "$ref": "#/$defs/ReplaceRelationCorrection" },
        { "$ref": "#/$defs/MergeAliasCorrection" },
        { "$ref": "#/$defs/SplitAliasCorrection" },
        { "$ref": "#/$defs/UndoMergeCorrection" },
        { "$ref": "#/$defs/RetractCorrection" }
      ]
    },
    "EvidenceRef": {
      "type": "object",
      "additionalProperties": false,
      "required": ["eventId", "start", "end"],
      "properties": {
        "eventId": { "type": "string", "format": "uuid" },
        "start": { "type": "integer", "minimum": 0 },
        "end": { "type": "integer", "minimum": 1 }
      }
    },
    "EmptyReplacement": {
      "type": "object",
      "additionalProperties": false,
      "maxProperties": 0
    },
    "ReplaceTextCorrection": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "targetArtifactId", "correctionKind", "replacement", "reason",
        "expectedAnalysisEpoch", "expectedProjectionVersion"
      ],
      "properties": {
        "targetArtifactId": { "type": "string", "format": "uuid" },
        "correctionKind": { "const": "replace_text" },
        "replacement": {
          "type": "object", "additionalProperties": false,
          "required": ["text", "languageTag"],
          "properties": {
            "text": { "type": "string", "minLength": 1, "maxLength": 20000 },
            "languageTag": { "type": "string", "minLength": 2, "maxLength": 35 }
          }
        },
        "reason": { "type": "string", "minLength": 1, "maxLength": 2000 },
        "expectedAnalysisEpoch": { "type": "string", "format": "uuid" },
        "expectedProjectionVersion": { "type": "integer", "minimum": 1 }
      }
    },
    "ReplaceEvidenceSpanCorrection": {
      "type": "object", "additionalProperties": false,
      "required": [
        "targetProjectionEdgeId", "correctionKind", "target", "replacement",
        "reason", "expectedAnalysisEpoch", "expectedProjectionVersion"
      ],
      "properties": {
        "targetProjectionEdgeId": { "type": "string", "format": "uuid" },
        "correctionKind": { "const": "replace_evidence_span" },
        "target": { "$ref": "#/$defs/EvidenceRef" },
        "replacement": { "$ref": "#/$defs/EvidenceRef" },
        "reason": { "type": "string", "minLength": 1, "maxLength": 2000 },
        "expectedAnalysisEpoch": { "type": "string", "format": "uuid" },
        "expectedProjectionVersion": { "type": "integer", "minimum": 1 }
      }
    },
    "ReplaceRelationCorrection": {
      "type": "object", "additionalProperties": false,
      "required": [
        "targetProjectionEdgeId", "correctionKind", "replacement", "reason",
        "expectedAnalysisEpoch", "expectedProjectionVersion"
      ],
      "properties": {
        "targetProjectionEdgeId": { "type": "string", "format": "uuid" },
        "correctionKind": { "const": "replace_relation" },
        "replacement": {
          "type": "object", "additionalProperties": false,
          "required": ["head", "predicate", "tail", "relationFamily"],
          "properties": {
            "head": { "type": "string", "minLength": 1, "maxLength": 160 },
            "predicate": { "type": "string", "minLength": 1, "maxLength": 160 },
            "tail": { "type": "string", "minLength": 1, "maxLength": 160 },
            "relationFamily": { "type": "string", "minLength": 1, "maxLength": 80 }
          }
        },
        "reason": { "type": "string", "minLength": 1, "maxLength": 2000 },
        "expectedAnalysisEpoch": { "type": "string", "format": "uuid" },
        "expectedProjectionVersion": { "type": "integer", "minimum": 1 }
      }
    },
    "MergeAliasCorrection": {
      "type": "object", "additionalProperties": false,
      "required": [
        "targetCanonicalNodeId", "correctionKind", "replacement", "reason",
        "expectedAnalysisEpoch", "expectedProjectionVersion"
      ],
      "properties": {
        "targetCanonicalNodeId": { "type": "string", "minLength": 1, "maxLength": 160 },
        "correctionKind": { "const": "merge_alias" },
        "replacement": {
          "type": "object", "additionalProperties": false,
          "required": ["aliasNodeId"],
          "properties": {
            "aliasNodeId": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        },
        "reason": { "type": "string", "minLength": 1, "maxLength": 2000 },
        "expectedAnalysisEpoch": { "type": "string", "format": "uuid" },
        "expectedProjectionVersion": { "type": "integer", "minimum": 1 }
      }
    },
    "SplitAliasCorrection": {
      "type": "object", "additionalProperties": false,
      "required": [
        "targetCanonicalNodeId", "correctionKind", "replacement", "reason",
        "expectedAnalysisEpoch", "expectedProjectionVersion"
      ],
      "properties": {
        "targetCanonicalNodeId": { "type": "string", "minLength": 1, "maxLength": 160 },
        "correctionKind": { "const": "split_alias" },
        "replacement": {
          "type": "object", "additionalProperties": false,
          "required": ["aliasNodeId", "newCanonicalNodeId", "newLabel"],
          "properties": {
            "aliasNodeId": { "type": "string", "minLength": 1, "maxLength": 160 },
            "newCanonicalNodeId": { "type": "string", "minLength": 1, "maxLength": 160 },
            "newLabel": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        },
        "reason": { "type": "string", "minLength": 1, "maxLength": 2000 },
        "expectedAnalysisEpoch": { "type": "string", "format": "uuid" },
        "expectedProjectionVersion": { "type": "integer", "minimum": 1 }
      }
    },
    "UndoMergeCorrection": {
      "type": "object", "additionalProperties": false,
      "required": [
        "targetCorrectionEventId", "correctionKind", "replacement", "reason",
        "expectedAnalysisEpoch", "expectedProjectionVersion"
      ],
      "properties": {
        "targetCorrectionEventId": { "type": "string", "format": "uuid" },
        "correctionKind": { "const": "undo_merge" },
        "replacement": { "$ref": "#/$defs/EmptyReplacement" },
        "reason": { "type": "string", "minLength": 1, "maxLength": 2000 },
        "expectedAnalysisEpoch": { "type": "string", "format": "uuid" },
        "expectedProjectionVersion": { "type": "integer", "minimum": 1 }
      }
    },
    "RetractCorrection": {
      "type": "object", "additionalProperties": false,
      "required": [
        "targetType", "targetId", "correctionKind", "replacement", "reason",
        "expectedAnalysisEpoch", "expectedProjectionVersion"
      ],
      "properties": {
        "targetType": { "enum": ["derived_text", "evidence", "projection"] },
        "targetId": { "type": "string", "format": "uuid" },
        "correctionKind": { "const": "retract" },
        "replacement": { "$ref": "#/$defs/EmptyReplacement" },
        "reason": { "type": "string", "minLength": 1, "maxLength": 2000 },
        "expectedAnalysisEpoch": { "type": "string", "format": "uuid" },
        "expectedProjectionVersion": { "type": "integer", "minimum": 1 }
      }
    }
  }
}
~~~

Define a separate, content-free RoomEvent payload catalog in <code>analytics-review-room-event-payloads.v1.json</code>:

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://learning-orbit.local/schemas/analytics-review-room-event-payloads.v1.json",
  "title": "AnalyticsReviewRoomEventPayloadCatalog",
  "type": "object",
  "additionalProperties": false,
  "maxProperties": 0,
  "$defs": {
    "AnalyticsReviewNoticePayload": {
      "type": "object", "additionalProperties": false,
      "required": ["changeKind"],
      "properties": { "changeKind": { "const": "review" } }
    },
    "AnalyticsCorrectionNoticePayload": {
      "type": "object", "additionalProperties": false,
      "required": ["changeKind"],
      "properties": { "changeKind": { "const": "correction" } }
    }
  }
}
~~~

Register exactly those two safe notice definitions before constructing <code>RoomEventRepository</code>:

~~~typescript
import analyticsReviewRoomEventSchema
  from "@learning-orbit/contracts/schemas/analytics-review-room-event-payloads.v1.json"
  with { type: "json" };
import type { EventPayloadRegistry }
  from "@learning-orbit/contracts";

export function registerAnalyticsReviewEventPayloads(
  registry: EventPayloadRegistry
): void {
  const closedPayload = (name: keyof typeof analyticsReviewRoomEventSchema.$defs) => ({
    $schema: analyticsReviewRoomEventSchema.$schema,
    $id: `https://learning-orbit.local/schemas/${name}.v1.json`,
    $defs: analyticsReviewRoomEventSchema.$defs,
    ...analyticsReviewRoomEventSchema.$defs[name]
  });
  registry.register(
    "analytics.review.recorded.v1",
    closedPayload("AnalyticsReviewNoticePayload")
  );
  registry.register(
    "analytics.correction.recorded.v1",
    closedPayload("AnalyticsCorrectionNoticePayload")
  );
}
~~~

<code>apps/server/src/app.ts</code> calls <code>createCoreEventPayloadRegistry()</code>, then <code>registerAnalyticsReviewEventPayloads(registry)</code>, then passes that registry to <code>RoomEventRepository</code>. Registration occurs once during app composition, never per request.

Allowed correction kinds are exactly <code>replace_text | replace_evidence_span | replace_relation | merge_alias | split_alias | undo_merge | retract</code>. Each is a separate closed tagged branch; a payload containing a target or replacement field from another branch fails before append. The single <code>POST routes.analytics.reviews(roomId)</code> handler validates the generated <code>AnalyticsReviewCommand</code> union, calls <code>requireRoomAnalyticsAccess(...,"teacher_write")</code>, and then dispatches review versus correction internally. It resolves every target in the same room: artifacts by <code>artifact_id/room_id</code>, ECHO edges by the room-scoped UUIDv5 in <code>echo.teacher_shadow</code>, evidence by <code>room_event.event_id/room_id</code>, aliases in the teacher shadow node set, and <code>undo_merge</code> by a prior <code>merge_alias</code> correction event in that room. Evidence spans must satisfy <code>0 ≤ start &lt; end ≤ normalized text length</code>; replacement relation endpoints must exist in the teacher snapshot; merge/split node IDs must be distinct; undo may reference exactly one still-effective merge. A missing or cross-room target returns 404; stale <code>analysisEpoch/projectionVersion</code> returns 409. Neither case appends a fact event or schedules replay.

After validation the server derives reviewer ID/role from authentication and computes the RoomEvent <code>causationId</code> as UUIDv5 over canonical JSON <code>[roomId, authenticatedTeacherId, validatedPayload]</code> in a fixed documented review namespace. Therefore an identical HTTP retry returns the existing event instead of duplicating a decision, while a new expected projection version creates a distinct fact. One transaction appends <code>analytics.review.recorded.v1</code> with payload <code>{changeKind:"review"}</code> or <code>analytics.correction.recorded.v1</code> with <code>{changeKind:"correction"}</code>, and inserts the full validated command into teacher-only <code>analytics_review_detail</code> keyed by that event. Only the content-free notice enters <code>outbox_event</code>, room history and WebSocket, so all roles retain a contiguous <code>roomSeq</code> without receiving rationale, corrected text, target/evidence IDs or alias operations. The Worker joins detail by <code>review_event_id</code> under its service assertion. A teacher-only detail route supports audit; student and cross-room requests return 404, and telemetry never records the payload. The append automatically receives its one <code>analytics.consume.v1</code> job. While consuming a valid review/correction event, the worker calls the shared `enqueue_analytics_replay` helper with `reason="analytics_review"`, requested-through equal to that notice's room sequence, dedupe token/event source equal to the review event ID, and its canonical correlation ID; no review code writes a replay row directly. Tests inspect raw outbox/WS/history/job JSON for every branch, retry every request and require one RoomEvent, one detail row, one consume job and one correctly ordered replay job. On consumption, <code>replace_text</code> atomically deactivates the target artifact and inserts a new active <code>human_correction</code> artifact whose <code>supersedesArtifactId</code> points to it; the prior row remains immutable and visible only with <code>includeHistory=true</code>. Evidence/relation/merge/split/undo/retract corrections are immutable overlays applied during deterministic replay; they never rewrite extraction artifacts or prior review rows.

Generate <code>AnalyticsReviewCommand</code>, <code>AnalyticsReviewInput</code>, <code>AnalyticsCorrectionInput</code> and all seven tagged correction branches only from <code>analytics-review-command.v1.json</code>. Generate the two safe notice payloads only from <code>analytics-review-room-event-payloads.v1.json</code>. <code>src/index.ts</code> re-exports both modules; no hand-written aggregate review type is allowed.

~~~python
from hashlib import sha256
from unicodedata import normalize
from uuid import uuid5

from learning_orbit_worker.derived_text import ARTIFACT_NAMESPACE
from learning_orbit_worker.domain import DerivedTextArtifact

REVIEW_TO_STATUS = {
    "review_pass": "unreviewed",
    "review_concerns": "unreviewed",
    "review_fail": "unreviewed",
    "approve": "approved",
    "reject": "rejected",
    "revoke": "rejected",
}


def display_status(algorithm: str, review_status: str) -> str:
    if algorithm == "ECHO-CM" and review_status in {"approved", "corrected"}:
        return "student_approved"
    if algorithm == "TRACE-AI":
        return "teacher_shadow"
    return "hidden"


def corrected_text_artifact(event: dict, prior, replacement: dict):
    text = normalize("NFC", replacement["text"]).strip()
    digest = sha256(text.encode("utf-8")).hexdigest()
    return DerivedTextArtifact(
        schema_version=1,
        artifact_id=str(uuid5(
            ARTIFACT_NAMESPACE,
            event["eventId"] + ":human_correction:" + digest,
        )),
        lineage_id=prior.lineage_id,
        room_id=prior.room_id,
        event_id=event["eventId"],
        room_seq=event["roomSeq"],
        source_media_id=prior.source_media_id,
        source_modality=prior.source_modality,
        derivation="human_correction",
        text=text,
        normalized_text_sha256=digest,
        source_confidence_raw=1.0,
        source_confidence_calibrated=None,
        provider="teacher-correction",
        model_version="teacher-correction-v1",
        language_tag=replacement["languageTag"],
        spans=(),
        review_status="corrected",
        display_status="hidden",
        warnings=(),
        supersedes_artifact_id=prior.artifact_id,
        active=True,
        created_at=event["ingestTime"],
    )
~~~

The worker locks the active prior artifact, inserts the complete object above, and runs <code>update derived_text_artifact set active=false where artifact_id=%s and active=true</code> in the same transaction. A zero-row update is a stale conflict and rolls back the new artifact. No schema/SQL/dataclass/page field is defaulted away at the boundary.

The public generated <code>reviewStatus</code> vocabulary is exactly <code>unreviewed | approved | rejected | corrected</code> in schema, SQL, projection and UI. Rich quality outcomes such as <code>review_pass/review_concerns/review_fail</code> remain teacher-only detail/warning metadata and leave public status <code>unreviewed</code>; they never masquerade as approval. Only an authenticated teacher decision creates <code>approved/rejected</code>, and a validated teacher correction creates <code>corrected</code>. Revoke maps to <code>rejected</code> and immediately removes student authorization in the next committed projection. TRACE individual evidence and personal metrics never enter a student projection.

- [ ] **Step 4: Run contract, server and worker tests**

Run:

~~~bash
cd learning-orbit
pnpm --filter @learning-orbit/contracts generate
pnpm --filter @learning-orbit/contracts test -- analytics-contracts
pnpm --filter @learning-orbit/server test -- artifact-review-queue review-correction-routes event-payload-registration
cd services/worker
python3.12 -m unittest -v tests.integration.test_review_correction
~~~

Expected: PASS; default pagination returns active lineage only, explicit history is stable and capped at 100, student/cross-room/expired/deleting access fails with the specified status, response fields contain no secret/raw-media URL material, unregistered review append rolls back ledger/outbox, composition-root registration permits exactly the two human-review fact events, all seven tagged corrections enforce kind-specific targets, stale/cross-room writes append nothing, and accepted corrections schedule deterministic replay without mutating prior evidence.

- [ ] **Step 5: Commit**

~~~bash
git add packages/contracts services/worker/src/learning_orbit_worker/generated/manifest.json apps/server/src/app.ts apps/server/src/routes.ts apps/server/src/modules/analytics/analytics-repository.ts apps/server/src/modules/analytics/register-analytics-review-event-payloads.ts apps/server/src/modules/rooms/room-event-repository.ts apps/server/test/analytics/artifact-review-queue.test.ts apps/server/test/analytics/event-payload-registration.test.ts apps/server/test/analytics/review-correction-routes.test.ts services/worker/src/learning_orbit_worker/analytics_handlers.py services/worker/tests/integration/test_review_correction.py
git commit -m "feat(analytics): add teacher review and correction events"
~~~

### Task 12: Prove controlled-pilot Gate 3 end to end

**Files:**
- Modify: <code>learning-orbit/services/worker/src/learning_orbit_worker/main.py</code>
- Modify: <code>learning-orbit/services/worker/src/learning_orbit_worker/analytics_handlers.py</code>
- Create: <code>learning-orbit/services/worker/tests/integration/test_gate3_pipeline.py</code>
- Create: <code>learning-orbit/apps/server/test/analytics/gate3-resync.test.ts</code>
- Modify: <code>learning-orbit/package.json</code>
- Create: <code>learning-orbit/scripts/run-analytics-gate3.sh</code>

- [ ] **Step 1: Write the failing integrated acceptance case**

The stdlib <code>unittest</code> case executes exactly:

1. Append golden <code>m001</code>, <code>m002</code>, <code>m004</code>, <code>m005</code>, <code>m006</code> plus media-only, lifecycle and system events in one room.
2. Prove every committed <code>room_event</code> has exactly one <code>analytics.consume.v1</code> job; claim them in <code>roomSeq</code> order and show semantic no-ops advance all four <code>completeThroughRoomSeq</code> values without fabricating text.
3. Read the teacher artifact queue in two stable active-only pages, then request history; prove a student is denied, a cross-room teacher gets 404, expired/deleting access is denied, the limit cannot exceed 100, and no secret/raw-media URL field is returned.
4. Persist deterministic extraction artifacts, two ECHO projections and the teacher/student TRACE bundles with identical algorithm/parameter metadata; claim their dedicated projection pointers and assert no projection-generated room-ledger event.
5. Assert <code>m002</code> directions, <code>m004 haoran → ROOM</code>, separate <code>m005 nova → haoran facilitation</code>, and <code>m006 haoran → meilin uptake</code> with no Nova uptake.
6. Assert every wire ECHO edge uses the fixture UUIDv5, serialized output contains no <code>edge-1</code>, and the student node set is exactly approved nodes plus approved-edge endpoints.
7. Assert both TRACE bundles contain exactly the `recent_10m` and `session_45m` windows, each with exactly three views; window boundaries are deterministic, <code>human_only</code> excludes Agent/ROOM, <code>lineage_adjusted</code> contains evidence-backed uptake only, and the student branch contains only room+epoch-scoped node IDs with server-assigned seat pseudonyms, allowlisted edges, four group metrics and safe warnings.
8. Insert a duplicate and prove version, content hash and weights do not change.
9. Insert a late revision and prove semantic head content is unchanged, cursor advances, <code>requiresReplay=true</code>, and one replay job exists with exact payload `{reason:"late_event",requestedThroughRoomSeq:N}`, matching non-null `(analytics_order_seq=N, analytics_order_kind=1)` and the source event correlation ID.
10. Run replay and prove semantic hashes plus <code>algorithmVersion/parameterHash</code> parity before atomically switching to a new epoch.
11. Seed a corrupt middle ECHO patch and a truncated chain; prove each request returns 409 plus snapshot URL and never a valid prefix. TRACE patch requests also resync to the atomic bundle snapshot.
12. Exercise all seven tagged correction kinds; prove cross-room/stale/mixed-branch requests append nothing, valid corrections replay, text correction preserves inactive lineage, and only the approved ECHO edge plus its endpoints enters <code>echo.student_approved</code>.

- [ ] **Step 2: Run the integrated gate and verify the red state**

Run:

~~~bash
cd learning-orbit
pnpm analytics:gate3
~~~

Expected: FAIL because the bounded worker entrypoint and combined script are absent.

- [ ] **Step 3: Add the bounded worker and one-command gate**

~~~python
def handle_analytics_consume(job: WorkerJob, deps: WorkerDeps) -> HandlerOutcome:
    payload = validate_closed_consume_payload(job.payload)
    deps.analytics_job_authority.require_consume(job, payload)
    deps.job_claims.require_current(job)
    return consume_event(deps, job, payload)


def handle_analytics_replay(job: WorkerJob, deps: WorkerDeps) -> HandlerOutcome:
    payload = validate_closed_replay_payload(job.payload)
    deps.analytics_job_authority.require_replay(job, payload)
    deps.job_claims.require_current(job)
    return replay_room(deps, job, payload)


def register_analytics_handlers(registry: HandlerRegistry) -> None:
    registry.register("analytics.consume.v1", handle_analytics_consume)
    registry.register("analytics.replay-room.v1", handle_analytics_replay)
~~~

The consume payload is exactly `{eventId,roomSeq,eventType}`. Before computation, `require_consume` loads that immutable RoomEvent and requires job room/source/dedupe/correlation to equal it, `payload.roomSeq/type` to equal it, and `(analytics_order_seq,kind)=(payload.roomSeq,0)`. Replay payload is exactly `{reason,requestedThroughRoomSeq}`; `require_replay` locks its immutable `analytics_replay_request` and requires job ID/room/source/dedupe/correlation/reason/requested-through plus `(seq,kind)=(payload.requestedThroughRoomSeq,1)` to match. Any drift writes zero artifact/projection/outbox. `consume_event` and `replay_room` pass the full claim into room-locked final transactions; each transaction inserts `complete_business(...,"ANALYTICS_CONSUMED"|"ANALYTICS_REPLAYED")` atomically with its checkpoint/projection/outbox or epoch/head CAS, including semantic no-op consume. Long computation uses heartbeat/cancellation and rechecks before commit. Tests mutate every raw field, pause/reclaim old attempts, and kill max-attempt workers immediately after each completion marker; claim recovery produces succeeded without repeating extraction/layout and unblocks the room-local barrier while another room continues.

Create <code>scripts/run-analytics-gate3.sh</code>:

~~~bash
#!/usr/bin/env bash
set -euo pipefail
test -f .venv/bin/activate
source .venv/bin/activate
python -c 'import sys; assert sys.version_info[:2] == (3, 12), sys.version'
docker compose -f infra/docker-compose.yml up -d postgres
pnpm --filter @learning-orbit/contracts generate
pnpm --filter @learning-orbit/contracts test -- analytics-contracts
pnpm --filter @learning-orbit/server db:migrate
pnpm db:migrate:test
pnpm vitest run apps/server/test/db/analytics-migration.test.ts
pnpm --filter @learning-orbit/server test -- snapshot-resync analytics-authorization projection-outbox artifact-review-queue event-payload-registration review-correction-routes gate3-resync
PYTHONPATH=.. python3.12 -m unittest -v work.test_learning_orbit_algorithms
cd services/worker
python3.12 -m unittest discover -s tests -p 'test_*.py' -v
~~~

Merge this key into the existing root <code>scripts</code> object without replacing Plan 01 commands:

~~~json
{
  "analytics:gate3": "bash scripts/run-analytics-gate3.sh"
}
~~~

- [ ] **Step 4: Run twice and inspect dead jobs**

Run:

~~~bash
cd learning-orbit
pnpm analytics:gate3
pnpm analytics:gate3
docker compose -f infra/docker-compose.yml exec -T postgres psql -U learning_orbit -d learning_orbit -c "select job_type,status,last_error from worker_job where status='dead' order by created_at"
~~~

Expected:

- Both gate runs exit 0.
- Each run activates the Plan 01-owned <code>.venv</code> and fails before migrations if its interpreter is not Python 3.12.
- Contract, migration, server, worker, parity, correction and resync suites pass.
- The artifact queue scenario passes with stable active/history pagination, teacher-only room authorization, the 100-row cap and the sensitive-field exclusion assertion.
- Dead-job query returns zero rows.
- Second run adds no duplicate artifact, patch, edge weight or review.

- [ ] **Step 5: Commit**

~~~bash
git add services/worker/src/learning_orbit_worker/main.py services/worker/src/learning_orbit_worker/analytics_handlers.py services/worker/tests/integration/test_gate3_pipeline.py apps/server/test/analytics/gate3-resync.test.ts package.json scripts/run-analytics-gate3.sh
git commit -m "test(analytics): prove controlled pilot gate 3"
~~~

## Gate 3 acceptance

- [ ] Preserved source <code>work/learning_orbit_algorithms.py</code> remains present and unchanged; both it and the worker copy have SHA-256 <code>3a2983b0f99cd016b45fb5fd7ee8e1ac4b93b3eee62f3a189a8e20df8c1cf220</code>. Preserved <code>work/test_learning_orbit_algorithms.py</code> has SHA-256 <code>59ad56baa784fa187b6ea6a7cffcbba6138bfc945e43a2aa38fc6cce78560732</code> and its 73 tests pass before adapters are admitted; wrapper code edits neither source file.
- [ ] <code>scripts/run-analytics-gate3.sh</code> activates the Plan 01-owned <code>.venv</code> and asserts <code>sys.version_info[:2] == (3, 12)</code> before any service, migration or test command; it neither creates a second environment nor depends on a system Python alias or machine-specific path.
- [ ] Every external analytics payload validates against versioned JSON Schema and contains finite numbers.
- [ ] Type generation emits the schema-basename modules <code>derived-text-artifact.v1.ts</code>, <code>derived-text-artifact-page.v1.ts</code>, <code>analysis-projection-envelope.v1.ts</code>, <code>analytics-review-command.v1.ts</code>, <code>analytics-review-room-event-payloads.v1.ts</code>, <code>echo-concept-projection.v1.ts</code> and <code>trace-projection.v1.ts</code>; <code>src/index.ts</code> re-exports them without merging their ownership.
- [ ] Plan 05 consumes <code>DerivedTextArtifactPage</code> from <code>packages/contracts/src/generated/derived-text-artifact-page.v1.ts</code> and builds requests only with <code>routes.analytics.artifacts(roomId, { reviewStatus, afterArtifactId, includeHistory, limit })</code>; it defines no substitute page type or URL.
- [ ] <code>RoomEventEnvelope</code> remains the only chat-event wire schema; Python <code>ChatEvent</code> is internal adapter input only and is absent from generated TS, HTTP and realtime payloads.
- [ ] Evidence, review and display status remain separate in DB, worker, wire contract and UI copy.
- [ ] JSON Schema, SQL, Python dataclass and page mapper agree on every <code>DerivedTextArtifact</code> field, including lineageId, spans, createdAt, active and nullable supersedes lineage. The one-active constraint is per lineage—not per event—so direct text and up to four media derivations coexist; revision/correction replaces only its prior lineage. Audio/image cannot masquerade as ASR/OCR text, and Nova text cannot be labelled learner-authored.
- [ ] Every committed <code>room_event</code> receives exactly one deduplicated <code>analytics.consume.v1</code> job. Per-room claims cannot overtake an unfinished lower sequence; media, lifecycle, system and review no-ops advance every projection's complete-through cursor without fabricated semantics.
- [ ] Golden directions are <code>m002 zilang → yaqing communication</code>, <code>m002 yaqing → zilang uptake</code>, <code>m004 haoran → ROOM communication</code>, <code>m005 nova → haoran facilitation</code> and <code>m006 haoran → meilin uptake</code>; Nova is absent from m006 uptake.
- [ ] Concurrent workers claim disjoint rows through <code>FOR UPDATE SKIP LOCKED</code> while the `(analytics_order_seq,kind,job_id)` barrier serializes consume and replay per room. Consume commits and replay CAS execute Plan 01's same canonical room-lock SQL; replay cannot replace a newer checkpoint/head with an older epoch.
- [ ] A missing <code>roomSeq</code> cannot advance, but a present semantic no-op must advance wire <code>completeThroughRoomSeq</code> and internal <code>complete_through_seq</code> atomically for all four heads.
- [ ] Every ECHO patch satisfies <code>projectionVersion = baseVersion + 1</code>; the endpoint validates every schema-valid row through the head and forces snapshot resync for a corrupt/truncated/overlong chain, epoch or algorithm/parameter mismatch. TRACE uses atomic bundle snapshots rather than partial-view patches.
- [ ] Generated <code>ConceptMapPatch</code> reconstructs the next <code>ConceptMapSnapshot</code> through added/updated/hidden node and edge deltas, carries object <code>EvidenceRef</code> values, and never emits <code>confidence</code>.
- [ ] Every projection snapshot, ECHO patch and TRACE bundle carries canonical <code>algorithmVersion</code> plus 64-hex <code>parameterHash</code>; both are persisted, included in semantic parity and cannot change inside an epoch.
- [ ] ECHO node, position, status, channel and edge definitions are closed; all numeric values are finite and range-checked. Internal edge keys never reach wire/review/fixtures: the sample edge is UUIDv5 <code>e9d17530-a4bb-5717-9d50-11ba588f51f1</code> online and during replay.
- [ ] <code>echo.student_approved</code> nodes equal explicitly approved nodes plus approved-edge endpoints. Its only student evidence exception is the teacher-approved, same-room <code>{eventId,start,end}</code> ref; room authorization is rerun and no identity/media/storage/provider field accompanies it.
- [ ] Closed teacher and student TRACE branches each contain exactly `recent_10m` and `session_45m`; each window contains exactly <code>observed</code>, <code>human_only</code> and <code>lineage_adjusted</code> plus validated bounds. Windows/views switch atomically under one <code>analysisEpoch/algorithmVersion/parameterHash/projectionVersion/baseVersion/completeThroughRoomSeq</code>.
- [ ] Snapshot, patch and pointer commit atomically; the pointer is claimed only from <code>analysis_projection_outbox</code> and sent as a schema-valid <code>projection</code> frame, with zero projection-generated <code>room_event</code> or Plan 01 <code>outbox_event</code> rows.
- [ ] A late event leaves current projection content unchanged, sets <code>requiresReplay</code>, and creates one deduplicated replay job.
- [ ] Online and replay semantic hashes match; replay writes a new epoch and swaps all projection heads atomically.
- [ ] Latest, patch, projection-frame, review/correction and artifact-page surfaces share the same current-session and room-grant guard. Cross-room returns 404, expired sessions return 401, expired retention/deletion-in-progress return 410, students cannot reach teacher surfaces, and no unapproved third-role branch exists.
- [ ] Teacher review/correction is authenticated, append-only, version-checked and auditable. The seven correction kinds are mutually exclusive closed branches with kind-specific targets/replacements; room mismatch, mixed branch and stale version append no event/job, while valid kinds schedule one replay.
- [ ] <code>GET /v1/rooms/:roomId/analytics/artifacts</code> is teacher-only and room-authorized, sorts by <code>(created_at, artifact_id)</code>, uses <code>afterArtifactId</code> as its stable cursor, defaults to active-only/50 rows and rejects limits above 100; <code>includeHistory=true</code> alone exposes inactive lineage to that room's teacher.
- [ ] <code>DerivedTextArtifactPage</code> contains only canonical artifact fields and never provider secrets, raw media, object/storage keys, cookies, tokens, signed URLs or hidden prompts. Concept-edge review targets remain solely in <code>echo.teacher_shadow</code> and are not duplicated into the artifact page.
- [ ] The composition root explicitly registers only <code>analytics.review.recorded.v1</code> and <code>analytics.correction.recorded.v1</code> closed payloads before constructing <code>RoomEventRepository</code>; an unregistered append rolls back, while projection/patch event names remain rejected and use <code>analysis_projection_outbox</code> instead.
- [ ] Automated review cannot approve student display; only teacher approval exposes an ECHO edge.
- [ ] TRACE <code>human_only</code> contains no Agent/ROOM node or incident edge; <code>lineage_adjusted</code> contains evidence-backed human uptake only. Student output uses only HMAC-rotated room+analysisEpoch node IDs with Plan 01 seat labels, communication/uptake edges, four metrics and allowlisted warnings; closed schemas reject identity mappings, evidence, weight, individual strength, centrality, ranking, risk and latent-trait fields.
- [ ] Four learners receive participation balance, reciprocity, Agent share and semantic coverage plus <code>small_group_interpretation_warning</code> and the exact `TRACE_STUDENT_INTERPRETATION_ZH_HANT` claim ceiling; teacher projection alone retains identity mapping and evidence.
- [ ] Chat append remains successful while analytics is retrying, rebuilding, stale, unavailable or dead.
- [ ] UI/API copy retains the original-engineering-synthesis claim ceiling and “not friendship, ability, grade, contribution value, psychological state, or causation” warning.

## Non-goals

- Live third-party LLM, ASR or OCR provider integration is excluded; this phase only freezes their artifact boundary.
- Automatic alias merge, embedding similarity as proposition truth, unrestricted generated facts and silent model fallback are excluded.
- Public links, QR, cross-room and external API sharing of analytics are excluded.
- Individual ranking, centrality alerts, friendship/ability/grade/discipline/psychological inference and automated learner risk labels are prohibited.
- PageRank, betweenness, community detection and causal Agent-effect claims are excluded.
- Raw minor voice/image retention, face recognition, voiceprint identification, emotion inference and provider-training use are excluded.
- Production SLA, global scale, learning-outcome effectiveness and peer-reviewed validity are not claimed by Gate 3.
- Outcome research begins only under a separately approved protocol covering consent, privacy, fairness, accessibility, sample design, adverse findings and teacher override.
