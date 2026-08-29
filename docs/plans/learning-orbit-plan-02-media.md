# Learning Orbit Media Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prototype's memory-only FileReader and MediaRecorder paths with authorized, resumable, private image/audio storage, processing, playback, reply linkage, and deletion.

**Architecture:** The browser requests an upload grant from the Fastify server, uploads directly to an S3-compatible private bucket, and asks the server to finalize the upload. PostgreSQL stores authoritative media state; a Python worker claims durable jobs, scans and derives safe assets, and submits idempotent outcomes. Chat persists attachments only through Plan 01's core `message.add` -> `message.added` path with `mediaIds`; safe `media_status` frames are best-effort UI updates outside `RoomEvent`/`roomSeq`/outbox, and authenticated GET restores the current public view after refresh or a missed frame.

**Tech Stack:** Next.js App Router, React, TypeScript, Fastify, JSON Schema 2020-12, PostgreSQL 18, Python 3.12, S3-compatible object storage, ClamAV, Pillow, ffmpeg/ffprobe, Vitest, Python unittest, Playwright, Docker Compose.

---

## Preconditions and file map

Complete `learning-orbit-plan-01-foundation-realtime.md` first. The following must already exist and pass: authenticated room membership, generated `RoomCommand`/`RoomEventEnvelope`/`RealtimeFrame`, the default-deny `EventPayloadRegistry`, core `message.add`/`message.added` with unique UUID `mediaIds` (maximum four), the injectable transaction-aware `AttachmentValidator` port, `room_event`, `outbox_event`, `worker_job`, shared generated `routes`, and `pnpm test:contracts`. Before every task, run `cd learning-orbit && source .venv/bin/activate && python3.12 -c 'import sys; assert sys.version_info[:2] == (3, 12)'`; reuse Plan 01's uncommitted `.venv` and never hardcode a user-specific Python path.

Create or modify only these responsibilities:

- `learning-orbit/packages/contracts/schemas/media-attachment-view.v1.json`: public generated media view with no storage identifiers or signed URL.
- `learning-orbit/packages/contracts/schemas/media-command.schema.json`: create/finalize command payloads.
- `learning-orbit/packages/contracts/schemas/media-status.v1.json` and `realtime-frame.v1.json`: safe generated outcome frame outside the room event ledger.
- `learning-orbit/packages/contracts/src/routes.ts`: canonical `routes.media.get(roomId, mediaId)` plus upload/complete/download helpers.
- `learning-orbit/infra/postgres/migrations/002_media.sql`: media and derivative tables.
- `learning-orbit/infra/images.lock.json`: reviewed immutable MinIO/ClamAV image digests and evidence metadata.
- `learning-orbit/apps/server/src/modules/media/`: upload authorization, finalize, download authorization, state transitions.
- `learning-orbit/apps/web/src/media/`: image and audio UI state machines.
- `learning-orbit/services/worker/`: durable worker runtime and media processor.
- `learning-orbit/tests/e2e/media.spec.ts`: real browser upload/recording/failure journeys.

Do not add OCR, ASR, image understanding, or model calls in this plan. Plan 04 introduces those as separately versioned shadow artifacts.

### Task 1: Freeze media contracts and database states

**Files:**
- Create: `learning-orbit/packages/contracts/schemas/media-attachment-view.v1.json`
- Create: `learning-orbit/packages/contracts/schemas/media-command.schema.json`
- Create: `learning-orbit/packages/contracts/schemas/media-status.v1.json`
- Modify: `learning-orbit/packages/contracts/schemas/realtime-frame.v1.json`
- Verify unchanged: `learning-orbit/packages/contracts/scripts/generate-types.mjs`
- Modify: `learning-orbit/packages/contracts/src/routes.ts`
- Modify: `learning-orbit/packages/contracts/src/index.ts`
- Create: `learning-orbit/packages/contracts/test/media-contract.test.ts`
- Create: `learning-orbit/infra/postgres/migrations/002_media.sql`
- Create: `learning-orbit/apps/server/src/modules/media/media-asset-record.ts`
- Test: `learning-orbit/apps/server/test/integration/media-schema.test.ts`

- [ ] **Step 1: Write failing contract tests**

```ts
import { describe, expect, it } from "vitest";
import { routes } from "../src/routes";
import { readSchema, validateSchema } from "./support/validate-schema";

const MEDIA_ID = "00000000-0000-4000-8000-000000000701";
const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const OWNER_ID = "00000000-0000-4000-8000-000000000101";

describe("generated media contracts", () => {
  it("whitelist-serializes the public view without room, owner, or storage identity", () => {
    const record = internalMediaRecord({
      mediaId: MEDIA_ID, roomId: ROOM_ID, ownerActorId: OWNER_ID,
      objectKey: `rooms/${ROOM_ID}/original/${MEDIA_ID}`
    });
    const view = serializeMediaAttachment(record);
    expect(validateSchema("media-attachment-view.v1", view)).toEqual([]);
    const schema = readSchema("media-attachment-view.v1");
    for (const key of ["roomId", "ownerActorId", "objectKey", "signedUrl", "sha256", "promotionCorrelationId", "storageOrigin"]) {
      expect(view).not.toHaveProperty(key);
      expect(schema.required).not.toContain(key);
      expect(schema.properties).not.toHaveProperty(key);
    }
  });

  it("freezes a text-free status frame and the canonical member GET route", () => {
    expect(validateSchema("media-status.v1", {
      type: "media_status", mediaId: MEDIA_ID, state: "ready",
      failureCode: null, updatedAt: "2026-08-28T09:12:00Z"
    })).toEqual([]);
    expect(routes.media.get(ROOM_ID, MEDIA_ID)).toBe(`/v1/rooms/${ROOM_ID}/media/${MEDIA_ID}`);
  });
});
```

Plan 01's deterministic generator discovers the new schema basename automatically; do not add a second list or hand-write its output. `$ref` the closed `media-status.v1.json` branch from `realtime-frame.v1.json`. It requires only `type:"media_status"`, UUID `mediaId`, `state: uploaded|processing|ready|quarantined|failed|deleted`, nullable bounded `failureCode`, and `updatedAt`; it contains no room, owner, filename, URL, hash, byte content, or storage/provider metadata. Export only generated types/parsers—Plan 02 does not define or register a `media.*` `RoomEvent` payload.

```json
{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://learning-orbit.local/schemas/media-status.v1.json","title":"MediaStatusFrame","type":"object","additionalProperties":false,"required":["type","mediaId","state","failureCode","updatedAt"],"properties":{"type":{"const":"media_status"},"mediaId":{"type":"string","format":"uuid"},"state":{"enum":["uploaded","processing","ready","quarantined","failed","deleted"]},"failureCode":{"type":["string","null"],"maxLength":100},"updatedAt":{"type":"string","format":"date-time"}}}
```

Extend Plan 01's shared route module with encoded canonical builders:

```ts
media:{upload:(r:string)=>room(r,"/media/uploads"),get:(r:string,m:string)=>room(r,`/media/${encodeURIComponent(m)}`),complete:(r:string,m:string)=>room(r,`/media/${encodeURIComponent(m)}/complete`),download:(r:string,m:string)=>room(r,`/media/${encodeURIComponent(m)}/download`)}
```

- [ ] **Step 2: Run the test and verify the red state**

Run: `cd learning-orbit && pnpm vitest run packages/contracts/test/media-contract.test.ts`  
Expected: FAIL because the public view, status frame, route helper, and serializer are absent.

- [ ] **Step 3: Add the canonical schema**

`media-command.schema.json` is a generated catalog for the authenticated upload and finalize responses:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://learning-orbit.local/schemas/media-command.schema.json",
  "title": "MediaCommandCatalog",
  "type": "object",
  "additionalProperties": false,
  "maxProperties": 0,
  "$defs": {
    "CreateMediaUploadInput": {
      "type": "object", "additionalProperties": false,
      "required": ["kind", "originalFileName", "mime", "sizeBytes", "sha256", "altText", "caption"],
      "properties": {
        "kind": { "enum": ["image", "audio"] },
        "originalFileName": { "type": "string", "minLength": 1, "maxLength": 255 },
        "mime": { "type": "string", "minLength": 1, "maxLength": 127 },
        "sizeBytes": { "type": "integer", "minimum": 1, "maximum": 26214400 },
        "sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
        "altText": { "type": ["string", "null"], "maxLength": 500 },
        "caption": { "type": ["string", "null"], "maxLength": 1000 }
      },
      "allOf": [{ "if": { "properties": { "kind": { "const": "image" } } }, "then": { "properties": { "altText": { "type": "string", "minLength": 1 } } } }]
    },
    "MediaUploadGrant": {
      "type": "object", "additionalProperties": false,
      "required": ["mediaId", "uploadUrl", "requiredHeaders", "expiresAt"],
      "properties": {
        "mediaId": { "type": "string", "format": "uuid" },
        "uploadUrl": { "type": "string", "format": "uri" },
        "requiredHeaders": {
          "type": "object", "additionalProperties": false,
          "required": ["x-amz-checksum-sha256"],
          "properties": { "x-amz-checksum-sha256": { "type": "string", "pattern": "^[A-Za-z0-9+/]{43}=$" } }
        },
        "expiresAt": { "type": "string", "format": "date-time" }
      }
    },
    "MediaDownloadGrant": {
      "type": "object", "additionalProperties": false,
      "required": ["downloadUrl", "expiresAt"],
      "properties": {
        "downloadUrl": { "type": "string", "format": "uri" },
        "expiresAt": { "type": "string", "format": "date-time" }
      }
    },
    "CompleteMediaUploadResponse": {
      "type": "object", "additionalProperties": false,
      "required": ["mediaId", "state", "enqueued"],
      "properties": {
        "mediaId": { "type": "string", "format": "uuid" },
        "state": { "enum": ["uploaded", "processing", "ready"] },
        "enqueued": { "type": "boolean" }
      }
    }
  }
}
```

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://learning-orbit.local/schemas/media-attachment-view.v1.json",
  "title": "MediaAttachmentView",
  "type": "object",
  "additionalProperties": false,
  "required": ["mediaId", "kind", "state", "detectedMime", "sizeBytes", "altText", "caption", "failureCode", "createdAt", "updatedAt"],
  "properties": {
    "mediaId": { "type": "string", "format": "uuid" },
    "kind": { "enum": ["image", "audio"] },
    "state": { "enum": ["upload_pending", "uploaded", "processing", "ready", "quarantined", "failed", "deleted"] },
    "detectedMime": { "type": ["string", "null"], "maxLength": 127 },
    "sizeBytes": { "type": "integer", "minimum": 1, "maximum": 26214400 },
    "altText": { "type": ["string", "null"], "maxLength": 500 },
    "caption": { "type": ["string", "null"], "maxLength": 1000 },
    "failureCode": { "type": ["string", "null"], "maxLength": 100 },
    "createdAt": { "type": "string", "format": "date-time" },
    "updatedAt": { "type": "string", "format": "date-time" }
  },
  "allOf": [
    { "if": { "properties": { "kind": { "const": "image" } } }, "then": { "properties": { "altText": { "type": "string", "minLength": 1 } } } }
  ]
}
```

`MediaAssetRecord` is server/Worker-internal and includes `roomId`, `ownerActorId`, declared/original names, object keys, hashes and durable promotion correlation. It deliberately has no independent retention class or deadline: Plan 06's immutable room-bound policy becomes the sole retention authority before any real pilot room. `serializeMediaAttachment(record): MediaAttachmentView` constructs a new closed object by explicit field whitelist; it never spreads the record. Contract, authenticated API-response, and rendered-DOM tests reject `roomId`, `ownerActorId`, object key, signed URL, SHA-256, promotion correlation, storage origin, and internal filenames. A signed download URL is returned only by the separately authorized, user-activated endpoint.

- [ ] **Step 4: Add fixed SQL geometry for media state**

```sql
CREATE TYPE media_kind AS ENUM ('image', 'audio');
CREATE TYPE media_state AS ENUM ('upload_pending', 'uploaded', 'processing', 'ready', 'quarantined', 'failed', 'deleted');
CREATE TYPE media_upload_grant_state AS ENUM ('issuing', 'active', 'promoted', 'revoked', 'expired', 'closed');
CREATE TYPE media_write_fence_state AS ENUM ('active', 'uncertain', 'completed', 'cancelled');

CREATE TABLE media_asset (
  media_id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  owner_actor_id uuid NOT NULL REFERENCES room_member(actor_id),
  kind media_kind NOT NULL,
  state media_state NOT NULL,
  original_file_name text NOT NULL CHECK (length(original_file_name) BETWEEN 1 AND 255),
  declared_mime text NOT NULL,
  detected_mime text,
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
  declared_sha256 char(64) NOT NULL CHECK (declared_sha256 ~ '^[a-f0-9]{64}$'),
  sha256 char(64),
  alt_text text,
  caption text,
  object_key text UNIQUE,
  failure_code text,
  promotion_correlation_id uuid,
  outcome_transition_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'image' OR (alt_text IS NOT NULL AND length(trim(alt_text)) > 0)),
  CHECK (state NOT IN ('uploaded','processing','ready') OR
         (object_key IS NOT NULL AND sha256 IS NOT NULL AND promotion_correlation_id IS NOT NULL))
);

CREATE TABLE media_upload_grant (
  grant_id uuid PRIMARY KEY,
  media_id uuid UNIQUE NOT NULL REFERENCES media_asset(media_id) ON DELETE RESTRICT,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE RESTRICT,
  object_key text UNIQUE NOT NULL,
  state media_upload_grant_state NOT NULL,
  correlation_id uuid NOT NULL,
  reserved_at timestamptz NOT NULL,
  signed_at timestamptz,
  expires_at timestamptz NOT NULL,
  write_not_after timestamptz NOT NULL CHECK (write_not_after >= expires_at),
  activated_at timestamptz,
  promotion_source_etag text,
  promotion_sha256 char(64),
  promotion_destination_key text,
  promotion_correlation_id uuid,
  promotion_started_at timestamptz,
  promotion_write_not_after timestamptz,
  revoked_at timestamptz,
  closed_at timestamptz,
  CHECK ((state IN ('active','promoted') AND activated_at IS NOT NULL AND signed_at IS NOT NULL AND expires_at > signed_at) OR state NOT IN ('active','promoted')),
  CHECK ((promotion_source_etag IS NULL AND promotion_sha256 IS NULL AND promotion_destination_key IS NULL AND promotion_correlation_id IS NULL AND promotion_started_at IS NULL AND promotion_write_not_after IS NULL) OR
         (promotion_source_etag IS NOT NULL AND promotion_sha256 ~ '^[a-f0-9]{64}$' AND promotion_destination_key IS NOT NULL AND promotion_correlation_id IS NOT NULL AND promotion_started_at IS NOT NULL AND promotion_write_not_after >= promotion_started_at))
);

CREATE TABLE media_derivative (
  derivative_id uuid PRIMARY KEY,
  media_id uuid NOT NULL REFERENCES media_asset(media_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('thumbnail', 'sanitized_image', 'playback_audio', 'waveform')),
  object_key text NOT NULL UNIQUE,
  mime text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (media_id, kind)
);

CREATE TABLE media_attachment_binding (
  media_id uuid PRIMARY KEY REFERENCES media_asset(media_id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  source_event_id uuid NOT NULL REFERENCES room_event(event_id) ON DELETE CASCADE,
  bound_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id,message_id,media_id)
);

CREATE TABLE media_write_fence (
  write_fence_id uuid PRIMARY KEY,
  media_id uuid NOT NULL REFERENCES media_asset(media_id) ON DELETE RESTRICT,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE RESTRICT,
  worker_job_id uuid NOT NULL REFERENCES worker_job(job_id) ON DELETE RESTRICT,
  worker_attempt integer NOT NULL CHECK (worker_attempt > 0),
  claim_generation bigint NOT NULL CHECK (claim_generation > 0),
  claim_token uuid NOT NULL,
  operation text NOT NULL CHECK (operation = 'derivative_write'),
  state media_write_fence_state NOT NULL,
  write_not_after timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (worker_job_id,claim_generation,operation),
  CHECK ((state IN ('completed','cancelled')) = (completed_at IS NOT NULL))
);

CREATE INDEX media_asset_room_state_idx ON media_asset(room_id, state);
CREATE INDEX media_upload_grant_room_state_idx ON media_upload_grant(room_id, state, write_not_after);
CREATE INDEX media_write_fence_room_state_idx ON media_write_fence(room_id,state,write_not_after);
```

