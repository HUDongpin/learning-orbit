import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseRoomEventEnvelope, teacherRoomExportContract } from "@learning-orbit/contracts";
import goldenEcho from "../../../../packages/test-fixtures/analytics/golden-echo-projection.json" with { type: "json" };
import goldenTrace from "../../../../packages/test-fixtures/analytics/golden-trace-projections.json" with { type: "json" };
import { GovernanceService } from "../../src/modules/governance/governance-service.js";

const roomId = "11111111-1111-4111-8111-111111111111";
const teacherId = "22222222-2222-4222-8222-222222222222";
const principal = { role: "teacher" as const, teacherId, actorId: teacherId };
const deletionJobId = "33333333-3333-4333-8333-333333333333";
const surfaces = [
  "agent_runs", "artifacts", "caches", "derivatives",
  "events", "media", "projections", "provider_copies",
] as const;

function fakePool() {
  const queries: string[] = [];
  let inserted = false;
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SELECT room_id, teacher_id, status")) return { rows: [{ room_id: roomId, teacher_id: teacherId, status: "open" }] };
      if (sql.includes("SELECT deletion_job_id")) return { rows: inserted ? [{ deletion_job_id: deletionJobId }] : [] };
      if (sql.includes("INSERT INTO deletion_job")) { inserted = true; return { rows: [{ deletion_job_id: deletionJobId }] }; }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(async () => client) } as any, queries };
}