`media_upload_grant` is an internal, URL-free ledger and a deletion fence. Both parent FKs are `ON DELETE RESTRICT`: neither the media row nor room can disappear until a grant has passed its bounded write window, the exact key has been swept/probed, and the lifecycle owner explicitly closes/removes the ledger row. `media_attachment_binding` gives each uploaded asset exactly one logical message/source lineage. The binding is retained across revise/retract and until governed deletion; a learner who needs the same bytes in a new message must create a new upload. This intentionally prevents one media ID from changing multimodal provenance when an earlier message is retracted. Migration tests prove a direct parent delete fails while any issuing/active/revoked grant remains, succeeds only after lifecycle closure, and rejects a second message binding for the same media.

- [ ] **Step 5: Apply migrations and commit**

Run: `cd learning-orbit && pnpm db:migrate:test && pnpm contracts:generate && pnpm test:contracts && pnpm vitest run apps/server/test/integration/media-schema.test.ts`  
Expected: all commands PASS; the generated public view/status frame and canonical route helper validate, the realtime union accepts `media_status`, no `media.*` RoomEvent schema is generated, PostgreSQL rejects image rows whose alt text is null/empty/whitespace-only, promoted states without durable promotion identity, malformed write-fence state/time pairs, and parent deletion while an active/uncertain write fence remains.  
Commit:

```bash
git add packages/contracts infra/postgres/migrations/002_media.sql apps/server/src/modules/media/media-asset-record.ts apps/server/test/integration/media-schema.test.ts
git commit -m "feat(media): freeze media contracts and persistence states"
```

### Task 2: Authorize direct private uploads

**Files:**
- Create: `learning-orbit/apps/server/src/modules/media/media-store.ts`
- Create: `learning-orbit/apps/server/src/modules/media/s3-media-store.ts`
- Modify: `learning-orbit/apps/server/package.json`
- Modify: `learning-orbit/pnpm-lock.yaml`
- Create: `learning-orbit/apps/server/src/modules/media/media-service.ts`
- Create: `learning-orbit/apps/server/src/modules/media/media-upload-grants.ts`
- Create: `learning-orbit/apps/server/src/modules/media/media-upload-expiry.ts`
- Create: `learning-orbit/apps/server/src/modules/media/media-routes.ts`
- Test: `learning-orbit/apps/server/test/media/upload-grant.test.ts`
- Test: `learning-orbit/apps/server/test/media/upload-expiry.test.ts`
- Test: `learning-orbit/apps/server/test/media/upload-deletion-fence.test.ts`
- Test: `learning-orbit/apps/server/test/integration/s3-media-store.test.ts`
- Test: `learning-orbit/apps/server/test/security/media-idor.test.ts`

- [ ] **Step 1: Write a failing authorization test**

```ts
const ROOM_ID = "00000000-0000-4000-8000-000000000010";

it("derives the owner from the room session and never trusts actorId", async () => {
  const response = await studentClient.post(`/v1/rooms/${ROOM_ID}/media/uploads`, {
    body: { kind: "image", originalFileName: "pond.png", mime: "image/png", sizeBytes: 1200, sha256: "a".repeat(64), altText: "池塘草图", caption: "观察" }
  });
  expect(response.statusCode).toBe(201);
  expect(new URL(response.json().uploadUrl).origin).toBe("http://127.0.0.1:59000");
  const row = await db.one("SELECT a.owner_actor_id,a.object_key AS immutable_key,g.object_key AS staging_key FROM media_asset a JOIN media_upload_grant g USING(media_id) WHERE a.media_id = $1", [response.json().mediaId]);
  expect(row.owner_actor_id).toBe(studentClient.actorId);
  expect(row.immutable_key).toBeNull();
  expect(row.staging_key).toMatch(new RegExp(`^rooms/${ROOM_ID}/staging/`));
});

it("rejects a grant whose origin is outside the generated storage allowlist", async () => {
  fakeStore.nextUploadUrl = "https://evil.example/upload";
  await expect(requestUploadGrant(studentClient)).rejects.toThrow("STORAGE_ORIGIN_NOT_ALLOWED");
});

it("rejects client correlation and persists only the server request correlation", async () => {
  expect((await studentClient.post(`/v1/rooms/${ROOM_ID}/media/uploads`, { body: { ...validUploadBody, correlationId: crypto.randomUUID() } })).statusCode).toBe(400);
  const response = await studentClient.post(`/v1/rooms/${ROOM_ID}/media/uploads`, { body: validUploadBody });
  expect(await grantCorrelation(response.json().mediaId)).toBe(response.headers["x-correlation-id"]);
});

it("anchors expiry to the actual delayed signature before releasing the room lock", async () => {
  fakeStore.blockPresign();
  const pending = requestUploadGrant(studentClient);
  clock.advance(45_000);
  fakeStore.releasePresign();
  const response = await pending;
  const row = await uploadGrantRow(response.json().mediaId);
  expect(row.signedAt).toEqual(fakeStore.lastSignedAt);
  expect(row.expiresAt).toEqual(new Date(fakeStore.lastSignedAt.getTime() + 300_000));
  expect(response.json().expiresAt).toBe(row.expiresAt.toISOString());
  expect(row.writeNotAfter).toEqual(maxDate(
    addMs(row.expiresAt, 120_000 + fakeStore.capabilities.maxSignerDbClockSkewMs),
    addMs(row.activatedAt, 300_000 + 120_000 + fakeStore.capabilities.maxSignerDbClockSkewMs)
  ));
});

it.each([-600_000, 600_000])("keeps signed PUT deletion bound safe under %i ms app/signer skew", async (skewMs) => {
  appClock.setOffset(skewMs); fakeStore.signerClock.setOffset(-skewMs);
  const grant = await requestUploadGrant(studentClient);
  appClock.jumpBy(-2 * skewMs);
  const row = await persistedGrant(grant.mediaId);
  expect(row.writeNotAfter.getTime()).toBeGreaterThanOrEqual(
    addMs(row.activatedAt, 300_000 + 120_000 + fakeStore.capabilities.maxSignerDbClockSkewMs).getTime()
  );
  dbClock.advanceTo(new Date(row.writeNotAfter.getTime()-1));
  expect(await uploadExpiryDecision(row.grantId)).toEqual({state:"blocked",notBefore:row.writeNotAfter});
  await putAtLatestProviderAcceptedInstant(grant.uploadUrl);
  dbClock.advanceTo(row.writeNotAfter);
  await runUploadGrantJanitorOnce(row.grantId);
  expect(await lifecycleStore.headAbsent(row.objectKey, testStoreControl(dbClock, 2_000))).toBe(true);
  expect(await uploadGrantState(row.grantId)).toBe("closed");
});
```

- [ ] **Step 2: Verify the route is missing**

Run: `cd learning-orbit && pnpm vitest run apps/server/test/media/upload-grant.test.ts`  
Expected: FAIL with HTTP 404.

- [ ] **Step 3: Implement a storage port and grant service**

```ts
export type StoreCallControl = Readonly<{ signal: AbortSignal; deadline: Date }>;

export interface MediaStore {
  readonly capabilities: { maxPresignMs: number; maxUploadRequestMs: number; maxSignerDbClockSkewMs: number; maxPostAbortSettlementMs: number; exactKeyHeadIsStronglyConsistent: boolean; strongChecksumHead: boolean; conditionalPromotion: boolean; writeOnceDestination: boolean };
  createUploadUrl(input: { objectKey: string; mime: string; sizeBytes: number; checksumSha256Base64: string; expiresSeconds: number }, control: StoreCallControl): Promise<{ url: string; requiredHeaders: { "x-amz-checksum-sha256": string }; signedAt: Date; expiresAt: Date }>;
  promoteStagingObject(input: { stagingKey: string; destinationKey: string; sourceEtag: string; expectedSha256: string; ifDestinationAbsent: true }, control: StoreCallControl): Promise<"created" | "already_present_same_hash">;
  createDownloadUrl(input: { objectKey: string; expiresSeconds: number }, control: StoreCallControl): Promise<string>;
  stat(objectKey: string, control: StoreCallControl): Promise<{ objectKey: string; sizeBytes: number; sha256: string; detectedMime: string; etag: string }>;
  deleteObjects(objectKeys: string[], control: StoreCallControl): Promise<void>;
}

export async function createUploadGrant(deps: MediaDeps, request: UploadRequest): Promise<UploadGrant> {
  const member = await deps.rooms.requireActiveStudent(request.sessionId, request.roomId);
  if (request.kind === "image" && !request.altText.trim()) throw new MediaError("ALT_REQUIRED", 422);
  const limit = request.kind === "image" ? 10 * 1024 * 1024 : 25 * 1024 * 1024;
  if (request.sizeBytes < 1 || request.sizeBytes > limit) throw new MediaError("SIZE_OUT_OF_RANGE", 422);
  if (!deps.store.capabilities.exactKeyHeadIsStronglyConsistent || !deps.store.capabilities.strongChecksumHead || !deps.store.capabilities.conditionalPromotion || !deps.store.capabilities.writeOnceDestination || deps.store.capabilities.maxUploadRequestMs !== deps.config.maxUploadRequestMs || !Number.isFinite(deps.store.capabilities.maxSignerDbClockSkewMs) || deps.store.capabilities.maxSignerDbClockSkewMs < 0 || !Number.isFinite(deps.store.capabilities.maxPostAbortSettlementMs) || deps.store.capabilities.maxPostAbortSettlementMs < 0)
    throw new MediaError("STORAGE_UPLOAD_FENCE_UNPROVEN", 503);
  const mediaId = deps.ids.uuid();
  const grantId = deps.ids.uuid();
  const stagingKey = `rooms/${request.roomId}/staging/${grantId}`;
  return deps.repo.withRoomGrantIssueLock(request.roomId, async (lock) => {
    lock.assertWritable();
    const issuing = await deps.repo.insertPendingAssetAndIssuingGrantFromDbTime(lock, {
      ...request, mediaId, grantId, stagingKey, ownerActorId: member.actorId,
      correlationId: request.correlationId, maxPresignMs: deps.store.capabilities.maxPresignMs,
      signatureTtlMs: 300_000, maxUploadRequestMs: deps.config.maxUploadRequestMs,
      maxSignerDbClockSkewMs: deps.store.capabilities.maxSignerDbClockSkewMs,
    });
    try {
      const checksumSha256Base64 = hexSha256ToBase64(request.sha256);
      const signed = await deps.store.createUploadUrl({ objectKey: stagingKey, mime: request.mime, sizeBytes: request.sizeBytes, checksumSha256Base64, expiresSeconds: 300 }, lock.ioControl("presign", deps.store.capabilities.maxPresignMs));
      if (signed.requiredHeaders["x-amz-checksum-sha256"] !== checksumSha256Base64) throw new MediaError("STORAGE_CHECKSUM_BINDING_MISMATCH", 502);
      if (!deps.config.storageBrowserOrigins.includes(new URL(signed.url).origin)) throw new MediaError("STORAGE_ORIGIN_NOT_ALLOWED", 502);
      assertExactSignedWindow(signed, 300, issuing.reservedAt, deps.store.capabilities.maxPresignMs, deps.store.capabilities.maxSignerDbClockSkewMs);
      const persisted = await deps.repo.activateGrantWithActualTimes(lock, grantId, {
        signedAt: signed.signedAt,
        expiresAt: signed.expiresAt,
        signatureTtlMs: 300_000,
        maxUploadRequestMs: deps.config.maxUploadRequestMs,
        maxSignerDbClockSkewMs: deps.store.capabilities.maxSignerDbClockSkewMs,
      });
      return { mediaId, uploadUrl: signed.url, requiredHeaders: signed.requiredHeaders, expiresAt: persisted.expiresAt.toISOString() };
    } catch (error) {
      await deps.repo.revokeGrantAtDbTime(lock, grantId, "GRANT_ISSUE_FAILED");
      throw error;
    }
  });
}
```

The authenticated request context injects `correlationId`; the JSON body cannot supply it. `withRoomGrantIssueLock` is a session-level room media-write lock held across the durable issuing-ledger commit, bounded local presign, actual-time update and activation. `lock.ioControl` creates a fresh `AbortController`, execution deadline and stable timeout code; the lock wrapper aborts at the deadline and releases its dedicated PostgreSQL connection/advisory lock in `finally`. The repository returns DB `reservedAt`; `assertExactSignedWindow` requires `expiresAt-signedAt` to equal the 300-second TTL and `signedAt` to fall inside the DB reservation/presign window expanded only by the approved signer↔DB skew. Any excess skew fails before URL exposure. Provisional/activated deletion bounds are derived in PostgreSQL using the conservative formula below; no application wall-clock value is accepted. Presign timeout leaves a non-usable ledger. Actual signer times remain audit/public-expiry values, while the repository returns the DB-derived private fence. Tests skew/jump clocks, exercise the maximum accepted skew and reject one millisecond beyond it; the Plan 02 janitor cannot sweep one millisecond early and does sweep a latest-provider-accepted PUT at the bound. Task 8 exposes the media deletion hook contract, and Plan 06 alone proves a real room-deletion receipt; Task 2 does not fabricate that later saga. Error revocation also uses database time and preserves the fence.

Browser PUTs target only the per-grant staging key; no signed URL addresses the retained original. Finalize conditionally promotes the exact observed staging ETag/hash to a write-once `rooms/{roomId}/original/{mediaId}` key. A repeated PUT can change only staging and therefore cannot drift the immutable bytes scanned by the Worker. The storage capability manifest must prove the signer's URL-validation clock semantics, a finite maximum signer↔database clock skew, bounded presign and PUT duration, a finite post-abort settlement bound, exact-key HEAD consistency, conditional source-ETag promotion and absent-destination/write-once semantics. The issuing row and activation row derive their private deletion fence in PostgreSQL: `write_not_after` is at least the greater of `(signed expires_at + upload duration + approved skew)` and `(transaction_timestamp() + full signature TTL + upload duration + approved skew)`. Provider/app timestamps remain audit fields, not the sole fence. If any bound is unavailable, controlled-pilot admission must use the authenticated streaming upload gateway instead of direct PUT; it may not shorten the wait by assumption.

The deterministic janitor never removes an issuing/active/promoted/revoked ledger before its effective bound `greatest(write_not_after,coalesce(promotion_write_not_after,write_not_after))`. At or after that database-time bound it takes the room media-write lock and deletes/probes the staging key. For an abandoned promotion it also waits until the associated reconcile job is durably `succeeded`; only then may it remove the closed grant and failed pending asset, preserving retry authority if the internal-route response was lost. A successfully promoted immutable original remains under the raw-media retention class and is removed only by governed media/room expiry or deletion. Tests freeze the database clock, fail at every issue/activation boundary, start a PUT just before expiry, delay a conditional copy past its client abort, race janitor with deletion, repeat PUT after finalize and complete a final staging PUT at the declared maximum duration; they prove neither janitor nor deletion removes the grant fence early, staging cleanup cannot alter the immutable original, lost-response reconciliation remains retryable, and no deletion receipt can precede the later promotion/PUT settlement sweep.

Install and lock AWS SDK v3 packages at the reviewed versions. `s3-media-store.ts` signs `PutObject.ChecksumSHA256` and returns the one exact required header; the browser cannot omit/change it without signature/checksum failure. HEAD uses checksum mode and requires the storage-reported SHA-256, never ETag, filename or untrusted metadata; conditional copy preserves/reports that checksum and final verification matches `media_asset.declared_sha256`. The capability gate refuses a backend that cannot provide strong checksum validation+HEAD. Every AWS command has abort/connect/socket/total bounds. Before copy, PostgreSQL persists the database-time promotion settlement fence. Tests cover missing/tampered header, changed body with original checksum, checksum/CORS preflight, strong HEAD, copy round-trip, clock skew, delayed post-abort commit and timeouts. MinIO must reject bad bytes, return the same checksum for staging/original, preserve write-once identity, and deny anonymous/cross-room/root-list access. Fixture and real adapters share this contract.

- [ ] **Step 4: Register an authenticated Fastify route**

```ts
export const mediaRoutes: FastifyPluginAsync<MediaRouteDeps> = async (app, deps) => {
  app.post("/v1/rooms/:roomId/media/uploads", { schema: deps.schemas.uploadRequest }, async (request, reply) => {
    const grant = await createUploadGrant(deps.media, {
      sessionId: request.auth.sessionId,
      roomId: request.params.roomId,
      ...request.body,
      correlationId: request.context.correlationId
    });
    return reply.code(201).send(grant);
  });
};
```

- [ ] **Step 5: Run authorization and IDOR tests, then commit**

Run: `cd learning-orbit && pnpm vitest run apps/server/test/media/upload-grant.test.ts apps/server/test/media/upload-expiry.test.ts apps/server/test/security/media-idor.test.ts apps/server/test/integration/s3-media-store.test.ts`  
Expected: PASS; failed grants return no usable URL/active grant while their non-usable ledger remains through `writeNotAfter`, abandoned objects close idempotently, the real private S3 adapter passes its contract, and another room receives 404 without revealing whether the media exists.  
Commit:

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/modules/media apps/server/test/media apps/server/test/security/media-idor.test.ts apps/server/test/integration/s3-media-store.test.ts
git commit -m "feat(media): authorize private direct uploads"
```

### Task 3: Finalize uploads and enqueue processing atomically

**Files:**
- Create: `learning-orbit/packages/contracts/schemas/media-internal-reconcile.v1.json`
- Modify: `learning-orbit/packages/contracts/scripts/generate-types.mjs`
- Modify: `learning-orbit/packages/contracts/src/index.ts`
- Generate: `learning-orbit/packages/contracts/src/generated/media-internal-reconcile.v1.ts`
- Generate: `learning-orbit/services/worker/src/learning_orbit_worker/generated/media_internal_reconcile_v1.py`
- Generate from the existing flagged Plan 01 schema: `learning-orbit/services/worker/src/learning_orbit_worker/generated/room_internal_auto_close_v1.py`
- Modify TypeScript manifest: `learning-orbit/packages/contracts/src/generated/manifest.json`
- Modify Python ingress manifest: `learning-orbit/services/worker/src/learning_orbit_worker/generated/manifest.json`
- Test: `learning-orbit/services/worker/tests/test_media_reconcile_contract.py`
- Modify: `learning-orbit/apps/server/src/modules/media/media-service.ts`
- Modify: `learning-orbit/apps/server/src/modules/media/media-routes.ts`
- Modify: `learning-orbit/apps/server/src/modules/media/media-upload-expiry.ts`
- Create: `learning-orbit/apps/server/src/modules/media/media-internal-reconcile-route.ts`
- Create: `learning-orbit/apps/server/src/modules/media/room-write-gate.ts`
- Reuse unchanged: `learning-orbit/apps/server/src/modules/security/service-assertion.ts`
- Reuse unchanged: `learning-orbit/apps/server/src/modules/jobs/job-claim-authority.ts`
- Reuse unchanged: `learning-orbit/apps/server/src/modules/rooms/room-lock.ts`
- Test: `learning-orbit/apps/server/test/integration/media-finalize.test.ts`
- Test: `learning-orbit/apps/server/test/media/upload-reconcile-internal.test.ts`
- Test: `learning-orbit/apps/server/test/media/download-grant.test.ts`

Task 3 extends the one canonical `generate-types.mjs` to write both `packages/contracts/src/generated/manifest.json` and `services/worker/src/learning_orbit_worker/generated/manifest.json` atomically. Both use the exact Plan 01 manifest-v1 ABI `{schemaVersion:1,sourceSchemas:[{file,id,sha256}],generatedModules:[{sourceFile,moduleFile,language}]}`; legacy `sourceSchemaFiles`/`schemaSha256` fields are forbidden. The two `sourceSchemas` arrays are byte-for-byte identical and sorted by `file` for every canonical schema on disk. The TypeScript manifest lists every schema module. Python emits only schemas carrying top-level annotation `"x-learning-orbit-python-ingress":true`; non-boolean flags and Worker imports from unflagged sources fail. Thus later internal schemas opt in without editing a second filename list. The Python manifest lists only those `language:"python"` modules, and every module names its canonical source. Generated files carry a do-not-edit header and source hash; a clean rerun must yield no diff. `generated-ownership.test.ts` and `test_media_reconcile_contract.py` validate the same manifest shape, full source set, flags and hashes before import. `media-internal-reconcile.v1.json` is generated into server TypeScript and Python ingress and is not a browser route:

The shared strict-Ajv factory registers exactly one annotation keyword before compiling schemas: `ajv.addKeyword({keyword:"x-learning-orbit-python-ingress",schemaType:"boolean",valid:true})`. It does not alter instance validation. Any other unknown `x-*` keyword remains a strict-mode error, and the generator independently requires the value to be exactly boolean `true` before Python emission.

Python emission adds no second code-generator dependency. For each flagged schema, the Node generator writes a deterministic snake-case module with a generated/source-hash header, an embedded canonical JSON string loaded by `json.loads`, `Draft202012Validator` plus `FormatChecker`, and `parse_request(value)` / `parse_response(value)` functions compiled from the schema's closed `$defs.Request` and `$defs.Response`. A parser deep-copies and returns only a validated JSON-compatible value; it neither coerces bigint strings nor supplies defaults. The generator fails if either definition is absent. Python contract tests recompute the source hash, reject extras/formats/31st items and prove a clean second generation has no diff.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://learning-orbit.local/schemas/media-internal-reconcile.v1.json",
  "title": "MediaInternalReconcileContract",
  "x-learning-orbit-python-ingress": true,
  "type": "object",
  "additionalProperties": false,
  "maxProperties": 0,
  "$defs": {
    "Request": {
      "type": "object",
      "additionalProperties": false,
      "required": ["jobId", "jobType", "roomId", "sourceEventId", "dedupeKey", "mediaId", "correlationId", "claimGeneration", "claimToken", "workerId"],
      "properties": {
        "jobId": { "type": "string", "format": "uuid" },
        "jobType": { "const": "media.reconcile-upload.v1" },
        "roomId": { "type": "string", "format": "uuid" },
        "sourceEventId": { "type": "null" },
        "dedupeKey": { "type": "string", "pattern": "^media\\.reconcile-upload\\.v1:[0-9a-f-]{36}$" },
        "mediaId": { "type": "string", "format": "uuid" },
        "correlationId": { "type": "string", "format": "uuid" },
        "claimGeneration": { "type": "string", "pattern": "^[1-9][0-9]{0,18}$" },
        "claimToken": { "type": "string", "format": "uuid" },
        "workerId": { "type": "string", "minLength": 1, "maxLength": 128 }
      }
    },
    "Response": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["status", "code"],
          "properties": {
            "status": { "const": "completed" },
            "code": { "enum": ["PROMOTION_COMMITTED", "ALREADY_PROMOTED", "PROMOTION_ABANDONED", "PROMOTION_IDENTITY_MISMATCH"] }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["status", "code", "notBefore"],
          "properties": {
            "status": { "const": "retryable" },
            "code": { "const": "PROMOTION_NOT_SETTLED" },
            "notBefore": { "type": "string", "format": "date-time" }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["status", "code"],
          "properties": {
            "status": { "const": "rejected" },
            "code": { "enum": ["SERVICE_ASSERTION_INVALID", "JOB_CLAIM_STALE", "MEDIA_JOB_IDENTITY_MISMATCH", "ROOM_DELETION_IN_PROGRESS"] }
          }
        }
      ]
    }
  }
}
```

- [ ] **Step 1: Write the transaction test**

```ts
const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const OWNER_ID = "00000000-0000-4000-8000-000000000101";
const MEDIA_ID = "00000000-0000-4000-8000-000000000701";
const SERVER_CORRELATION_ID = "00000000-0000-4000-8000-000000000799";
const RETRY_CORRELATION_ID = "00000000-0000-4000-8000-000000000798";

it("locks the owned row and makes duplicate finalize state-specific", async () => {
  await seedPending({ mediaId: MEDIA_ID, roomId: ROOM_ID, ownerActorId: OWNER_ID });
  const [first, retry] = await Promise.all([
    finalizeUpload(deps, { sessionId: ownerSessionId, roomId: ROOM_ID, mediaId: MEDIA_ID, correlationId: SERVER_CORRELATION_ID }),
    finalizeUpload(deps, { sessionId: ownerSessionId, roomId: ROOM_ID, mediaId: MEDIA_ID, correlationId: SERVER_CORRELATION_ID })
  ]);
  expect([first.state, retry.state]).toEqual(["uploaded", "uploaded"]);
  expect(await db.scalar("SELECT count(*)::int FROM worker_job WHERE dedupe_key=$1", [`media.process.v1:${MEDIA_ID}`])).toBe(1);

  await setMediaState(MEDIA_ID, "processing");
  await expect(finalizeUpload(deps, { sessionId: ownerSessionId, roomId: ROOM_ID, mediaId: MEDIA_ID, correlationId: SERVER_CORRELATION_ID }))
    .resolves.toMatchObject({ mediaId: MEDIA_ID, state: "processing", enqueued: false });

  for (const state of ["quarantined", "failed", "deleted"] as const) {
    await setMediaState(MEDIA_ID, state);
    await expect(finalizeUpload(deps, { sessionId: ownerSessionId, roomId: ROOM_ID, mediaId: MEDIA_ID, correlationId: SERVER_CORRELATION_ID }))
      .rejects.toMatchObject({ code: `MEDIA_${state.toUpperCase()}`, statusCode: 409 });
  }
});

it("promotes one immutable original despite repeated staging PUTs", async () => {
  const grant = await seedSignedStagingUpload({ mediaId: MEDIA_ID, bytes: cleanImageA });
  await finalizeUpload(deps, { sessionId: ownerSessionId, roomId: ROOM_ID, mediaId: MEDIA_ID, correlationId: SERVER_CORRELATION_ID });
  const immutable = await immutableObjectFor(MEDIA_ID);
  await putThroughAlreadyIssuedUrl(grant.uploadUrl, cleanImageB);
  await runMediaWorker(MEDIA_ID);
  expect((await immutableObjectFor(MEDIA_ID)).sha256).toBe(immutable.sha256);
  expect((await scanInputFor(MEDIA_ID)).sha256).toBe(immutable.sha256);
  expect((await derivativeSourceFor(MEDIA_ID)).sha256).toBe(immutable.sha256);
  await runGrantJanitorAt(grant.writeNotAfter);
  expect(await immutableObjectFor(MEDIA_ID)).toEqual(immutable);
});

it("cannot enqueue after deletion wins the room lock", async () => {
  const blocked = blockFinalizeAfterRouteAuthorizationBeforeRoomLock(MEDIA_ID);
  await testRoomWriteGate.beginDeletion(ROOM_ID);
  blocked.release();
  await expect(blocked.result).rejects.toMatchObject({ code: "ROOM_DELETION_IN_PROGRESS" });
  expect(await jobsByDedupe(`media.process.v1:${MEDIA_ID}`)).toEqual([]);
});

it("lets an in-lock finalize finish before deletion freezes its job", async () => {
  const blocked = blockFinalizeInsideConditionalPromotion(MEDIA_ID);
  const deletionPending = testRoomWriteGate.beginDeletionAndFreeze(ROOM_ID); // waits on the canonical lock
  blocked.release();
  await expect(blocked.result).resolves.toMatchObject({ state: "uploaded" });
  const deletion = await deletionPending;
  expect(await frozenMediaJobIds(deletion.deletionJobId)).toContain(await mediaJobId(MEDIA_ID));
});

it("reconciles copy success after a crash without a client retry", async () => {
  const crash = crashAfterImmutableCopyBeforeDbCommit(MEDIA_ID);
  await expect(crash.result).rejects.toThrow("SIMULATED_CRASH");
  await runMediaReconcileWorkerOnce();
  expect(await mediaState(MEDIA_ID)).toBe("uploaded");
  const jobs = await jobsForMedia(MEDIA_ID);
  expect(jobs.filter((job) => job.jobType === "media.process.v1")).toHaveLength(1);
  expect(jobs.find((job) => job.jobType === "media.process.v1")?.correlationId).toBe(SERVER_CORRELATION_ID);
  expect(jobs.find((job) => job.jobType === "media.process.v1")).toMatchObject({
    roomId: ROOM_ID, sourceEventId: null, payload: { mediaId: MEDIA_ID },
    status: "queued", runAfter: expect.any(Date)
  });
});

it("persists a complete room-scoped reconcile row", async () => {
  const crash = crashAfterPromotionIntentBeforeCopy(MEDIA_ID, SERVER_CORRELATION_ID);
  await expect(crash.result).rejects.toThrow("SIMULATED_CRASH");
  expect(await rawWorkerJobByDedupe(`media.reconcile-upload.v1:${MEDIA_ID}`)).toMatchObject({
    jobType: "media.reconcile-upload.v1", roomId: ROOM_ID, sourceEventId: null,
    payload: { mediaId: MEDIA_ID }, correlationId: SERVER_CORRELATION_ID,
    status: "queued", runAfter: expect.any(Date)
  });
});

it.each(["http_retry_first", "reconciler_first"] as const)(
  "keeps the first durable correlation when %s wins the room lock",
  async (winner) => {
    const crash = crashAfterImmutableCopyBeforeDbCommit(MEDIA_ID, SERVER_CORRELATION_ID);
    await expect(crash.result).rejects.toThrow("SIMULATED_CRASH");
    const race = raceHttpRetryWithReconciler({
      winner, mediaId: MEDIA_ID, retryCorrelationId: RETRY_CORRELATION_ID
    });
    await race.complete();
    const jobs = await jobsForMedia(MEDIA_ID);
    expect(jobs.filter((job) => job.jobType === "media.process.v1")).toHaveLength(1);
    expect(jobs.find((job) => job.jobType === "media.process.v1")?.correlationId)
      .toBe(SERVER_CORRELATION_ID);
    expect(await mediaPromotionCorrelation(MEDIA_ID)).toBe(SERVER_CORRELATION_ID);
  }
);
```