describe("governance deletion service", () => {
  it("pre-authorizes only the owning teacher without turning the read into mutation authority", async () => {
    const query = vi.fn(async () => ({ rows: [{ exists: 1 }], rowCount: 1 }));
    const service = new GovernanceService({ query } as any, { auditSalt: "test-salt-01234567" });
    await expect(service.authorizeRoom(principal, roomId)).resolves.toEqual(principal);
    expect(query).toHaveBeenCalledWith(
      "SELECT 1 FROM classroom_room WHERE room_id=$1 AND teacher_id=$2",
      [roomId, teacherId],
    );

    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(service.authorizeRoom(principal, roomId))
      .rejects.toMatchObject({ statusCode: 404, code: "ROOM_NOT_FOUND" });
    const callsBeforeStudent = query.mock.calls.length;
    await expect(service.authorizeRoom({
      role: "student",
      roomId,
      roomMemberId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      pseudonym: "探索者 A",
      nova: {
        actorId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        actorKind: "agent",
        actorRole: "socratic_facilitator",
        displayName: "Nova Agent",
      },
    }, roomId)).rejects.toMatchObject({ statusCode: 404, code: "ROOM_NOT_FOUND" });
    expect(query).toHaveBeenCalledTimes(callsBeforeStudent);

    await expect(service.authorizeRoom(principal, "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"))
      .rejects.toMatchObject({ statusCode: 404, code: "ROOM_NOT_FOUND" });
    expect(query).toHaveBeenCalledTimes(callsBeforeStudent);
  });

  it("creates one content-free job and routes repeated requests to status recovery", async () => {
    const first = fakePool();
    const service = new GovernanceService(first.pool, { auditSalt: "test-salt-01234567" });
    const result = await service.requestDeletion(principal, roomId, { confirmation: `DELETE ${roomId}` });
    expect(result).toEqual({ deletionJobId, status: "queued" });
    await expect(service.requestDeletion(principal, roomId, { confirmation: `DELETE ${roomId}` }))
      .rejects.toMatchObject({ statusCode: 409, code: "DELETION_IN_PROGRESS" });
    expect(result).not.toHaveProperty("roomId");
    expect(first.queries.some((query) => query.includes("deletion_surface_manifest"))).toBe(true);
  });

  it("freezes review detail, projection heads, promotion rows and potential provider-backed records", async () => {
    const fixture = fakePool();
    const service = new GovernanceService(fixture.pool, { auditSalt: "test-salt-01234567" });
    await service.requestDeletion(principal, roomId, { confirmation: `DELETE ${roomId}` });

    const artifactProbe = fixture.queries.find((query) => query.includes("derived_text_artifact") && query.includes("count"));
    const projectionProbe = fixture.queries.find((query) => query.includes("analysis_projection_snapshots") && query.includes("count"));
    const providerProbe = fixture.queries.find((query) => query.includes("media_asset")
      && query.includes("agent_run") && query.includes("provider NOT IN ('learner-authored','teacher-correction')"));
    expect(artifactProbe).toContain("analytics_review_detail");
    expect(artifactProbe).toContain("extraction_artifacts");
    expect(projectionProbe).toContain("analysis_room_heads");
    expect(projectionProbe).toContain("student_analytics_promotion");
    expect(providerProbe).toBeDefined();
  });

  it("returns a completed receipt only when job and receipt timestamps agree", async () => {
    const completedAt = new Date("2026-08-31T01:02:03.000Z");
    const query = vi.fn(async () => ({ rows: [{
      deletion_job_id: deletionJobId,
      status: "completed",
      job_completed_at: completedAt,
      receipt_completed_at: completedAt,
      receipt_version: 1,
      surfaces_verified: [...surfaces],
    }] }));
    const service = new GovernanceService({ query } as any, { auditSalt: "test-salt-01234567" });

    await expect(service.deletionStatus(principal, deletionJobId)).resolves.toEqual({
      deletionJobId,
      status: "completed",
      receipt: {
        receiptVersion: 1,
        completedAt: completedAt.toISOString(),
        surfacesVerified: [...surfaces],
      },
    });
    expect(query.mock.calls[0]?.[0]).toContain("j.completed_at AS job_completed_at");
    expect(query.mock.calls[0]?.[0]).toContain("r.completed_at AS receipt_completed_at");
  });

  it("fails closed when completed job and receipt metadata disagree", async () => {
    const query = vi.fn(async () => ({ rows: [{
      deletion_job_id: deletionJobId,
      status: "completed",
      job_completed_at: new Date("2026-08-31T01:02:03.000Z"),
      receipt_completed_at: new Date("2026-08-31T01:02:04.000Z"),
      receipt_version: 1,
      surfaces_verified: [...surfaces],
    }] }));
    const service = new GovernanceService({ query } as any, { auditSalt: "test-salt-01234567" });

    await expect(service.deletionStatus(principal, deletionJobId)).rejects.toMatchObject({
      statusCode: 503,
      code: "DELETION_STATUS_CORRUPT",
    });
  });

  it("fails closed when an unfinished job already carries completion metadata", async () => {
    const query = vi.fn(async () => ({ rows: [{
      deletion_job_id: deletionJobId,
      status: "running",
      job_completed_at: null,
      receipt_completed_at: new Date("2026-08-31T01:02:03.000Z"),
      receipt_version: 1,
      surfaces_verified: [...surfaces],
    }] }));
    const service = new GovernanceService({ query } as any, { auditSalt: "test-salt-01234567" });

    await expect(service.deletionStatus(principal, deletionJobId)).rejects.toMatchObject({
      statusCode: 503,
      code: "DELETION_STATUS_CORRUPT",
    });
  });

  it("checks room ownership before export format and blocks deletion or expired retention", async () => {
    const fixture = (room: Record<string, unknown> | null) => {
      const client = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM classroom_room")) return { rows: room ? [room] : [], rowCount: room ? 1 : 0 };
          if (sql.includes("FROM room_event")) return { rows: [] };
          return { rows: [] };
        }),
        release: vi.fn(),
      };
      return { service: new GovernanceService({ connect: vi.fn(async () => client) } as any, { auditSalt: "test-salt-01234567" }), client };
    };

    const outsider = fixture(null);
    await expect(outsider.service.exportRoom(principal, roomId, { format: "not-a-format" }))
      .rejects.toMatchObject({ statusCode: 404, code: "ROOM_NOT_FOUND" });

    const deleting = fixture({ room_id: roomId, policy_current: true, deletion_active: true });
    await expect(deleting.service.exportRoom(principal, roomId, { format: "json" }))
      .rejects.toMatchObject({ statusCode: 410, code: "DELETION_IN_PROGRESS" });
    expect(deleting.client.query.mock.calls.some(([sql]) => String(sql).includes("FROM room_event"))).toBe(false);

    const expired = fixture({ room_id: roomId, policy_current: false, deletion_active: false });
    await expect(expired.service.exportRoom(principal, roomId, { format: "json" }))
      .rejects.toMatchObject({ statusCode: 410, code: "RETENTION_POLICY_EXPIRED" });
    expect(expired.client.query.mock.calls.some(([sql]) => String(sql).includes("FROM room_event"))).toBe(false);
  });

  it("refuses an export above the explicit event bound instead of truncating", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM classroom_room")) return { rows: [{ room_id: roomId, policy_current: true, deletion_active: false }] };
        if (sql.includes("FROM room_event")) return { rows: Array.from({ length: 10_001 }, () => ({})) };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const service = new GovernanceService({ connect: vi.fn(async () => client) } as any, { auditSalt: "test-salt-01234567" });
    await expect(service.exportRoom(principal, roomId, { format: "csv" }))
      .rejects.toMatchObject({ statusCode: 503, code: "EXPORT_UNAVAILABLE" });
  });

  it("fails closed on boolean database cursors instead of coercing them into room sequence one", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM classroom_room")) {
          return { rows: [{ room_id: roomId, policy_current: true, deletion_active: false }] };
        }
        if (sql.includes("FROM room_event")) return { rows: [{
          event_id: "44444444-4444-4444-8444-444444444449",
          room_id: roomId,
          room_seq: true,
          type: "room.opened",
          actor_id: teacherId,
          actor_kind: "human",
          actor_role: "teacher",
          revision: 1,
          operation: "add",
          event_time: new Date("2026-08-31T01:00:00.000Z"),
          ingest_time: new Date("2026-08-31T01:00:00.001Z"),
          causation_id: "66666666-6666-4666-8666-666666666669",
          correlation_id: "77777777-7777-4777-8777-777777777779",
          payload: { startsAt: "2026-08-31T01:00:00.000Z", closesAt: "2026-08-31T01:45:00.000Z" },
        }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const service = new GovernanceService(
      { connect: vi.fn(async () => client) } as any,
      { auditSalt: "test-salt-01234567" },
    );

    await expect(service.exportRoom(principal, roomId, { format: "json" }))
      .rejects.toMatchObject({ statusCode: 503, code: "EXPORT_UNAVAILABLE" });
  });

  it("commits a content-free export audit in the same transaction", async () => {
    const privateText = "只應存在於匯出內容";
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM classroom_room")) return { rows: [{ room_id: roomId, policy_current: true, deletion_active: false }] };
        if (sql.includes("FROM room_event")) return { rows: [{
          event_id: "44444444-4444-4444-8444-444444444444",
          room_id: roomId,
          room_seq: "1",
          type: "message.added",
          actor_id: "55555555-5555-4555-8555-555555555555",
          actor_kind: "human",
          actor_role: "student",
          revision: 1,
          operation: "add",
          event_time: new Date("2026-08-31T01:00:00.000Z"),
          ingest_time: new Date("2026-08-31T01:00:01.000Z"),
          causation_id: "66666666-6666-4666-8666-666666666666",
          correlation_id: "77777777-7777-4777-8777-777777777777",
          payload: {
            messageId: "88888888-8888-4888-8888-888888888888",
            text: privateText,
            replyTo: null,
            mentions: [],
            mediaIds: [],
          },
        }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const service = new GovernanceService({ connect: vi.fn(async () => client) } as any, { auditSalt: "test-salt-01234567" });

    const exported = await service.exportRoom(principal, roomId, { format: "json" });
    expect(exported.body).toContain(privateText);
    const exportedRoom = teacherRoomExportContract.parse(JSON.parse(exported.body));
    expect(exportedRoom).toMatchObject({
      schemaVersion: 1,
      exportKind: "teacher_room",
      roomId,
      throughRoomSeq: 1,
      artifacts: [],
      projections: [],
      provenance: { artifactSources: [], projectionSources: [] },
    });
    expect(exportedRoom.events).toEqual([
      expect.objectContaining({ schemaVersion: 1, roomId, roomSeq: 1 }),
    ]);
    expect(parseRoomEventEnvelope(exportedRoom.events[0])).toMatchObject({ roomId, roomSeq: 1 });
    expect(exported.filename).toBe("learning-orbit-room-export.json");
    expect(exported.filename).not.toContain(roomId.slice(0, 8));
    const auditCall = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO security_audit_event"));
    expect(auditCall?.[1]).toEqual(expect.arrayContaining(["teacher", "export.request", "allowed", "EXPORT_COMPLETED"]));
    expect(JSON.stringify(auditCall?.[1])).not.toContain(privateText);
    expect(JSON.stringify(auditCall?.[1])).not.toContain(exported.filename);
  });

  it("exports approved artifacts, teacher projections, and closed provenance through one strict document", async () => {
    const eventRows = [
      {
        event_id: "44444444-4444-4444-8444-444444444441",
        room_id: roomId, room_seq: "1", type: "message.added",
        actor_id: "55555555-5555-4555-8555-555555555551",
        actor_kind: "human", actor_role: "student", revision: 1, operation: "add",
        event_time: new Date("2026-08-31T01:00:00.000Z"), ingest_time: new Date("2026-08-31T01:00:00.001Z"),
        causation_id: "66666666-6666-4666-8666-666666666661",
        correlation_id: "77777777-7777-4777-8777-777777777771",
        payload: {
          messageId: "88888888-8888-4888-8888-888888888881",
          text: "太陽提供能量給生產者。", replyTo: null, mentions: [], mediaIds: [],
        },
      },
      {
        event_id: "44444444-4444-4444-8444-444444444442",
        room_id: roomId, room_seq: "2", type: "room.opened",
        actor_id: teacherId, actor_kind: "human", actor_role: "teacher", revision: 1, operation: "add",
        event_time: new Date("2026-08-31T01:01:00.000Z"), ingest_time: new Date("2026-08-31T01:01:00.001Z"),
        causation_id: "66666666-6666-4666-8666-666666666662",
        correlation_id: "77777777-7777-4777-8777-777777777772",
        payload: { startsAt: "2026-08-31T01:01:00.000Z", closesAt: "2026-08-31T01:46:00.000Z" },
      },
      {
        event_id: "44444444-4444-4444-8444-444444444443",
        room_id: roomId, room_seq: "3", type: "room.paused",
        actor_id: teacherId, actor_kind: "human", actor_role: "teacher", revision: 1, operation: "add",
        event_time: new Date("2026-08-31T01:02:00.000Z"), ingest_time: new Date("2026-08-31T01:02:00.001Z"),
        causation_id: "66666666-6666-4666-8666-666666666663",
        correlation_id: "77777777-7777-4777-8777-777777777773",
        payload: { pausedAt: "2026-08-31T01:02:00.000Z" },
      },
      {
        event_id: "44444444-4444-4444-8444-444444444444",
        room_id: roomId, room_seq: "4", type: "analytics.review.recorded.v1",
        actor_id: teacherId, actor_kind: "human", actor_role: "teacher", revision: 1, operation: "add",
        event_time: new Date("2026-08-31T01:03:00.000Z"), ingest_time: new Date("2026-08-31T01:03:00.001Z"),
        causation_id: "66666666-6666-4666-8666-666666666664",
        correlation_id: "77777777-7777-4777-8777-777777777774",
        payload: { changeKind: "review" },
      },
      {
        event_id: "44444444-4444-4444-8444-444444444445",
        room_id: roomId, room_seq: "5", type: "room.closed",
        actor_id: teacherId, actor_kind: "human", actor_role: "teacher", revision: 1, operation: "add",
        event_time: new Date("2026-08-31T01:04:00.000Z"), ingest_time: new Date("2026-08-31T01:04:00.001Z"),
        causation_id: "66666666-6666-4666-8666-666666666665",
        correlation_id: "77777777-7777-4777-8777-777777777775",
        payload: { closedAt: "2026-08-31T01:04:00.000Z" },
      },
    ];
    const echo = { ...structuredClone(goldenEcho), roomId };
    const trace = { ...structuredClone(goldenTrace.teacher), roomId };
    const projectionRow = (projection: typeof echo | typeof trace) => ({
      room_id: roomId,
      projection_key: projection.projectionKey,
      analysis_epoch: projection.analysisEpoch,
      version: String(projection.projectionVersion),
      base_version: String(projection.baseVersion),
      complete_through_seq: String(projection.completeThroughRoomSeq),
      watermark_event_time: new Date(projection.watermarkEventTime),
      algorithm_version: projection.algorithmVersion,
      parameter_hash: projection.parameterHash,
      requires_replay: projection.requiresReplay,
      algorithm: projection.projectionKey.startsWith("echo.") ? "ECHO-CM" : "TRACE-AI",
      schema_version: 1,
      warnings: projection.warnings,
      warnings_sha256: createHash("sha256").update(JSON.stringify(projection.warnings)).digest("hex"),
      payload: projection.payload,
      created_at: new Date("2026-08-31T01:05:00.000Z"),
    });
    const client = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        if (sql.includes("FROM classroom_room")) {
          return { rows: [{ room_id: roomId, policy_current: true, deletion_active: false }] };
        }
        if (sql.includes("FROM room_event")) return { rows: eventRows };
        if (sql.includes("FROM derived_text_artifact")) return { rows: [{
          artifact_id: "99999999-9999-4999-8999-999999999991",
          lineage_id: "99999999-9999-4999-8999-999999999992",
          room_id: roomId,
          event_id: eventRows[0]!.event_id,
          room_seq: "1",
          source_media_id: null,
          source_modality: "text",
          derivation: "direct",
          text_content: "太陽提供能量給生產者。",
          language_tag: "zh-Hant",
          review_status: "approved",
          supersedes_artifact_id: null,
          created_at: new Date("2026-08-31T01:00:01.000Z"),
          provider_secret: "must-not-export",
        }] };
        if (sql.includes("FROM analysis_projection_snapshots")) {
          return { rows: [projectionRow(values?.[1] === "echo.teacher_shadow" ? echo : trace)] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const service = new GovernanceService(
      { connect: vi.fn(async () => client) } as any,
      { auditSalt: "test-salt-01234567" },
    );

    const result = await service.exportRoom(principal, roomId, { format: "json" });
    const document = teacherRoomExportContract.parse(JSON.parse(result.body));
    expect(document.artifacts).toHaveLength(1);
    expect(document.projections.map(({ projectionKey }) => projectionKey)).toEqual([
      "echo.teacher_shadow", "trace.teacher_bundle",
    ]);
    expect(document.provenance.artifactSources).toHaveLength(1);
    expect(document.provenance.projectionSources).toHaveLength(2);
    expect(result.body).not.toContain("must-not-export");
    expect(result.body).not.toContain("sourceConfidence");
  });

  it("removes URLs, secrets and provider payloads from exports", () => {
    const service = new GovernanceService({} as any, { auditSalt: "test-salt-01234567" });
    expect(service.sanitizeExport({ text: "可匯出的訊息", uploadUrl: "https://secret", apiKey: "secret", providerPayload: { raw: "secret" } })).toEqual({ text: "可匯出的訊息" });
  });
});