- [ ] **Step 2: Confirm duplicate completion currently fails**

Run: `cd learning-orbit && pnpm vitest run apps/server/test/integration/media-finalize.test.ts`  
Expected: FAIL because finalize behavior is absent.

- [ ] **Step 3: Implement strict object verification and idempotent enqueue**

```ts
export async function finalizeUpload(deps: MediaDeps, input: FinalizeInput): Promise<FinalizeResult> {
  const member = await deps.rooms.requireRoomMember(input.sessionId, input.roomId);
  return deps.repo.withRoomMediaWriteLock(input.roomId, async (lock) => {
    lock.assertWritable();
    const { media, grant } = await deps.repo.lockOwnedMediaAndGrant(lock, input.mediaId, input.roomId, member.actorId);
    if (["quarantined", "failed", "deleted"].includes(media.state))
      throw new MediaError(`MEDIA_${media.state.toUpperCase()}`, 409);

    if (media.state !== "upload_pending") {
      const immutable = await deps.store.stat(media.objectKey, lock.ioControl("head", deps.config.storeHeadTimeoutMs));
      if (immutable.sha256 !== media.sha256) throw new MediaError("OBJECT_IDENTITY_CHANGED", 409);
      return { mediaId: media.mediaId, state: media.state, enqueued: false };
    }

    const promotionControl = lock.ioControl("promotion", deps.config.storeCopyTimeoutMs);
    let intent = grant;
    if (!grant.promotionSourceEtag) {
      const staging = await deps.store.stat(grant.objectKey, lock.ioControl("head", deps.config.storeHeadTimeoutMs));
      if (staging.objectKey !== grant.objectKey || staging.sizeBytes !== media.sizeBytes || staging.sha256 !== media.declaredSha256) throw new MediaError("OBJECT_IDENTITY_CHANGED", 409);
      intent = await deps.repo.recordPromotionIntent(lock, grant.grantId, staging, `rooms/${media.roomId}/original/${media.mediaId}`, input.correlationId, {
        hardTotalMs: deps.config.storeCopyTimeoutMs,
        settlementMs: deps.store.capabilities.maxPostAbortSettlementMs,
      });
    }
    intent = await deps.repo.extendPromotionWriteFenceFromDbTime(lock, intent.grantId, {
      hardTotalMs: deps.config.storeCopyTimeoutMs,
      settlementMs: deps.store.capabilities.maxPostAbortSettlementMs,
    });
    await deps.store.promoteStagingObject({ stagingKey: intent.objectKey, destinationKey: intent.promotionDestinationKey, sourceEtag: intent.promotionSourceEtag, expectedSha256: intent.promotionSha256, ifDestinationAbsent: true }, promotionControl);
    const immutable = await deps.store.stat(intent.promotionDestinationKey, lock.ioControl("verify_head", deps.config.storeHeadTimeoutMs));
    if (immutable.sha256 !== intent.promotionSha256 || immutable.sizeBytes !== media.sizeBytes)
      throw new MediaError("OBJECT_PROMOTION_MISMATCH", 409);
    return deps.repo.commitPromotionAndEnqueue(lock, {
      mediaId: media.mediaId, immutableKey: intent.promotionDestinationKey,
      sha256: immutable.sha256, detectedMime: immutable.detectedMime,
      correlationId: intent.promotionCorrelationId,
    });
  });
}
```

`withRoomMediaWriteLock` takes Plan 01's canonical room advisory lock, then calls the injected closed `RoomWriteGate.assertWritable(tx,roomId)` before media rows. At Gate 2 the production adapter can only report current room status; `TestRoomWriteGate` supplies the deterministic deletion/freeze fixture above. Task 8 freezes the media deletion-hook interface, and Plan 06 replaces the adapter with the durable deletion tombstone and runs the same two-order fixture against the real saga before any pilot admission. The test helper is never selected outside `NODE_ENV=test`, so Plan 02 does not pretend the future deletion system already exists. `lockOwned` and `lockGrantForMedia` run under that lock. Every in-lock stat/copy/verification call receives an aborting absolute deadline, and the wrapper releases the dedicated connection/advisory lock in `finally`; timeout preserves the promotion intent and returns a stable retryable code. This closes the route-guard→freeze TOCTOU with two non-deadlocking tests: deletion-wins pauses finalize before lock acquisition, commits the test gate, then releases finalize to fail at `assertWritable`; finalize-wins pauses inside promotion, starts gate/freeze without awaiting it, releases/commits finalize, then awaits freeze and proves the new job/grant was captured. No test waits for a gate while deliberately withholding the lock it needs. Never-resolving HEAD, copy timeout and connection-reset fixtures each prove the competing gate acquires the lock after the configured upper bound. `input.correlationId` is injected by the authenticated server request context and is not accepted from the upload-complete JSON body. It is authoritative only when the first durable promotion intent is created; a later HTTP retry uses its own correlation only as a span link and must reuse `intent.promotionCorrelationId` for the durable media/process facts.

`upload_pending` is the only state that conditionally promotes staging and enqueues a new job. Before external copy, `recordPromotionIntent` atomically commits the chosen staging ETag/hash, immutable destination, `promotion_correlation_id` and first database-time `promotion_write_not_after`, and inserts exactly this raw job row while retaining the session-level room lock: `job_type='media.reconcile-upload.v1'`, `room_id=media.room_id` (never NULL), `source_event_id=NULL`, closed `payload={"mediaId":mediaId}`, `dedupe_key='media.reconcile-upload.v1:'+mediaId`, `correlation_id=promotion_correlation_id`, `status='queued'`, and `run_after=transactionNow`. Before every later copy attempt, `extendPromotionWriteFenceFromDbTime` computes `transaction_timestamp() + validated milliseconds` and monotonically raises—but never lowers—that persisted bound while holding the same lock; caller wall time cannot enter the SQL parameter list. At Gate 2 the later analytics-order columns do not yet exist; after Plan 03 migration 003, its database CHECK requires both to remain NULL for this non-analytics job, and the cross-plan raw-row test asserts that final shape. Conditional copy then either creates that exact destination or returns idempotent `already_present_same_hash`; a different existing hash fails closed. If the request process crashes after copy but before `commitPromotionAndEnqueue`, the durable reconcile job—not a hoped-for browser retry—reads the intent, verifies the immutable destination and finishes even if staging was overwritten later. If staging changes before copy, source-ETag precondition fails and the server may replace the intent only after proving the destination absent; it never silently selects new bytes after a destination exists. The final DB transaction atomically updates `media_asset`, copies the immutable `promotion_correlation_id` onto that asset, marks the grant promoted and inserts exactly one raw process row with `job_type='media.process.v1'`, the same non-null `room_id`, `source_event_id=NULL`, closed `{mediaId}` payload, dedupe `media.process.v1:{mediaId}`, the same correlation, queued status and database transaction-time `run_after`; Plan 03 likewise requires its order columns NULL. `commitPromotionAndEnqueue` itself reloads the locked intent and rejects any caller-supplied correlation that differs; neither a later HTTP request nor a Worker retry can replace it.

`media-upload-expiry.ts` remains the sole deterministic reconciliation owner and exports the one SQL-backed `effectiveWriteNotAfter(grant) = greatest(write_not_after,coalesce(promotion_write_not_after,write_not_after))` helper used by reconcile, janitor and Plan 06 deletion freeze. The Python Worker never reimplements this state machine: its thin adapter calls the signed internal endpoint. Inside the server, the endpoint takes the canonical room lock, reloads the raw reconcile job, media and grant, then applies these rules through `reconcileUploadIntent`: matching destination hash/size invokes the same idempotent `commitPromotionAndEnqueue`; absent destination before the effective bound is retryable; absent at/after it deletes/probes staging but atomically retains authority by closing the grant and marking the asset `failed/PROMOTION_ABANDONED`; a present but mismatched destination marks the media failed/quarantined with `PROMOTION_IDENTITY_MISMATCH`, never overwrites and never enqueues. The abandoned rows are removed only by the janitor after the canonical JobStore has durably marked that reconcile job `succeeded`, so response loss always has a same-correlation retry target. Tests combine response loss, delayed conditional-copy commit, janitor and deletion in both lock orders; all three consumers must return the identical effective bound, yield exactly one immutable original/process job or the explicit failure state, and never close the fence early.

`POST /internal/media/reconcile-upload`, canonical name `internal.media.reconcileUpload`, accepts only the generated full-claim `Request`; bigint generation crosses JSON as a canonical decimal string. The body and Plan 01 assertion bind `jobId,jobType,roomId,sourceEventId=null,dedupeKey,mediaId,correlationId,claimGeneration,claimToken,workerId`. Under the canonical room advisory lock the route locks room/media/grant rows, verifies their family identity, then invokes the singleton `JobClaimAuthority.requireCurrent`; it reuses Plan 01's assertion verifier and Worker signer/client rather than copying either. Every terminal promotion/already/abandoned/mismatch transaction uses `JobClaimAuthority.completeBusiness(...,"MEDIA_RECONCILE_COMPLETED")`; distinct domain codes remain only in the generated response. Retryable-not-settled writes no marker. Tests cover same-claim response loss and max-attempt kill: recovery yields one outcome with no second storage call.

Reusing the signed PUT after promotion changes only staging; tests overwrite staging before/during/after scan and prove the immutable hash, scan input and derivatives remain tied. Retries in `uploaded`, `processing`, or `ready` stat only the immutable key and return the existing result when its stored SHA-256 matches. `quarantined`, `failed`, and `deleted` are stable terminal rejections and never re-enqueue. The grant remains `promoted` until `effectiveWriteNotAfter`, when the janitor deletes only staging and closes it; it never deletes the retained original. Tests cover concurrent owners, cross-room probes, every state, crash after conditional copy, promotion intent retry, response loss with late copy, repeated PUT, deletion winning before finalize, and exactly one dedupe key.

- [ ] **Step 4: Expose completion, internal reconciliation and authorized download routes**

Run: `cd learning-orbit && pnpm vitest run apps/server/test/media/download-grant.test.ts apps/server/test/media/upload-reconcile-internal.test.ts`  
Expected before implementation: FAIL 404. Implement `POST /v1/rooms/:roomId/media/:mediaId/complete` by passing only `{sessionId:request.auth.sessionId,roomId:request.params.roomId,mediaId:request.params.mediaId,correlationId:request.context.correlationId}` to `finalizeUpload`; the closed body is empty and cannot override correlation. Implement the service-only reconciliation route and exact assertion/body binding above, with no browser-cookie fallback. Also implement authenticated, user-activated `GET /v1/rooms/:roomId/media/:mediaId/download`; it validates and returns generated `MediaDownloadGrant {downloadUrl,expiresAt}`, returns 409 until state is `ready`, and 404 for a different room. It sets `Cache-Control: no-store`; signed URLs never enter logs, RoomEvents, HTML rendered attributes, local storage or service-worker caches.

- [ ] **Step 5: Run the media server suite and commit**

Run: `cd learning-orbit && pnpm contracts:generate && pnpm test:contracts && .venv/bin/python -m unittest services/worker/tests/test_media_reconcile_contract.py -v && pnpm vitest run apps/server/test/media apps/server/test/integration/media-finalize.test.ts`  
Expected: PASS; the Python test imports both flagged auto-close and media-reconcile modules and verifies source hashes/closed parsing. Room/write lock, actual-time grant correlation, full room-scoped raw reconcile row, signed internal route, durable promotion intent, first-correlation authority under both HTTP-retry/reconciler lock orders, one immutable original/job after concurrent/repeated finalize and staging overwrite, identity-safe crash retries for uploaded/processing/ready, deletion-gate rejection, and stable rejection for quarantined/failed/deleted all pass.  
Commit:

```bash
git add packages/contracts services/worker/src/learning_orbit_worker/generated services/worker/tests/test_media_reconcile_contract.py apps/server/src/modules/media apps/server/test/media apps/server/test/integration/media-finalize.test.ts
git commit -m "feat(media): finalize uploads and enqueue processing"
```

### Task 4: Build the Python worker and safe media processor

**Files:**
- Modify: `learning-orbit/services/worker/pyproject.toml`
- Modify: `learning-orbit/services/worker/requirements.lock`
- Modify: `learning-orbit/services/worker/src/learning_orbit_worker/main.py`
- Verify unchanged: `learning-orbit/services/worker/src/learning_orbit_worker/jobs.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/media_handlers.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/media.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/media_object_store.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/media_job_authority.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/media_reconcile_client.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/bounded_io.py`
- Create: `learning-orbit/services/worker/src/learning_orbit_worker/clamav_client.py`
- Test: `learning-orbit/services/worker/tests/test_media.py`
- Test: `learning-orbit/services/worker/tests/test_media_reconcile.py`
- Test: `learning-orbit/services/worker/tests/test_media_deadlines.py`
- Test: `learning-orbit/services/worker/tests/test_media_handler_registration.py`
- Test: `learning-orbit/services/worker/tests/integration/test_media_services.py`
- Modify: `learning-orbit/infra/docker-compose.yml`
- Create: `learning-orbit/infra/images.lock.json`
- Create: `learning-orbit/infra/minio/init-private-bucket.sh`
- Create: `learning-orbit/scripts/verify-media-image-locks.mjs`
- Test: `learning-orbit/apps/server/test/integration/media-services-ready.test.ts`

- [ ] **Step 1: Write worker tests for clean, infected, corrupt, and empty media**

```python
class MediaProcessorTests(unittest.TestCase):
    def test_clean_image_strips_metadata_and_writes_derivatives(self):
        result = process_image(self.clean_image, self.fake_store, self.clean_scanner)
        self.assertEqual(result.state, "ready")
        self.assertEqual({item.kind for item in result.derivatives}, {"sanitized_image", "thumbnail"})

    def test_infected_media_is_quarantined(self):
        result = process_media(self.clean_audio, self.fake_store, Scanner(found="Eicar-Test-Signature"))
        self.assertEqual(result.state, "quarantined")
        self.assertEqual(result.failure_code, "MALWARE_DETECTED")

    def test_corrupt_audio_fails_without_derivative(self):
        result = process_audio(b"not-audio", self.fake_store, self.clean_scanner)
        self.assertEqual(result.state, "failed")
        self.assertEqual(result.derivatives, ())

    def test_deletion_fence_prevents_late_derivative_write(self):
        self.fence.block_before_write()
        future = self.pool.submit(
            process_media_job, self.deps, self.media_id, self.authority, self.job
        )
        self.deletions.start(self.room_id)
        self.fence.release()
        self.assertEqual(future.result().code, "ROOM_DELETION_IN_PROGRESS")
        self.assertEqual(self.store.list_prefix(self.room_prefix), [])

    def test_never_returning_derivative_write_releases_lock_at_total_deadline(self):
        self.store.make_derivative_write_never_return()
        future = self.pool.submit(
            process_media_job, self.deps, self.media_id, self.authority, self.job
        )
        self.clock.advance(15)
        self.assertEqual(future.exception().code, "MEDIA_STORE_WRITE_TIMEOUT")
        self.assertFalse(self.store.supervised_helper_is_alive())
        deletion = self.deletions.start(self.room_id)
        self.clock.advance_to(self.fence.write_not_after(self.media_id))
        self.deletions.run_until_settled(deletion.job_id)
        self.assertEqual(self.store.list_prefix(self.room_prefix), [])
        self.assertFalse(self.fence.advisory_lock_is_held(self.room_id))
```

`media-services-ready.test.ts` must reject `latest`, tag-only refs, missing `sha256`, absent official-source/review/scan metadata, unhealthy MinIO/ClamAV, a public/listable bucket, and missing ffmpeg/ffprobe version evidence.

Modify the existing worker dependency list and lock it with `boto3==1.43.82` and `Pillow==12.3.0`. `media_object_store.py` implements the same private S3 read/write/delete port with Boto3 and requires an absolute-deadline/cancellation control for every operation; `bounded_io.py` supplies the supervised hard-total-deadline runner described below. `media_reconcile_client.py` is a thin bounded HTTP client for the TypeScript-owned internal reconcile route, not a second state machine. `clamav_client.py` implements the bounded INSTREAM protocol over the private Compose network using the standard library, with connect/read/total timeouts and a byte ceiling. Pillow decodes/re-encodes images with decompression-bomb limits and drops metadata; audio probing/transcoding invokes the digest-locked ffprobe/ffmpeg binary with an argument array, resource/time ceilings and no shell. No host-global package or executable is accepted as evidence.

Add the media dependencies without replacing Plan 01's `cryptography/jsonschema/psycopg` pins. Regenerate the one Plan 01 lock with the activated Python 3.12 environment and `python -m piptools compile --generate-hashes --resolver=backtracking --output-file services/worker/requirements.lock services/worker/pyproject.toml`; run `node scripts/verify-python-lock.mjs`, install with `--require-hashes`, and inspect the dependency diff. No task installs Boto3/Pillow outside that lock, and the assertion signer import remains green after the update.

- [ ] **Step 2: Verify the worker package is absent**

Run: `cd learning-orbit && node scripts/verify-media-image-locks.mjs && pnpm vitest run apps/server/test/integration/media-services-ready.test.ts && python3.12 -m unittest discover -s services/worker/tests -v`  
Expected before implementation: lock verifier and readiness test fail; media handler is absent; Plan 01 worker tests remain green.

- [ ] **Step 3: Resolve and lock container images without inventing a future tag**

At execution, inspect the official MinIO and ClamAV release/registry records, run the approved vulnerability scanner, and pass those reviewed immutable `repository@sha256:...` refs to `verify-media-image-locks.mjs`. The script writes `images.lock.json` with image, digest, official source URL, review timestamp/tool/result and rejects mutable/tag-only/`latest` values. `docker-compose.yml` reads only verified exported `MINIO_IMAGE_REF`/`CLAMAV_IMAGE_REF`; CI runs the verifier before Compose. No illustrative tag or digest is committed by this plan.

Compose healthchecks wait for MinIO API readiness and ClamAV daemon readiness. `init-private-bucket.sh` idempotently creates the test bucket, removes all anonymous read/list/write, and applies narrow browser CORS for the exact configured web origin: signed `PUT`, signed user-activated `GET`, and `HEAD`; no credentials, wildcard origin, bucket listing method or arbitrary request header is allowed. Worker startup records exact `ffmpeg -version` and `ffprobe -version` first lines in processing audit metadata, never raw media logs.

- [ ] **Step 4: Register media processing on the canonical Plan 01 job runner**

```python
from learning_orbit_worker.handler_registry import HandlerRegistry, WorkerDeps, WorkerJob
from learning_orbit_worker.media import process_media_job


def require_media_job_authority(job: WorkerJob, deps: WorkerDeps, media_id: str):
    if job.room_id is None or job.source_event_id is not None:
        raise DeterministicContractError("MEDIA_JOB_ENVELOPE_INVALID")
    if getattr(job, "analytics_order_seq", None) is not None or getattr(job, "analytics_order_kind", None) is not None:
        raise DeterministicContractError("MEDIA_JOB_ANALYTICS_ORDER_FORBIDDEN")
    deps.job_claims.require_current(job)
    authority = deps.media_job_authority.load(media_id)
    if authority.room_id != job.room_id:
        raise DeterministicContractError("MEDIA_JOB_ROOM_MISMATCH")
    if authority.promotion_correlation_id != job.correlation_id:
        raise DeterministicContractError("MEDIA_JOB_CORRELATION_MISMATCH")
    return authority

def register_media_handlers(registry: HandlerRegistry) -> None:
    registry.register("media.process.v1", handle_media_process)
    registry.register("media.reconcile-upload.v1", handle_media_reconcile)

def handle_media_process(job: WorkerJob, deps: WorkerDeps) -> HandlerOutcome:
    payload = validate_closed_media_process_payload(job.payload)
    authority = require_media_job_authority(job, deps, payload["mediaId"])
    return process_media_job(deps, payload["mediaId"], authority, job)

def handle_media_reconcile(job: WorkerJob, deps: WorkerDeps) -> HandlerOutcome:
    payload = validate_closed_media_reconcile_payload(job.payload)
    require_media_job_authority(job, deps, payload["mediaId"])
    return deps.media_reconcile.request(
        job_id=job.job_id,
        room_id=job.room_id,
        media_id=payload["mediaId"],
        correlation_id=job.correlation_id,
        claim_generation=str(job.claim_generation),
        claim_token=job.claim_token,
        audience="learning-orbit.media-reconcile.v1",
        deadline=deps.deadlines.after("media_reconcile_internal"),
    )
```

Modify only Plan 01's composition root to register media handlers. Both adapters use `(WorkerJob, WorkerDeps) -> HandlerOutcome`, validate closed `{mediaId}`, claim, room/source/order and durable correlation before I/O. The read-only authority uses asset correlation after promotion and grant correlation while pending. Internal reconcile binds the full claim and parses generated responses; derivative fence/outcome transactions recheck it. Plan 01's unique canonical two-command claim protocol—candidate lock SQL followed by settle SQL in one READ COMMITTED transaction—remains untouched; no alternate claimant, runner or handler map may be added. Registration tests dispatch core/process/reconcile through scoped deps and reject malformed/drifted/stale inputs before I/O or business commit.

- [ ] **Step 5: Implement processor outcomes without leaking content to logs**

```python
def process_media_job(
    deps: WorkerDeps,
    media_id: str,
    authority: MediaJobAuthority,
    job: WorkerJob,
) -> HandlerOutcome:
    asset = deps.repo.get_media(media_id)
    if asset.room_id != authority.room_id:
        raise DeterministicContractError("MEDIA_JOB_ROOM_MISMATCH")
    source = deps.store.read_private(
        asset.object_key,
        control=deps.store_controls.new("source_read", total_seconds=15),
    )
    scan = deps.scanner.scan_bytes(source)
    if not scan.clean:
        deps.outcomes.submit(job, media_id, state="quarantined", failure_code="MALWARE_DETECTED", derivatives=())
        return HandlerOutcome.success()
    try:
        result = process_image_bytes(source) if asset.kind == "image" else process_audio_bytes(source)
    except InvalidMedia:
        deps.outcomes.submit(job, media_id, state="failed", failure_code="INVALID_MEDIA", derivatives=())
        return HandlerOutcome.success()
    write_control = deps.store_controls.new("derivative_write", total_seconds=15)
    fence = deps.room_media_write_fence(
        asset.room_id,
        media_id,
        worker_claim=job,
        worker_attempt=job.attempts,
    )
    try:
        db_write_not_after = fence.acquire(
            hard_total_ms=15_000,
            settlement_ms=deps.store.capabilities.max_post_abort_settlement_ms,
        )
        fence.assert_writable()
        keys = deps.store.write_derivatives(
            media_id, result.derivatives, control=write_control
        )
        fence.mark_complete()
    except StoreDeadlineExceeded:
        fence.mark_uncertain_until(db_write_not_after)
        raise RetryableJobError("MEDIA_STORE_WRITE_TIMEOUT")
    finally:
        fence.release_connection_and_advisory_lock()
    deps.outcomes.submit(job, media_id, state="ready", failure_code=None, derivatives=keys)
    return HandlerOutcome.success()
```

`room_media_write_fence` uses the same session-level room-scoped advisory lock as the Plan 06 deletion-start transaction. Its `write_fence_id` is UUIDv5 over `(worker_job_id,claim_generation,"derivative_write")`; `attempts` is audit context, never authority. `acquire`, `mark_complete` and `mark_uncertain_until` all receive the full lockedBy/generation/token claim and join `worker_job` on the exact current-running tuple in their mutation transaction. Acquire rechecks the durable deletion tombstone, then computes `write_not_after >= transaction_timestamp() + (hardTotalMs + maxPostAbortSettlementMs)` inside PostgreSQL and commits the active row with the generation/token before external I/O. Neither Python wall time nor a provider timestamp is persisted as deletion authority. The session lock remains held across each bounded derivative write. Before releasing it, the worker rechecks the claim and commits either `completed` or `uncertain`; therefore deletion can never acquire the next lock between an ambiguous return and visibility of its bound. If reclaim occurs mid-write, the old-token completion update affects zero rows and the already committed active fence remains protective through its bound. The explicit `try/finally` releases both the dedicated database connection and advisory lock on every success, exception, cancellation, timeout or stale-claim abort. If deletion has started or the heartbeat supervisor has lost its claim, the job aborts with no further write. Tests reclaim the same job after fence acquisition and require every old-token fence/outcome update to affect zero rows while deletion still waits on the original active bound.

`media_object_store.py` freezes one `ObjectStoreCallControl {monotonic_deadline,cancellation}` port for `read_private`, every derivative PUT/HEAD and delete. The storage capability manifest must provide a reviewed `maxPostAbortSettlementMs`; a backend without a finite, testable bound is ineligible for the pilot media processor. Its Boto client uses `botocore.config.Config(connect_timeout=2, read_timeout=5, retries={"total_max_attempts":2,"mode":"standard"}, tcp_keepalive=True)`. That SDK configuration is only the inner bound: `bounded_io.py` runs the complete Boto operation in a dedicated supervised helper process, passes the remaining monotonic deadline to each attempt, and terminates/joins the entire helper process group at the 15-second total deadline; a thread that can continue writing is forbidden. Before fork the parent captures and passes its PID. In the child, before constructing Boto or opening any socket, it records the expected PID, sets Linux `PR_SET_PDEATHSIG=SIGKILL`, immediately compares `getppid()` with that expected value, and exits on mismatch; this closes the fork→`prctl` parent-death race. The child also enforces its own monotonic deadline, runs in the worker container's non-shared PID/cgroup boundary and exits when its control pipe closes. Worker shutdown kills/joins the process group before relinquishing its container. If termination occurs after bytes may have reached storage, the database-time write fence stays active through the separately proven post-abort settlement bound and deletion performs its final exact-key/prefix sweep only afterward. Tests kill the parent both at the fork/`prctl` barrier and after PUT begins, skew/jump Python wall time, use a never-returning adapter, delay a post-abort commit, half-open/reset connections and exhaust retries; each asserts no child reaches network in the race, the helper/process group is gone, the bound follows database time, the connection/advisory lock is released by the monotonic total, no remote write appears after `write_not_after`, and deletion leaves the room prefix empty. Reconcile HEAD/copy remains in the TypeScript owner and therefore uses the Node `StoreCallControl`, not this Python port.

`deps.outcomes.submit(job,...)` calls the signed internal media-outcome endpoint introduced in Task 7 with the full Worker claim and a stable transition UUID. Its closed request/assertion binds `jobId,jobType,roomId,sourceEventId,dedupeKey,mediaId,correlationId,claimGeneration,claimToken,workerId` plus the outcome. The room-locked transaction locks the media/family rows, CAS-checks that exact running claim, then applies derivative metadata/state. A stale old token receives `JOB_CLAIM_STALE` and writes zero outcome/derivative/status frame. A timeout is retryable with the same transition UUID under the next current claim; the server persists the outcome and then emits only a generated `media_status` frame. The Worker uses Plan 01's one signer/client and does not allocate `roomSeq`, append `RoomEvent`, or write `outbox_event`.

The image implementation decodes and re-encodes pixels with Pillow, applies EXIF orientation, removes metadata, and creates a bounded thumbnail. The audio implementation runs `ffprobe` with a hard timeout, rejects zero-duration or over-limit audio, and runs `ffmpeg` with argument arrays rather than shell interpolation. Every derivative key is a closed deterministic template `rooms/{roomId}/derivative/{mediaId}/{kind}` for exactly the four allowlisted kinds; neither provider output nor filename chooses a key. Contract tests enumerate all five original/derivative exact keys for a media ID so deletion can probe even a write whose metadata transaction never occurred.

- [ ] **Step 6: Run unit and container integration tests, then commit**

Run: `cd learning-orbit && node scripts/verify-media-image-locks.mjs && docker compose -f infra/docker-compose.yml up -d postgres minio clamav minio-init && pnpm vitest run apps/server/test/integration/media-services-ready.test.ts && python3.12 -m unittest discover -s services/worker/tests -v`  
Expected: locked services are healthy, bucket private/CORS-limited, crash-without-client-retry reconciliation yields exactly one correlated processing job or explicit cleanup/quarantine, ffmpeg/ffprobe versions are recorded, and logs contain IDs/codes but no content or URLs.  
Commit:

```bash
git add services/worker infra/docker-compose.yml infra/images.lock.json infra/minio scripts/verify-media-image-locks.mjs apps/server/test/integration/media-services-ready.test.ts
git commit -m "feat(media): process private media in durable worker"
```

### Task 5: Implement image upload UI as a reducer

**Files:**
- Create: `learning-orbit/apps/web/src/media/image-state.ts`
- Create: `learning-orbit/apps/web/src/media/media-file-hash.ts`
- Create: `learning-orbit/apps/web/src/media/ImageAttachment.tsx`
- Test: `learning-orbit/apps/web/src/media/image-state.test.ts`
- Test: `learning-orbit/apps/web/src/media/media-file-hash.test.ts`
- Test: `learning-orbit/apps/web/src/media/ImageAttachment.test.tsx`

- [ ] **Step 1: Write reducer tests**

```ts
const REPLY_ID = "00000000-0000-4000-8000-000000000801";
const MEDIA_ID = "00000000-0000-4000-8000-000000000701";

it("requires meaningful alt text and preserves replyTo through upload", () => {
  let state = imageReducer(initialImageState, { type: "selected", file: pngFile });
  state = imageReducer(state, { type: "alt_changed", value: "池塘食物网草图" });
  state = imageReducer(state, { type: "reply_attached", eventId: REPLY_ID });
  state = imageReducer(state, { type: "upload_started", mediaId: MEDIA_ID });
  state = imageReducer(state, { type: "complete_acknowledged" });
  expect(state.phase).toBe("processing");
  expect(state.replyTo).toBe(REPLY_ID);
  expect(buildImageMessage(state, "池塘观察", [])).toEqual({
    type: "message.add", text: "池塘观察", mentions: [], replyTo: REPLY_ID, mediaIds: [MEDIA_ID]
  });
});
```

- [ ] **Step 2: Verify missing reducer failure**

Run: `cd learning-orbit && pnpm vitest run apps/web/src/media/image-state.test.ts`  
Expected: FAIL because `imageReducer` is absent.

- [ ] **Step 3: Implement explicit states**

```ts
export type ImagePhase = "idle" | "hashing" | "preview" | "granting" | "uploading" | "finalizing" | "processing" | "ready" | "failed";
export type ImageState = { phase: ImagePhase; file: File | null; sha256: string | null; mediaId: string | null; altText: string; caption: string; replyTo: string | null; errorCode: string | null };

export function canAttachImage(state: ImageState): boolean {
  return state.mediaId !== null && state.altText.trim().length > 0 && ["processing", "ready"].includes(state.phase);
}

export function imageReducer(state: ImageState, action: ImageAction): ImageState {
  switch (action.type) {
    case "selected": return { ...state, phase: "hashing", file: action.file, sha256: null, mediaId: null, errorCode: null };
    case "hash_ready": return { ...state, phase: "preview", sha256: action.sha256 };
    case "alt_changed": return { ...state, altText: action.value };
    case "caption_changed": return { ...state, caption: action.value };
    case "reply_attached": return { ...state, replyTo: action.eventId };
    case "upload_started": return { ...state, phase: "uploading", mediaId: action.mediaId };
    case "complete_acknowledged": return { ...state, phase: "processing" };
    case "ready": return { ...state, phase: "ready" };
    case "failed": return { ...state, phase: "failed", errorCode: action.code };
    case "reset": return initialImageState;
  }
}
```

- [ ] **Step 4: Connect progress, cancellation, and reply linkage**

Create the bounded Web Crypto helper and test it against a known vector before wiring the component:

```ts
// apps/web/src/media/media-file-hash.ts
export async function sha256Blob(blob: Blob, signal: AbortSignal): Promise<{hex:string;base64:string}> {
  if (blob.size < 1 || blob.size > 25 * 1024 * 1024) throw new Error("MEDIA_SIZE_OUT_OF_RANGE");
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  const base64 = btoa(String.fromCharCode(...digest));
  return {hex,base64};
}
```

`media-file-hash.test.ts` requires `sha256Blob(new Blob(["abc"]))` to return hex `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad` and base64 `ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=`. It also covers pre/post-digest abort and the 25 MiB bound. Web Crypto does not make `Blob.arrayBuffer()` abortable, so `ImageAttachment` owns a monotonically increasing selection token plus an `AbortController`: reset/replacement aborts the fetch and invalidates the token; a late digest is discarded before state or network mutation.

`ImageAttachment.tsx` must revoke the preview Object URL on replacement/unmount and cancel the upload with `AbortController`. It computes the digest before requesting a grant, sends the hex value in the generated `CreateMediaUploadInput.sha256`, verifies the returned `requiredHeaders["x-amz-checksum-sha256"]` equals the locally derived base64, and passes that generated `requiredHeaders` object byte-for-byte to the staging `PUT` with the original File as body. Missing/tampered headers, changed body, stale selection token and digest/grant mismatch stop before finalize. Alt text and caption belong only to the authenticated upload metadata. After `routes.media.complete(roomId, mediaId)` succeeds, the composer may submit only Plan 01's generated `message.add` payload `{ text, mentions, replyTo, mediaIds:[mediaId] }` (maximum four total); it sends no custom attachment command and never repeats alt/caption inside the message payload. It must not send Data URLs or trust the original file extension.

The browser accepts only generated grants whose origin is in `storageBrowserOrigins` (`https` in pilot; explicit loopback in tests). Bucket CORS allows only the exact web origin, signed `PUT` plus signed user-activated `GET`/`HEAD`, and only `Content-Type` plus `x-amz-checksum-sha256`; it forbids wildcard origins/credentials, anonymous access, lists and arbitrary headers. The PUT passes the generated `requiredHeaders` without normalization or omission. Downloads remain user-activated short grants from the authenticated endpoint, are fetched into a Blob, and the signed URL is never inserted into media markup.

- [ ] **Step 5: Run component tests and commit**

Run: `cd learning-orbit && pnpm vitest run apps/web/src/media/media-file-hash.test.ts apps/web/src/media/image-state.test.ts apps/web/src/media/ImageAttachment.test.tsx`  
Expected: PASS for the known SHA-256 vector, cancel/reset during hashing, replacement, retry, exact grant request/header/body, header/body tamper, duplicate selection, reply mode, and invalid files.  
Commit:

```bash
git add apps/web/src/media
git commit -m "feat(web): add resumable accessible image attachment state"
```

### Task 6: Implement race-safe audio recording and upload UI

**Files:**
- Create: `learning-orbit/apps/web/src/media/audio-state.ts`
- Create: `learning-orbit/apps/web/src/media/useAudioRecorder.ts`
- Create: `learning-orbit/apps/web/src/media/AudioAttachment.tsx`
- Test: `learning-orbit/apps/web/src/media/audio-state.test.ts`
- Test: `learning-orbit/apps/web/src/media/AudioAttachment.test.tsx`
- Reuse unchanged: `learning-orbit/apps/web/src/media/media-file-hash.ts`
- Reuse unchanged: `learning-orbit/apps/web/src/media/media-file-hash.test.ts`

- [ ] **Step 1: Port the prototype's race tests before implementation**

```ts
const REPLY_ID = "00000000-0000-4000-8000-000000000804";
const MEDIA_ID = "00000000-0000-4000-8000-000000000702";

it("ignores a late permission grant after reset", async () => {
  const device = deferredMediaDevice();
  const recorder = createRecorderController(device);
  const pending = recorder.start();
  recorder.reset();
  device.resolve(fakeStream());
  await pending;
  expect(recorder.snapshot().phase).toBe("idle");
  expect(device.stream.getTracks()[0].stop).toHaveBeenCalledOnce();
});

it("keeps replyTo when the recording is sent", () => {
  let state = audioReducer(recordedState, { type: "reply_attached", eventId: REPLY_ID });
  state = audioReducer(state, { type: "upload_started", mediaId: MEDIA_ID });
  state = audioReducer(state, { type: "complete_acknowledged" });
  expect(buildAudioMessage(state, "", [])).toEqual({
    type: "message.add", text: "", mentions: [], replyTo: REPLY_ID, mediaIds: [MEDIA_ID]
  });
});
```

- [ ] **Step 2: Confirm red tests**

Run: `cd learning-orbit && pnpm vitest run apps/web/src/media/audio-state.test.ts`  
Expected: FAIL because the recorder controller is absent.

- [ ] **Step 3: Implement an owned-session controller**

```ts
export class AudioRecorderController {
  private token = 0;
  private session: { token: number; stream: MediaStream; recorder: MediaRecorder; chunks: Blob[] } | null = null;
  async start(): Promise<void> {
    const token = ++this.token;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (token !== this.token) { stream.getTracks().forEach((track) => track.stop()); return; }
    const recorder = new MediaRecorder(stream);
    const session = { token, stream, recorder, chunks: [] as Blob[] };
    recorder.ondataavailable = (event) => { if (event.data.size > 0 && this.session?.token === token) session.chunks.push(event.data); };
    recorder.onstop = () => this.finish(session);
    this.session = session;
    recorder.start();
  }
  reset(): void {
    this.token += 1;
    const session = this.session;
    this.session = null;
    if (session?.recorder.state !== "inactive") session.recorder.stop();
    session?.stream.getTracks().forEach((track) => track.stop());
  }
}
```

- [ ] **Step 4: Implement honest unsupported and permission-denied UI**

`AudioAttachment` must preserve the native error class as a stable product code (`UNSUPPORTED`, `PERMISSION_DENIED`, `DEVICE_LOST`, `EMPTY_RECORDING`), show text/image alternatives, and never generate a fake transcript. The browser Blob URL is preview-only and must be revoked after upload, replacement, reset, or unmount. After `MediaRecorder` stops, it hashes the completed Blob with the same `sha256Blob` helper, sends hex `sha256` and actual byte length in the grant request, verifies the returned base64 checksum header, and uses the generated `requiredHeaders` unchanged for the exact Blob PUT. Reset/re-record invalidates both the recorder session token and hash/upload token; a late digest or grant response cannot revive the old recording. Once complete is acknowledged it contributes only its UUID to the same generated `message.add.mediaIds`; no audio-specific message payload exists.

- [ ] **Step 5: Run state, permission, and object-URL tests, then commit**

Run: `cd learning-orbit && pnpm vitest run apps/web/src/media/media-file-hash.test.ts apps/web/src/media/audio-state.test.ts apps/web/src/media/AudioAttachment.test.tsx`  
Expected: PASS with no leaked tracks or Object URLs, exact audio Blob checksum/header/body, and no network/state mutation after reset, re-record or late permission/hash resolution.  
Commit:

```bash
git add apps/web/src/media
git commit -m "feat(web): add race-safe audio recording and upload"
```

### Task 7: Validate message attachments, publish safe status frames, and render authorized views

**Files:**
- Create: `learning-orbit/packages/contracts/schemas/media-internal-outcome.v1.json`
- Modify: `learning-orbit/packages/contracts/src/index.ts`
- Generate: `learning-orbit/packages/contracts/src/generated/media-internal-outcome.v1.ts`
- Generate: `learning-orbit/services/worker/src/learning_orbit_worker/generated/media_internal_outcome_v1.py`
- Modify TypeScript manifest: `learning-orbit/packages/contracts/src/generated/manifest.json`
- Modify Python ingress manifest: `learning-orbit/services/worker/src/learning_orbit_worker/generated/manifest.json`
- Create: `learning-orbit/apps/server/src/modules/media/media-attachment-validator.ts`
- Modify: `learning-orbit/apps/server/src/modules/rooms/{attachment-validator,command-service}.ts`
- Create: `learning-orbit/apps/server/src/modules/media/media-status-service.ts`
- Create: `learning-orbit/apps/server/src/modules/media/internal-media-route.ts`
- Reuse unchanged: `learning-orbit/apps/server/src/modules/security/service-assertion.ts`
- Reuse unchanged: `learning-orbit/apps/server/src/modules/jobs/job-claim-authority.ts`
- Reuse unchanged: `learning-orbit/apps/server/src/modules/rooms/room-lock.ts`
- Modify: `learning-orbit/apps/server/src/modules/media/media-routes.ts`
- Modify: `learning-orbit/apps/server/src/app.ts`
- Modify: `learning-orbit/apps/server/src/realtime.ts`
- Test: `learning-orbit/apps/server/test/media/message-attachment-flow.test.ts`
- Test: `learning-orbit/apps/server/test/media/media-get.test.ts`
- Test: `learning-orbit/apps/server/test/media/media-status.test.ts`
- Test: `learning-orbit/services/worker/tests/test_media_outcome_contract.py`
- Modify: `learning-orbit/apps/web/src/chat/MessageCard.tsx`
- Create: `learning-orbit/apps/web/src/media/MediaAttachmentView.tsx`
- Test: `learning-orbit/apps/web/src/media/MediaAttachmentView.test.tsx`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://learning-orbit.local/schemas/media-internal-outcome.v1.json",
  "title": "MediaInternalOutcomeContract",
  "x-learning-orbit-python-ingress": true,
  "type": "object",
  "additionalProperties": false,
  "maxProperties": 0,
  "$defs": {
    "Derivative": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "mime", "sizeBytes", "sha256"],
      "properties": {
        "kind": { "enum": ["thumbnail", "sanitized_image", "playback_audio", "waveform"] },
        "mime": { "type": "string", "minLength": 1, "maxLength": 127 },
        "sizeBytes": { "type": "integer", "minimum": 1, "maximum": 26214400 },
        "sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" }
      }
    },
    "Request": {
      "type": "object",
      "additionalProperties": false,
      "required": ["jobId", "jobType", "roomId", "sourceEventId", "dedupeKey", "mediaId", "correlationId", "claimGeneration", "claimToken", "workerId", "transitionId", "state", "failureCode", "derivatives"],
      "properties": {
        "jobId": { "type": "string", "format": "uuid" },
        "jobType": { "const": "media.process.v1" },
        "roomId": { "type": "string", "format": "uuid" },
        "sourceEventId": { "type": "null" },
        "dedupeKey": { "type": "string", "pattern": "^media\\.process\\.v1:[0-9a-f-]{36}$" },
        "mediaId": { "type": "string", "format": "uuid" },
        "correlationId": { "type": "string", "format": "uuid" },
        "claimGeneration": { "type": "string", "pattern": "^[1-9][0-9]{0,18}$" },
        "claimToken": { "type": "string", "format": "uuid" },
        "workerId": { "type": "string", "minLength": 1, "maxLength": 128 },
        "transitionId": { "type": "string", "format": "uuid" },
        "state": { "enum": ["ready", "quarantined", "failed"] },
        "failureCode": { "type": ["string", "null"], "enum": [null, "MALWARE_DETECTED", "INVALID_MEDIA", "UNSUPPORTED_MEDIA", "PROCESSING_FAILED"] },
        "derivatives": { "type": "array", "items": { "$ref": "#/$defs/Derivative" }, "maxItems": 4, "uniqueItems": true }
      },
      "allOf": [
        { "if": { "properties": { "state": { "const": "ready" } }, "required": ["state"] }, "then": { "properties": { "failureCode": { "type": "null" }, "derivatives": { "minItems": 1 } } } },
        { "if": { "properties": { "state": { "const": "quarantined" } }, "required": ["state"] }, "then": { "properties": { "failureCode": { "const": "MALWARE_DETECTED" }, "derivatives": { "maxItems": 0 } } } },
        { "if": { "properties": { "state": { "const": "failed" } }, "required": ["state"] }, "then": { "properties": { "failureCode": { "enum": ["INVALID_MEDIA", "UNSUPPORTED_MEDIA", "PROCESSING_FAILED"] }, "derivatives": { "maxItems": 0 } } } }
      ]
    },
    "Response": {
      "oneOf": [
        { "type": "object", "additionalProperties": false, "required": ["status"], "properties": { "status": { "enum": ["applied", "already_applied"] } } },
        { "type": "object", "additionalProperties": false, "required": ["status", "code"], "properties": { "status": { "const": "rejected" }, "code": { "enum": ["SERVICE_ASSERTION_INVALID", "JOB_CLAIM_STALE", "MEDIA_OUTCOME_INVALID", "ROOM_DELETION_IN_PROGRESS"] } } }
      ]
    }
  }
}
```

The server derives every derivative object key from `(roomId,mediaId,kind)`; the internal wire schema intentionally has no object-key, URL, filename, byte-content or provider field. Generated-contract tests additionally reject duplicate derivative kinds even when the JSON objects differ in another safe field.

- [ ] **Step 1: Write the canonical command -> event -> replay test**

```ts
const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const OWNER_ID = "00000000-0000-4000-8000-000000000101";
const MEDIA_ID = "00000000-0000-4000-8000-000000000701";
const COMMAND_ID = "00000000-0000-4000-8000-000000000901";

it("persists attachment identity only in core message.added and replays it", async () => {
  await seedMedia({ mediaId: MEDIA_ID, roomId: ROOM_ID, ownerActorId: OWNER_ID, state: "uploaded" });
  await student.send({
    commandId: COMMAND_ID, roomId: ROOM_ID, type: "message.add", clientTime: "2026-08-28T09:12:00Z",
    payload: { text: "", mentions: [], replyTo: null, mediaIds: [MEDIA_ID] }
  });
  const committed = await eventByCausation(COMMAND_ID);
  expect(committed).toMatchObject({ type: "message.added", payload: { text: "", replyTo: null, mentions: [], mediaIds: [MEDIA_ID] } });
  expect(await countEventsLike(ROOM_ID, "media.%")).toBe(0);

  const replay = await student.get(routes.rooms.events(ROOM_ID, { afterSeq: 0, limit: 50 }));
  expect(replay.json().events.find((event) => event.causationId === COMMAND_ID).payload.mediaIds).toEqual([MEDIA_ID]);
});

it("binds one media asset to one logical message lineage even after retract",async()=>{const first=await addMessage({mediaIds:[MEDIA_ID]});expect(await retrySameCommand(first.commandId)).toMatchObject({eventId:first.eventId});expect(await bindingCount(MEDIA_ID)).toBe(1);expect(await mediaBinding(MEDIA_ID)).toMatchObject({messageId:first.payload.messageId,sourceEventId:first.eventId});expect((await addMessage({mediaIds:[MEDIA_ID]})).code).toBe("INVALID_COMMAND");await retractMessage(first.payload.messageId);expect((await addMessage({mediaIds:[MEDIA_ID]})).code).toBe("INVALID_COMMAND");expect(await eventCountForRejectedCommands()).toBe(0);});
```

The same test file submits another room's UUID, another member's UUID, `upload_pending`, `quarantined`, `failed`, and `deleted` assets and expects the same closed `INVALID_COMMAND` response with zero new `room_event` and `outbox_event` rows. It also proves the generated command schema rejects duplicates, non-UUIDs, and more than four media IDs. Only `uploaded`, `processing`, and `ready` are attachable.

- [ ] **Step 2: Inject the transaction-aware attachment validator at the application root**

```ts
export class MediaAttachmentValidator implements AttachmentValidator {
  async assertAttachable(tx: DbClient, principal: Principal, roomId: string, mediaIds: readonly string[]): Promise<void> {
    if (mediaIds.length === 0) return;
    const result = await tx.query(
      `SELECT media_id, room_id, owner_actor_id, state FROM media_asset
       WHERE media_id = ANY($1::uuid[]) FOR SHARE`,
      [mediaIds]
    );
    const attachable = new Set(["uploaded", "processing", "ready"]);
    const valid = result.rows.length === mediaIds.length && result.rows.every((row) =>
      row.room_id === roomId && row.owner_actor_id === principal.principalId && attachable.has(row.state)
    );
    if (!valid) throw invalidCommand();
  }

  async bind(
    tx: DbClient, roomId: string, messageId: string,
    sourceEventId: string, mediaIds: readonly string[]
  ): Promise<void> {
    if (mediaIds.length === 0) return;
    await tx.query(
      `INSERT INTO media_attachment_binding(media_id,room_id,message_id,source_event_id)
       SELECT media_id,$1,$2,$3 FROM unnest($4::uuid[]) AS media_id
       ON CONFLICT (media_id) DO NOTHING`,
      [roomId,messageId,sourceEventId,mediaIds]
    );
    const bound=await tx.query(
      `SELECT media_id,room_id,message_id,source_event_id
       FROM media_attachment_binding WHERE media_id=ANY($1::uuid[]) FOR SHARE`,
      [mediaIds]
    );
    if(bound.rowCount!==mediaIds.length || bound.rows.some((row)=>
      row.room_id!==roomId || row.message_id!==messageId || row.source_event_id!==sourceEventId
    )) throw invalidCommand();
  }
}
```

Construct `MediaAttachmentValidator` in `apps/server/src/app.ts` and inject it into Plan 01's single `CommandService`; do not create a media-specific message service. Extend Plan 01's default attachment interface with a no-op `bind(...)` method. Inside the one `RoomEventLedger.transact`, `CommandService` first calls `assertAttachable`, appends (or causation-dedupes) the core event, then calls `bind` with the server-owned logical `messageId` and committed `eventId`. The insert is idempotent only when every persisted tuple is byte-for-byte the same; a different message/source conflict raises the same closed `INVALID_COMMAND` and rolls the new event/outbox transaction back. Tests retry the same command and require one event/one binding, then use a new command/message and require rejection. Revisions retain the original binding and retractions never free a media ID for another message. The validator receives the exact transaction client used by `RoomEventLedger.transact`, so authorization/state validation, binding and the core `message.added` append succeed or roll back together. The resulting payload is exactly `{messageId,text,mentions,replyTo,mediaIds}` (plus only Plan 01's server-owned Agent provenance when applicable). Plan 02 registers no custom `media.*` event type. Plan 04's multimodal scheduler reads `media_attachment_binding.source_event_id`; it may not infer provenance by selecting the lowest currently active room event.

- [ ] **Step 3: Add the member-authenticated public GET and leakage tests**

```ts
it("returns only generated MediaAttachmentView from routes.media.get", async () => {
  const response = await student.get(routes.media.get(ROOM_ID, MEDIA_ID));
  expect(response.statusCode).toBe(200);
  expect(validateSchema("media-attachment-view.v1", response.json())).toEqual([]);
  for (const key of ["roomId", "ownerActorId", "objectKey", "signedUrl", "sha256", "promotionCorrelationId", "retentionClass", "deleteAt", "storageOrigin"])
    expect(response.json()).not.toHaveProperty(key);
  expect(await otherRoomStudent.get(routes.media.get(ROOM_ID, MEDIA_ID))).toMatchObject({ statusCode: 404 });
});

it("does not render internal room or owner identity", () => {
  const dom = render(<MediaAttachmentView media={publicReadyImage} sourceEventId="00000000-0000-4000-8000-000000000811" />);
  expect(dom.container.innerHTML).not.toContain(ROOM_ID);
  expect(dom.container.innerHTML).not.toContain(OWNER_ID);
});
```

Implement `GET routes.media.get(roomId, mediaId)` in `media-routes.ts`. It authenticates a current room member, scopes the internal lookup by the route room, whitelist-serializes `MediaAttachmentView`, validates the generated response schema, and returns 404 for missing membership, wrong room, or missing media without disclosing which predicate failed. It never returns a download grant. API tests inspect JSON keys; component tests scan rendered DOM/attributes and prove neither the fixed room UUID nor owner UUID appears.

- [ ] **Step 4: Run the red tests**

Run: `cd learning-orbit && pnpm vitest run apps/server/test/media/message-attachment-flow.test.ts apps/server/test/media/media-get.test.ts apps/server/test/media/media-status.test.ts apps/web/src/media/MediaAttachmentView.test.tsx`  
Expected before implementation: non-empty `mediaIds` are rejected by Plan 01's default validator, the generated GET/status-frame paths are absent, and the attachment component is absent.

- [ ] **Step 5: Commit outcomes and broadcast generated status frames after commit**

```ts
export async function applyMediaOutcome(deps: MediaStatusDeps, result: MediaOutcomeWithClaim): Promise<MediaAttachmentView> {
  const view = await deps.db.tx(async (tx) => {
    await deps.roomLocks.lockInTransaction(tx,result.roomId);
    await deps.rooms.lock(tx,result.roomId);
    const media = await deps.media.lockForOutcome(tx, result.mediaId, result.roomId);
    await deps.jobClaims.requireCurrent(tx, result.claim);
    if (media.outcomeTransitionId && media.outcomeTransitionId !== result.transitionId)
      throw new MediaError("OUTCOME_ALREADY_COMMITTED", 409);
    if (!media.outcomeTransitionId)
      await deps.media.applyOutcome(tx, media, result); // state, safe derivatives, failure code, transition UUID
    await deps.jobClaims.completeBusiness(tx, result.claim, "MEDIA_PROCESS_COMPLETED");
    return deps.media.serializeCurrent(tx, result.mediaId);
  });
  await deps.realtime.broadcastToAuthorizedRoom(result.roomId, parseRealtimeFrame({
    type: "media_status", mediaId: view.mediaId, state: view.state,
    failureCode: view.failureCode, updatedAt: view.updatedAt
  }));
  return view;
}
```

`media-internal-outcome.v1.json` freezes a closed request containing the complete signed claim tuple `jobId,jobType,roomId,sourceEventId,dedupeKey,correlationId,claimGeneration,claimToken,workerId`, plus `mediaId,transitionId,state,failureCode,derivatives`; `sourceEventId` is explicitly null for this family and each derivative is a closed safe metadata object with no bytes/URL. Its closed response is exactly `{status:"applied"|"already_applied"}` or `{status:"rejected",code:"SERVICE_ASSERTION_INVALID"|"JOB_CLAIM_STALE"|"MEDIA_OUTCOME_INVALID"|"ROOM_DELETION_IN_PROGRESS"}`. `internal-media-route.ts`, registered as `internal.media.outcome`, validates generated request/response, reuses Plan 01 `authorizeServiceAssertion`, and calls the service above. It injects Plan 01's canonical room lock and `JobClaimAuthority`; it contains no copied assertion/claim SQL. State/derivative metadata commits atomically only after the current-claim CAS; every cancellation path clears `claim_token/locked_at/locked_by`, so an old attempt cannot satisfy it. The closed `media_status` frame is sent only after commit and only to currently authorized room sockets. It is deliberately not a `RoomEvent`, has no `roomSeq`, and writes neither `room_event` nor `outbox_event`. A lost broadcast does not lose authority: a current reclaimed attempt retries the same transition idempotently and refresh/reconnect reads current state through `routes.media.get`. Tests reclaim a running media job immediately before each quarantined/failed/ready call, then require old-token raw outcome/derivative/frame counts stay zero, new-token retry applies once, unknown fields fail generated parsing, no room/owner/storage field is sent, and no frame can create an attachment absent from a confirmed message's `mediaIds`.

- [ ] **Step 6: Resolve confirmed message media on replay and render every state**

For initial load and every replay, extract and deduplicate UUIDs only from parsed core `message.added`/`message.revised` payloads, then fetch each through `routes.media.get(roomId, mediaId)`. `media_status` updates the matching cached state/failure code and may trigger a fresh GET, but never enters `EventLedger` or advances `roomSeq`. `MediaAttachmentView` accepts only generated `MediaAttachmentView` plus the confirmed source event UUID, renders processing/ready/quarantined/failed/deleted states, obtains a fresh download URL only after user activation, never places that URL in analytics/log/DOM attributes, renders alt/caption for images, uses native audio controls, and returns focus to the originating composer control after deletion.

- [ ] **Step 7: Run the chat/media integration suite and commit**

Run: `cd learning-orbit && pnpm contracts:generate && pnpm test:contracts && .venv/bin/python -m unittest services/worker/tests/test_media_outcome_contract.py -v && pnpm vitest run packages/contracts/test/media-contract.test.ts apps/server/test/media/message-attachment-flow.test.ts apps/server/test/media/media-get.test.ts apps/server/test/media/media-status.test.ts apps/web/src/chat apps/web/src/media`  
Expected: PASS; one canonical command produces and replays one core message event with identical `mediaIds`, a media ID cannot bind to a second logical message even after revise/retract, invalid ownership/state/binding rolls the transaction back, generated status frames update without room events, and missed frames recover through member-authenticated GET without room/owner leakage.  
Commit:

```bash
git add packages/contracts services/worker/src/learning_orbit_worker/generated services/worker/tests/test_media_outcome_contract.py apps/server/src/app.ts apps/server/src/realtime.ts apps/server/src/modules/media apps/server/src/modules/rooms/attachment-validator.ts apps/server/src/modules/rooms/command-service.ts apps/server/test/media apps/web/src/chat/MessageCard.tsx apps/web/src/media
git commit -m "feat(media): validate and render canonical message attachments"
```

### Task 8: Verify the media deletion hook, authorization, failure recovery, and responsive UX

**Files:**
- Create: `learning-orbit/apps/server/src/modules/media/media-room-deletion.ts`
- Create: `learning-orbit/apps/server/src/modules/media/media-lifecycle-store.ts`
- Create: `learning-orbit/apps/server/src/modules/media/media-deletion-manifest-port.ts`
- Modify: `learning-orbit/apps/server/src/modules/media/room-write-gate.ts`
- Modify: `learning-orbit/apps/server/src/modules/media/media-store.ts`
- Modify: `learning-orbit/apps/server/src/modules/media/s3-media-store.ts`
- Create: `learning-orbit/apps/server/test/lifecycle/media-surface-deletion-fixture.test.ts`
- Modify: `learning-orbit/apps/server/test/integration/s3-media-store.test.ts`
- Create: `learning-orbit/tests/e2e/media.spec.ts`
- Create: `learning-orbit/tests/e2e/fixtures/clean-image.png`
- Create: `learning-orbit/tests/e2e/fixtures/short-audio.webm`

- [ ] **Step 1: Write the media-surface deletion fixture test**

```ts
const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const DELETION_JOB_ID = "00000000-0000-4000-8000-000000000951";

it("gives the lifecycle owner an idempotent media deletion hook and unreadability probe", async () => {
  await syntheticDeletionManifest.freezeRoom(ROOM_ID, DELETION_JOB_ID);
  await deleteMediaForRoom(ROOM_ID, DELETION_JOB_ID);
  await deleteMediaForRoom(ROOM_ID, DELETION_JOB_ID);
  expect(await lifecycleStore.listRoomPrefix(ROOM_ID, testStoreControl(clock, 2_000))).toEqual([]);
  expect(await db.scalar("SELECT count(*)::int FROM media_asset WHERE room_id=$1", [ROOM_ID])).toBe(0);
  expect(await probeMediaUnreadability(ROOM_ID)).toEqual({ originals: 0, derivatives: 0, rows: 0, authorizedDownloads: 0, outstandingUploadGrants: 0, activeMediaWrites: 0 });
});

it("cannot close media while a previously signed PUT can still arrive", async () => {
  const grant = await issueUploadGrant({ roomId: ROOM_ID, maxUploadRequestMs: 120_000 });
  await syntheticDeletionManifest.freezeRoom(ROOM_ID, DELETION_JOB_ID);
  expect(await deleteMediaForRoom(ROOM_ID, DELETION_JOB_ID)).toMatchObject({ state: "retryable", code: "MEDIA_UPLOAD_GRANTS_NOT_QUIESCENT", notBefore: grant.writeNotAfter });
  await putThroughAlreadyIssuedUrl(grant.uploadUrl, cleanImageBytes);
  clock.advanceTo(grant.writeNotAfter);
  await deleteMediaForRoom(ROOM_ID, DELETION_JOB_ID);
  expect(await lifecycleStore.headAbsent(grant.objectKey, testStoreControl(clock, 2_000))).toBe(true);
  expect(await probeMediaUnreadability(ROOM_ID)).toMatchObject({ originals: 0, outstandingUploadGrants: 0, activeMediaWrites: 0 });
});
```

- [ ] **Step 2: Run it and confirm the media hook is absent**

Run: `cd learning-orbit && pnpm vitest run apps/server/test/lifecycle/media-surface-deletion-fixture.test.ts`  
Expected: FAIL because `deleteMediaForRoom` and its unreadability probe do not exist.

- [ ] **Step 3: Implement the idempotent media worker hook and probe**

```ts
export interface MediaLifecycleStore {
  listRoomPrefix(roomId: string, control: StoreCallControl): Promise<readonly string[]>;
  deleteExact(objectKeys: readonly string[], control: StoreCallControl): Promise<void>;
  deleteRoomPrefix(roomId: string, control: StoreCallControl): Promise<void>;
  headAbsent(objectKey: string, control: StoreCallControl): Promise<boolean>;
}
```

`media-lifecycle-store.ts` validates UUID room scope and rejects root/empty/arbitrary prefixes; only server lifecycle dependencies can construct it. Every method requires the same aborting deadline control as the normal store. The real S3 adapter implements paginated `ListObjectsV2` restricted to `rooms/{encodedRoomId}/`, exact/batched delete, prefix delete and strongly consistent exact HEAD with connect/socket/total timeouts. The browser/API surface exposes none of these methods. MinIO contract tests seed another room and bucket-root sentinel, then prove the lifecycle adapter lists/deletes only the requested room, releases deletion locks after timeout and never logs keys. Thus “never lists a bucket” means no root/unscoped/application/browser list; a reviewed server-only room-prefix list is explicitly required for deletion closure.

The lifecycle port contract suite calls every concrete and fixture adapter with a fresh injected-clock `testStoreControl`, then uses an unsafe cast only to prove that an omitted control fails with `STORE_CALL_CONTROL_REQUIRED` and an already-expired control fails with retryable `STORE_DEADLINE_EXCEEDED`; the production interface remains mandatory. A never-resolving lifecycle call must abort within its total deadline and release the deletion lock in `finally`.

`MediaDeletionManifestPort` freezes/reads only the media-surface record required by `deleteMediaForRoom(roomId,lifecycleOperationId)`. Task 8 supplies a clearly test-only in-memory/temporary-DB fixture and refuses to construct a production adapter; Plan 06 supplies the sole durable `deletion_*` implementation, exposes this TypeScript-owned hook through generated signed route `internal.lifecycle.mediaSurface`, and reruns this contract from the real Python lifecycle client. The fixture first takes the room media-write lock, prevents new grants/jobs, marks every issuing/active/promoted grant revoked at the application layer, and freezes every media ID, each grant's `grantId/objectKey/greatest(write_not_after,coalesce(promotion_write_not_after,write_not_after))`, every claimable/in-flight `media.process.v1` and `media.reconcile-upload.v1` raw job ID in `queued|retryable|running` selected by non-null `room_id`, and every active/uncertain `media_write_fence` ID/deadline. Original, sanitized-image, thumbnail, playback-audio and waveform keys follow closed deterministic templates derived from the frozen media ID; a crash-unregistered derivative is therefore still an exact probe target. Because an already signed PUT, ambiguous conditional copy or timed-out remote derivative write may not be revocable immediately, the hook returns a stable retryable quiescence code until the greatest frozen `writeNotAfter`; it never busy-waits. After that bound, under the same lock, it deletes every deterministic/frozen exact key plus the complete room original/derivative prefix, HEAD-probes all exact keys, confirms no active media job/write fence, closes/removes grant and write-fence ledgers in dependency order, and only then removes media rows. It uses the lifecycle operation UUID as its stable idempotency key—teacher deletion ID or retention job ID—and makes repeated delivery a no-op. Stores lacking the proven request-duration, post-abort settlement and exact-key HEAD semantics are not eligible for direct-upload pilot mode.

`probeMediaUnreadability(roomId)` checks the private prefix, every frozen exact key, derivative/original database rows, authorized download surface, outstanding upload-grant ledgers and active media writes, returning only counts/codes. It does not accept an empty current database join as proof; the injected frozen manifest is authoritative. This module does not create `deletion_job`, revoke sessions, delete `classroom_room`, coordinate analytics/Agent/cache/provider surfaces, or issue a deletion receipt; migration `005_pilot_governance.sql`, the production manifest adapter and global saga/receipt remain solely owned by Plan 06. Gate 2 proves the hook contract and store behavior, not real room deletion closure.

- [ ] **Step 4: Run the real-browser matrix**

Run: `cd learning-orbit && pnpm playwright test tests/e2e/media.spec.ts --project=chromium`  
Expected: PASS for image upload/cancel/retry, audio record/stop/delete/send, permission denial, canonical media-in-reply command→event→replay, processing→ready/quarantine status-frame updates, dropped-frame refresh recovery through `routes.media.get`, public JSON/DOM leakage probes, 1440×900 and 390×844 layouts, and keyboard-only operation.

- [ ] **Step 5: Run the complete Gate 2 suite and commit**

Run:

```bash
cd learning-orbit
source .venv/bin/activate
pnpm test:contracts
pnpm vitest run apps/server/test/media apps/server/test/lifecycle/media-surface-deletion-fixture.test.ts apps/web/src/media
python3.12 -m unittest discover -s services/worker/tests -v
pnpm playwright test tests/e2e/media.spec.ts
```

Expected: all commands PASS; no test logs contain signed URLs, media bytes, student captions, or raw audio.  
Commit:

```bash
git add apps/server/src/modules/media/media-room-deletion.ts apps/server/src/modules/media/media-lifecycle-store.ts apps/server/src/modules/media/media-deletion-manifest-port.ts apps/server/src/modules/media/room-write-gate.ts apps/server/src/modules/media/media-store.ts apps/server/src/modules/media/s3-media-store.ts apps/server/test/lifecycle/media-surface-deletion-fixture.test.ts apps/server/test/integration/s3-media-store.test.ts tests/e2e
git commit -m "test(media): close private media surface gate"
```

## Gate 2 release criteria

- Every media access is re-authorized by room membership; cross-room probes return 404.
- The suite runs inside Plan 01's activated Python 3.12 `.venv`; no system-Python alias or committed environment is assumed.
- Images require user-authored alt text before upload; server and database enforce it.
- Media uses private object keys and short-lived grants; no Data URL, Blob URL, or signed URL enters durable events or logs.
- Every example and runtime media/room/owner/message/command/transition ID is UUID-formatted across route parameters, SQL, fixtures, core event payloads, and status frames. Public `MediaAttachmentView` contains only `mediaId` identity: whitelist serializer, authenticated API, and DOM tests prove it never exposes `roomId`, `ownerActorId`, internal filenames/keys, hashes, retention/delete fields, storage origin, or signed URL.
- MinIO and ClamAV use officially sourced, vulnerability-reviewed immutable digests recorded in `infra/images.lock.json`; CI rejects `latest`, tag-only and unlocked refs. Health/readiness, private bucket initialization, narrow signed PUT/GET/HEAD CORS, and ffmpeg/ffprobe version audit pass before Worker tests.
- Browser grants use only configured browser-reachable HTTPS origins (explicit loopback in test); wrong origins fail. Bucket CORS permits only the exact web Origin, signed PUT and user-activated signed GET/HEAD with bounded headers, and never wildcard credentials, anonymous access or list operations.
- Finalize locks the owned media row. Only `upload_pending` stats and enqueues; identity-matching `uploaded`/`processing`/`ready` retries return the existing result; changed object identity conflicts; `quarantined`/`failed`/`deleted` reject stably. Concurrent finalize creates exactly one job, and duplicate Worker delivery creates exactly one derivative set.
- The first promotion intent is the immutable correlation authority. It creates one complete room-scoped, source-less reconcile row; direct HTTP retries and the signed internal reconciler both reuse that correlation, promotion copies it to `media_asset`, and process/reconcile adapters reject room/source/order/correlation drift before external I/O. Python delegates reconciliation to the TypeScript-only owner through the exact-audience internal route; it contains no second promotion state machine.
- Every Node and Python object-store/lifecycle call requires an absolute deadline and cancellation control. Boto connect/read/retry limits plus the supervised hard-total bound terminate a never-returning derivative helper, `finally` releases the room lock/connection, and an uncertain durable write fence delays the final deletion sweep through its frozen bound.
- Malware, corrupt media, empty recordings, unsupported browsers, denied permissions, upload aborts, and worker restarts have explicit states.
- Image/audio chat uses only Plan 01's generated `message.add {text,mentions,replyTo,mediaIds}` (maximum four). The application root injects the same-room, same-owner, attachable-state validator into the canonical transaction; tests prove command→core `message.added`→replay identity and atomic rejection.
- Plan 02 defines and registers no custom media message payload or `media.*` RoomEvent. Persisted outcome state is authoritative; generated text-free `media_status` frames update authorized sockets outside `RoomEvent`/`roomSeq`/outbox, and refresh/reconnect resolves each confirmed message UUID through member-authenticated `routes.media.get(roomId,mediaId)`.
- No `analytics.*` payload is registered here; Plan 03 analytics remain projection frames on their independent projection Outbox.
- Plan 02 closes only the media surface: `deleteMediaForRoom(roomId,deletionJobId)` is idempotent and cannot return verified before every frozen signed-upload window is quiescent, every media write is fenced, the final exact-key/prefix sweep passes, and the probe reports zero original/derivative objects, media rows, upload grants, active writes and authorized downloads. It creates no global job or receipt and makes no analytics/Agent/cache/provider deletion claim; Plan 06's migration `005_pilot_governance.sql` saga is the sole owner of cross-surface deletion, room teardown, and the success receipt.

## Non-goals

- No ASR, OCR, image understanding, face detection, voiceprint, emotion inference, or semantic graph extraction.
- No public media URLs or anonymous download links.
- No production pilot proceeds until Plan 06 binds each room to an approved retention policy and the school approves media consent; Plan 02 has no independent retention deadline.
