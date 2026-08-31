import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AnalyticsTeacherError, AnalyticsTeacherService } from "../../src/modules/analytics/analytics-teacher-service.js";

const roomId = "00000000-0000-4000-8000-000000000010";
const teacherId = "00000000-0000-4000-8000-000000000011";
const epoch = "00000000-0000-4000-8000-000000000012";
const artifactId = "00000000-0000-4000-8000-000000000013";
const eventId = "00000000-0000-4000-8000-000000000014";

const teacher = { role: "teacher", teacherId, actorId: teacherId } as const;
const artifactRow = {
  artifact_id: artifactId, lineage_id: "00000000-0000-4000-8000-000000000015",
  room_id: roomId, event_id: eventId, room_seq: "1", source_media_id: null,
  source_modality: "text", derivation: "direct", text_content: "太陽提供能量給生產者。",
  normalized_text_sha256: "a".repeat(64), source_confidence_raw: 1,
  source_confidence_calibrated: null, provider: "learner-authored", model_version: "direct-text-v1",
  language_tag: "zh-Hant", spans: [], review_status: "unreviewed", display_status: "hidden",
  warnings: [], supersedes_artifact_id: null, active: true, created_at: new Date("2026-08-28T09:00:00Z"),
};

function projectionRow(payload: unknown) {
  const warnings: string[] = [];
  return {
    room_id: roomId,
    projection_key: "echo.teacher_shadow",
    analysis_epoch: epoch,
    version: "1",
    base_version: "0",
    complete_through_seq: "1",
    watermark_event_time: new Date("2026-08-28T09:00:00.000Z"),
    algorithm_version: "echo-v1",
    parameter_hash: "b".repeat(64),
    requires_replay: false,
    algorithm: "ECHO-CM",
    schema_version: 1,
    warnings,
    warnings_sha256: createHash("sha256").update(JSON.stringify(warnings)).digest("hex"),
    payload,
    created_at: new Date("2026-08-28T09:00:01.000Z"),
  };
}

function service(listRow: unknown = artifactRow) {
  const transactionQuery = vi.fn(async (sql: string) => {
    if (sql.includes("FROM deletion_job")) return { rowCount: 0, rows: [] };
    if (sql.includes("pilot_retention_policy")) return { rows: [{ policy_current: true }] };
    if (sql.includes("FROM derived_text_artifact WHERE")) {
      return { rowCount: 1, rows: [listRow] };
    }
    return { rowCount: 0, rows: [] };
  });
  const transactionClient = { query: transactionQuery, release: vi.fn() };
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [artifactRow] }),
    connect: vi.fn(async () => transactionClient),
  } as any;
  const policy = { requireRoomAccess: vi.fn().mockResolvedValue({ roomId, role: "teacher", studentProjectionAllowlist: new Set() }) } as any;
  const events = { transact: vi.fn() } as any;
  return {
    svc: new AnalyticsTeacherService(pool, events, policy),
    pool,
    policy,
    events,
    transactionQuery,
  };
}

describe("teacher analytics surfaces", () => {
  it("returns a schema-validated active artifact page with a bounded cursor", async () => {
    const { svc, policy, transactionQuery } = service();
    const page = await svc.listArtifacts(teacher, "00000000-0000-4000-8000-000000000016", roomId, {
      includeHistory: false, limit: 20,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.artifactId).toBe(artifactId);
    expect(page.includeHistory).toBe(false);
    expect(policy.requireRoomAccess).toHaveBeenCalledWith(teacher, roomId, "latest", expect.any(String));
    const artifactQuery = transactionQuery.mock.calls.find(([sql]) => sql.includes("FROM derived_text_artifact WHERE"));
    expect(artifactQuery?.[0]).toContain("review_status=$2");
    expect(artifactQuery?.[1]).toEqual([roomId, "unreviewed", 21]);
  });

  it("rechecks the retention policy inside the locked artifact-list transaction", async () => {
    const { svc, transactionQuery } = service();
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM deletion_job")) return { rowCount: 0, rows: [] };
      if (sql.includes("pilot_retention_policy")) return { rows: [{ policy_current: false }] };
      if (sql.includes("FROM derived_text_artifact WHERE")) {
        return { rowCount: 1, rows: [artifactRow] };
      }
      return { rowCount: 0, rows: [] };
    });

    await expect(svc.listArtifacts(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      roomId,
      { includeHistory: false, limit: 20 },
    )).rejects.toMatchObject({ statusCode: 410, code: "RETENTION_POLICY_EXPIRED" });
    expect(transactionQuery.mock.calls.some(([sql]) => String(sql).includes("FROM derived_text_artifact WHERE")))
      .toBe(false);
  });

  it("rechecks the retention policy inside the locked review-detail transaction", async () => {
    const { svc, transactionQuery } = service();
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM deletion_job")) return { rowCount: 0, rows: [] };
      if (sql.includes("pilot_retention_policy")) return { rows: [{ policy_current: false }] };
      if (sql.includes("FROM analytics_review_detail")) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });

    await expect(svc.reviewDetail(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      roomId,
      "00000000-0000-4000-8000-000000000017",
    )).rejects.toMatchObject({ statusCode: 410, code: "RETENTION_POLICY_EXPIRED" });
    expect(transactionQuery.mock.calls.some(([sql]) => String(sql).includes("FROM analytics_review_detail")))
      .toBe(false);
  });

  it("rejects duplicate query values instead of coercing arrays into SQL parameters", async () => {
    const { svc, pool } = service();
    await expect(svc.listArtifacts(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      roomId,
      { reviewStatus: ["unreviewed"] },
    )).rejects.toMatchObject({ statusCode: 400, code: "INVALID_ANALYTICS_QUERY" });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("hides room ownership before parsing malformed artifact or review inputs", async () => {
    const { svc, pool, policy, events } = service();
    policy.requireRoomAccess.mockRejectedValue(new AnalyticsTeacherError(404, "ROOM_NOT_FOUND"));

    await expect(svc.listArtifacts(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      roomId,
      { reviewStatus: ["invalid"] },
    )).rejects.toMatchObject({ statusCode: 404, code: "ROOM_NOT_FOUND" });
    await expect(svc.review(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      roomId,
      { notACommand: true },
    )).rejects.toMatchObject({ statusCode: 404, code: "ROOM_NOT_FOUND" });
    await expect(svc.reviewDetail(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      roomId,
      "not-a-review-id",
    )).rejects.toMatchObject({ statusCode: 404, code: "ROOM_NOT_FOUND" });
    expect(pool.query).not.toHaveBeenCalled();
    expect(events.transact).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical uppercase room UUID before deriving review identity", async () => {
    const { svc, events } = service();
    await expect(svc.review(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      {},
    )).rejects.toMatchObject({ statusCode: 400, code: "INVALID_ANALYTICS_QUERY" });
    expect(events.transact).not.toHaveBeenCalled();
  });

  it("hides every teacher-only analytics surface from a student role", async () => {
    const { svc, pool, policy, events } = service();
    const student = {
      role: "student" as const,
      roomId,
      roomMemberId: "00000000-0000-4000-8000-000000000031",
      actorId: "00000000-0000-4000-8000-000000000032",
      pseudonym: "探索者 A",
      nova: {
        actorId: "00000000-0000-4000-8000-000000000033",
        actorKind: "agent" as const,
        actorRole: "socratic_facilitator" as const,
        displayName: "Nova Agent",
      },
    };
    await expect(svc.listArtifacts(student, "00000000-0000-4000-8000-000000000016", roomId, {}))
      .rejects.toMatchObject({ statusCode: 404, code: "ROOM_NOT_FOUND" });
    await expect(svc.review(student, "00000000-0000-4000-8000-000000000016", roomId, {}))
      .rejects.toMatchObject({ statusCode: 404, code: "ROOM_NOT_FOUND" });
    await expect(svc.reviewDetail(student, "00000000-0000-4000-8000-000000000016", roomId, artifactId))
      .rejects.toMatchObject({ statusCode: 404, code: "ROOM_NOT_FOUND" });
    expect(policy.requireRoomAccess).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(events.transact).not.toHaveBeenCalled();
  });

  it("appends a content-free review notice and replay authority atomically", async () => {
    const { svc, events } = service();
    const command = {
      targetType: "derived_text", targetId: artifactId, decision: "approve", rationale: "可追溯至原始文字。",
      expectedAnalysisEpoch: epoch, expectedProjectionVersion: 1,
    } as const;
    const closedClient = { query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM deletion_job")) return { rowCount: 0, rows: [] };
      if (sql.includes("pilot_retention_policy")) return { rows: [{ policy_current: true }] };
      return { rowCount: 0, rows: [] };
    }) };
    events.transact.mockImplementationOnce(async (_room: string, work: any) => work({
      client: closedClient,
      room: { next_room_seq: 2, teacher_id: teacherId, status: "closed" },
    }));
    await expect(svc.review(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      roomId,
      command,
    )).rejects.toMatchObject({ statusCode: 409, code: "ROOM_NOT_OPEN" });
    expect(closedClient.query).not.toHaveBeenCalled();

    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM deletion_job")) return { rowCount: 0, rows: [] };
      if (sql.includes("pilot_retention_policy")) return { rows: [{ policy_current: true }] };
      if (sql.includes("SELECT analysis_epoch,version,complete_through_seq")) return { rows: [{ analysis_epoch: epoch, version: "1", complete_through_seq: "1", requires_replay: false }] };
      if (sql.includes("derived_text_artifact")) return { rowCount: 1, rows: [{}] };
      return { rowCount: 1, rows: [] };
    }) };
    events.transact.mockImplementation(async (_room: string, work: any) => work({
      client,
      room: { next_room_seq: 2, teacher_id: teacherId, status: "open" },
      append: async () => ({ eventId: "00000000-0000-4000-8000-000000000017", roomSeq: 2, correlationId: "00000000-0000-4000-8000-000000000018" }),
    }));
    const result = await svc.review(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      roomId,
      command,
    );
    expect(result.changeKind).toBe("review");
    expect(result.reviewEventId).toBe("00000000-0000-4000-8000-000000000017");
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("analytics_review_detail"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("analytics_replay_request"))).toBe(true);
    const retry = await svc.review(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      roomId,
      command,
    );
    expect(retry).toEqual(result);
    expect(events.transact).toHaveBeenCalledTimes(3);
  });

  it("fails closed when an artifact row has a non-boolean active flag", async () => {
    const { svc } = service({ ...artifactRow, active: "false" });
    await expect(svc.listArtifacts(teacher, "00000000-0000-4000-8000-000000000016", roomId, {
      includeHistory: false, limit: 20,
    })).rejects.toMatchObject({ statusCode: 503, code: "ANALYTICS_CORRUPT" } satisfies Partial<AnalyticsTeacherError>);
  });

  it("resolves an identical retry even after the projection head has moved", async () => {
    const { svc, pool, events } = service();
    const existingEvent = {
      eventId: "00000000-0000-4000-8000-000000000017",
      roomSeq: 2,
      correlationId: "00000000-0000-4000-8000-000000000018",
      type: "analytics.review.recorded.v1",
      actorId: teacherId,
      actorKind: "human",
      actorRole: "teacher",
    };
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM deletion_job")) return { rowCount: 0, rows: [] };
      if (sql.includes("pilot_retention_policy")) return { rows: [{ policy_current: true }] };
      return { rowCount: 1, rows: [] };
    }) };
    events.transact.mockImplementationOnce(async (_room: string, work: any) => work({
      client,
      room: { next_room_seq: 3, teacher_id: teacherId },
      findByCausation: async () => existingEvent,
    }));
    pool.query.mockResolvedValueOnce({ rows: [{ job_id: "00000000-0000-4000-8000-000000000019" }] });
    const input = {
      targetType: "derived_text", targetId: artifactId, decision: "approve", rationale: "可追溯至原始文字。",
      expectedAnalysisEpoch: epoch, expectedProjectionVersion: 1,
    };
    const result = await svc.review(teacher, "00000000-0000-4000-8000-000000000016", roomId, input);
    expect(result.reviewEventId).toBe(existingEvent.eventId);
    expect(result.created).toBe(false);
    expect(result.replayJobId).toBe("00000000-0000-4000-8000-000000000019");
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("analysis_room_heads"))).toBe(false);
  });

  it("reserves one projection authority until replay advances the room cursor", async () => {
    const { svc, events } = service();
    let nextRoomSeq = 2;
    const append = vi.fn(async () => {
      const roomSeq = nextRoomSeq;
      nextRoomSeq += 1;
      return {
        eventId: `00000000-0000-4000-8000-${String(roomSeq).padStart(12, "0")}`,
        roomSeq,
        correlationId: "00000000-0000-4000-8000-000000000018",
      };
    });
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM deletion_job")) return { rowCount: 0, rows: [] };
      if (sql.includes("pilot_retention_policy")) return { rows: [{ policy_current: true }] };
      if (sql.includes("SELECT analysis_epoch,version,complete_through_seq")) {
        return { rows: [{ analysis_epoch: epoch, version: "1", complete_through_seq: "1", requires_replay: false }] };
      }
      if (sql.includes("derived_text_artifact")) return { rowCount: 1, rows: [{}] };
      return { rowCount: 1, rows: [] };
    }) };
    events.transact.mockImplementation(async (_room: string, work: any) => work({
      client,
      room: { next_room_seq: nextRoomSeq, teacher_id: teacherId },
      findByCausation: async () => null,
      append,
    }));
    const command = {
      targetType: "derived_text",
      targetId: artifactId,
      decision: "approve",
      rationale: "第一個不可變審閱事實。",
      expectedAnalysisEpoch: epoch,
      expectedProjectionVersion: 1,
    } as const;

    await expect(svc.review(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      roomId,
      command,
    )).resolves.toMatchObject({ created: true, changeKind: "review" });
    await expect(svc.review(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      roomId,
      { ...command, rationale: "同一舊 authority 的第二個不同事實。" },
    )).rejects.toMatchObject({ statusCode: 409, code: "ANALYTICS_VERSION_CONFLICT" });
    expect(append).toHaveBeenCalledOnce();
  });

  it("rejects a projection head that is explicitly waiting for replay", async () => {
    const { svc, events } = service();
    const append = vi.fn(async () => ({
      eventId: "00000000-0000-4000-8000-000000000051",
      roomSeq: 2,
      correlationId: "00000000-0000-4000-8000-000000000052",
    }));
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM deletion_job")) return { rowCount: 0, rows: [] };
      if (sql.includes("pilot_retention_policy")) return { rows: [{ policy_current: true }] };
      if (sql.includes("SELECT analysis_epoch,version,complete_through_seq")) {
        return { rows: [{
          analysis_epoch: epoch,
          version: "1",
          complete_through_seq: "1",
          requires_replay: true,
        }] };
      }
      if (sql.includes("derived_text_artifact")) return { rowCount: 1, rows: [{}] };
      return { rowCount: 1, rows: [] };
    }) };
    events.transact.mockImplementation(async (_room: string, work: any) => work({
      client,
      room: { next_room_seq: 2, teacher_id: teacherId },
      findByCausation: async () => null,
      append,
    }));

    await expect(svc.review(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      roomId,
      {
        targetType: "derived_text",
        targetId: artifactId,
        decision: "approve",
        rationale: "等待 Replay 的 Projection 不可成為審閱權威。",
        expectedAnalysisEpoch: epoch,
        expectedProjectionVersion: 1,
      },
    )).rejects.toMatchObject({ statusCode: 409, code: "ANALYTICS_VERSION_CONFLICT" });
    expect(append).not.toHaveBeenCalled();
  });

  it("fails closed when the locked head and validated snapshot disagree on the room cursor", async () => {
    const { svc, events } = service();
    const append = vi.fn(async () => ({
      eventId: "00000000-0000-4000-8000-000000000053",
      roomSeq: 2,
      correlationId: "00000000-0000-4000-8000-000000000054",
    }));
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM deletion_job")) return { rowCount: 0, rows: [] };
      if (sql.includes("pilot_retention_policy")) return { rows: [{ policy_current: true }] };
      if (sql.includes("SELECT analysis_epoch,version,complete_through_seq")) {
        return { rows: [{
          analysis_epoch: epoch,
          version: "1",
          complete_through_seq: "1",
          requires_replay: false,
        }] };
      }
      if (sql.includes("analysis_projection_snapshots")) {
        return { rows: [{
          ...projectionRow({
            nodes: ["producer", "plant"].map((nodeId, index) => ({
              nodeId,
              label: nodeId,
              nodeKind: "concept",
              evidenceStatus: "supported",
              reviewStatus: "unreviewed",
              displayStatus: "provisional",
              position: { x: 0.25 + index * 0.5, y: 0.5 },
            })),
            edges: [],
          }),
          complete_through_seq: "0",
        }] };
      }
      return { rowCount: 1, rows: [] };
    }) };
    events.transact.mockImplementation(async (_room: string, work: any) => work({
      client,
      room: { next_room_seq: 2, teacher_id: teacherId },
      findByCausation: async () => null,
      append,
    }));

    await expect(svc.review(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      roomId,
      {
        correctionKind: "split_alias",
        targetCanonicalNodeId: "producer",
        replacement: { aliasNodeId: "plant", newCanonicalNodeId: "new-node", newLabel: "新概念" },
        reason: "Snapshot 游標必須與鎖定的 Head 完全一致。",
        expectedAnalysisEpoch: epoch,
        expectedProjectionVersion: 1,
      },
    )).rejects.toMatchObject({ statusCode: 503, code: "ANALYTICS_CORRUPT" });
    expect(append).not.toHaveBeenCalled();
  });

  it("rechecks the retention policy after acquiring the canonical room transaction lock", async () => {
    const { svc, events } = service();
    const append = vi.fn(async () => ({
      eventId: "00000000-0000-4000-8000-000000000055",
      roomSeq: 2,
      correlationId: "00000000-0000-4000-8000-000000000056",
    }));
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM deletion_job")) return { rowCount: 0, rows: [] };
      if (sql.includes("pilot_retention_policy")) return { rows: [{ policy_current: false }] };
      if (sql.includes("SELECT analysis_epoch,version,complete_through_seq")) {
        return { rows: [{
          analysis_epoch: epoch,
          version: "1",
          complete_through_seq: "1",
          requires_replay: false,
        }] };
      }
      if (sql.includes("derived_text_artifact")) return { rowCount: 1, rows: [{}] };
      return { rowCount: 1, rows: [] };
    }) };
    events.transact.mockImplementation(async (_room: string, work: any) => work({
      client,
      room: { next_room_seq: 2, teacher_id: teacherId },
      findByCausation: async () => null,
      append,
    }));

    await expect(svc.review(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      roomId,
      {
        targetType: "derived_text",
        targetId: artifactId,
        decision: "approve",
        rationale: "交易開始時保留政策已經過期。",
        expectedAnalysisEpoch: epoch,
        expectedProjectionVersion: 1,
      },
    )).rejects.toMatchObject({ statusCode: 410, code: "RETENTION_POLICY_EXPIRED" });
    expect(append).not.toHaveBeenCalled();
  });

  it("allows undo_merge only while the original merge is still effective and not already undone", async () => {
    const { svc, pool, events } = service();
    const mergeEventId = "00000000-0000-4000-8000-000000000021";
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM deletion_job")) return { rowCount: 0, rows: [] };
      if (sql.includes("pilot_retention_policy")) return { rows: [{ policy_current: true }] };
      if (sql.includes("SELECT analysis_epoch,version,complete_through_seq")) return { rows: [{ analysis_epoch: epoch, version: "1", complete_through_seq: "1", requires_replay: false }] };
      if (sql.includes("validated_payload") && sql.includes("review_event_id=$2")) {
        return { rows: [{ room_seq: "1", validated_payload: {
          correctionKind: "merge_alias",
          targetCanonicalNodeId: "producer",
          replacement: { aliasNodeId: "plant" },
          reason: "合併同義概念。",
          expectedAnalysisEpoch: epoch,
          expectedProjectionVersion: 1,
        } }] };
      }
      if (sql.includes("payload->>'targetCorrectionEventId'")) return { rowCount: 0, rows: [] };
      if (sql.includes("e.room_seq>$2")) return { rowCount: 0, rows: [] };
      if (sql.includes("analysis_projection_snapshots")) {
        return { rows: [projectionRow({
          nodes: [{
            nodeId: "producer", label: "生產者", nodeKind: "concept",
            evidenceStatus: "supported", reviewStatus: "unreviewed",
            displayStatus: "provisional", position: { x: 0.5, y: 0.5 },
          }],
          edges: [],
        })] };
      }
      return { rowCount: 1, rows: [] };
    }) };
    events.transact.mockImplementation(async (_room: string, work: any) => work({
      client,
      room: { next_room_seq: 2, teacher_id: teacherId },
      append: async () => ({
        eventId: "00000000-0000-4000-8000-000000000022",
        roomSeq: 2,
        correlationId: "00000000-0000-4000-8000-000000000023",
      }),
    }));
    pool.query.mockResolvedValueOnce({ rows: [{ job_id: "00000000-0000-4000-8000-000000000024" }] });

    await expect(svc.review(teacher, "00000000-0000-4000-8000-000000000016", roomId, {
      correctionKind: "undo_merge",
      targetCorrectionEventId: mergeEventId,
      replacement: {},
      reason: "別名應保持獨立。",
      expectedAnalysisEpoch: epoch,
      expectedProjectionVersion: 1,
    })).resolves.toMatchObject({ changeKind: "correction" });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("payload->>'targetCorrectionEventId'"))).toBe(true);

    const duplicate = service();
    const duplicateClient = { query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM deletion_job")) return { rowCount: 0, rows: [] };
      if (sql.includes("pilot_retention_policy")) return { rows: [{ policy_current: true }] };
      if (sql.includes("SELECT analysis_epoch,version,complete_through_seq")) return { rows: [{ analysis_epoch: epoch, version: "1", complete_through_seq: "1", requires_replay: false }] };
      if (sql.includes("validated_payload") && sql.includes("review_event_id=$2")) {
        return { rows: [{ room_seq: "1", validated_payload: {
          correctionKind: "merge_alias",
          targetCanonicalNodeId: "producer",
          replacement: { aliasNodeId: "plant" },
          reason: "合併同義概念。",
          expectedAnalysisEpoch: epoch,
          expectedProjectionVersion: 1,
        } }] };
      }
      if (sql.includes("payload->>'targetCorrectionEventId'")) return { rowCount: 1, rows: [{}] };
      return { rowCount: 1, rows: [] };
    }) };
    duplicate.events.transact.mockImplementation(async (_room: string, work: any) => work({
      client: duplicateClient,
      room: { next_room_seq: 2, teacher_id: teacherId },
      append: vi.fn(),
    }));
    await expect(duplicate.svc.review(teacher, "00000000-0000-4000-8000-000000000016", roomId, {
      correctionKind: "undo_merge",
      targetCorrectionEventId: mergeEventId,
      replacement: {},
      reason: "不可重複撤銷。",
      expectedAnalysisEpoch: epoch,
      expectedProjectionVersion: 1,
    })).rejects.toMatchObject({ statusCode: 404, code: "ANALYTICS_TARGET_NOT_FOUND" });
  });

  it("rejects split_alias before append when the new canonical node already exists", async () => {
    const { svc, events } = service();
    const append = vi.fn();
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM deletion_job")) return { rowCount: 0, rows: [] };
      if (sql.includes("pilot_retention_policy")) return { rows: [{ policy_current: true }] };
      if (sql.includes("SELECT analysis_epoch,version,complete_through_seq")) return { rows: [{ analysis_epoch: epoch, version: "1", complete_through_seq: "1", requires_replay: false }] };
      if (sql.includes("analysis_projection_snapshots")) {
        return { rows: [projectionRow({
          nodes: ["producer", "plant", "consumer"].map((nodeId, index) => ({
            nodeId, label: nodeId, nodeKind: "concept", evidenceStatus: "supported",
            reviewStatus: "unreviewed", displayStatus: "provisional",
            position: { x: 0.2 + index * 0.2, y: 0.5 },
          })),
          edges: [],
        })] };
      }
      return { rowCount: 0, rows: [] };
    }) };
    events.transact.mockImplementation(async (_room: string, work: any) => work({ client, room: { next_room_seq: 2, teacher_id: teacherId }, append }));

    await expect(svc.review(teacher, "00000000-0000-4000-8000-000000000016", roomId, {
      correctionKind: "split_alias",
      targetCanonicalNodeId: "producer",
      replacement: { aliasNodeId: "plant", newCanonicalNodeId: "consumer", newLabel: "消費者" },
      reason: "嘗試使用既有節點。",
      expectedAnalysisEpoch: epoch,
      expectedProjectionVersion: 1,
    })).rejects.toMatchObject({ statusCode: 404, code: "ANALYTICS_TARGET_NOT_FOUND" });
    expect(append).not.toHaveBeenCalled();

    const corrupt = service();
    corrupt.events.transact.mockImplementation(async (_room: string, work: any) => work({
      client: { query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM deletion_job")) return { rowCount: 0, rows: [] };
        if (sql.includes("pilot_retention_policy")) return { rows: [{ policy_current: true }] };
        if (sql.includes("SELECT analysis_epoch,version,complete_through_seq")) {
          return { rows: [{ analysis_epoch: epoch, version: "1", complete_through_seq: "1", requires_replay: false }] };
        }
        if (sql.includes("analysis_projection_snapshots")) {
          return { rows: [{ payload: { nodes: [], edges: [] } }] };
        }
        return { rows: [] };
      }) },
      room: { next_room_seq: 2, teacher_id: teacherId },
      append: vi.fn(),
    }));
    await expect(corrupt.svc.review(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      roomId,
      {
        correctionKind: "split_alias",
        targetCanonicalNodeId: "producer",
        replacement: { aliasNodeId: "plant", newCanonicalNodeId: "new-node", newLabel: "新概念" },
        reason: "腐壞 snapshot 不可成為修正權威。",
        expectedAnalysisEpoch: epoch,
        expectedProjectionVersion: 1,
      },
    )).rejects.toMatchObject({ statusCode: 503, code: "ANALYTICS_CORRUPT" });
  });

  it("validates replacement evidence spans against the active corrected text lineage", async () => {
    const { svc, pool, events } = service();
    const edgeId = "00000000-0000-4000-8000-000000000041";
    const correctedText = "太陽持續提供能量給生產者";
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM deletion_job")) return { rowCount: 0, rows: [] };
      if (sql.includes("pilot_retention_policy")) return { rows: [{ policy_current: true }] };
      if (sql.includes("SELECT analysis_epoch,version,complete_through_seq")) {
        return { rows: [{ analysis_epoch: epoch, version: "1", complete_through_seq: "1", requires_replay: false }] };
      }
      if (sql.includes("analysis_projection_snapshots")) {
        return { rows: [projectionRow({
          nodes: ["sun", "producer"].map((nodeId, index) => ({
            nodeId, label: nodeId, nodeKind: "concept", evidenceStatus: "supported",
            reviewStatus: "unreviewed", displayStatus: "provisional",
            position: { x: 0.3 + index * 0.4, y: 0.5 },
          })),
          edges: [{
            edgeId, head: "sun", predicate: "提供能量", tail: "producer",
            relationFamily: "energy_flow", evidenceStatus: "supported",
            reviewStatus: "unreviewed", displayStatus: "provisional",
            channels: { support: 1, challenge: 0, uncertain: 0, question: 0 },
            activityScore: 1,
            evidenceRefs: [{ eventId, start: 0, end: 2 }],
          }],
        })] };
      }
      if (sql.includes("FROM derived_text_artifact") && sql.includes("text_content")) {
        return { rowCount: 1, rows: [{ text_content: correctedText }] };
      }
      if (sql.includes("FROM room_event") && sql.includes("SELECT payload")) {
        throw new Error("SPAN_MUST_USE_ACTIVE_CORRECTED_ARTIFACT");
      }
      return { rowCount: 1, rows: [] };
    }) };
    events.transact.mockImplementation(async (_room: string, work: any) => work({
      client,
      room: { next_room_seq: 2, teacher_id: teacherId },
      append: async () => ({
        eventId: "00000000-0000-4000-8000-000000000042",
        roomSeq: 3,
        correlationId: "00000000-0000-4000-8000-000000000043",
      }),
    }));
    pool.query.mockResolvedValueOnce({
      rows: [{ job_id: "00000000-0000-4000-8000-000000000044" }],
    });

    await expect(svc.review(
      teacher,
      "00000000-0000-4000-8000-000000000016",
      roomId,
      {
        targetProjectionEdgeId: edgeId,
        correctionKind: "replace_evidence_span",
        target: { eventId, start: 0, end: 2 },
        replacement: { eventId, start: 0, end: Array.from(correctedText).length },
        reason: "修正後文字包含完整證據。",
        expectedAnalysisEpoch: epoch,
        expectedProjectionVersion: 1,
      },
    )).resolves.toMatchObject({ changeKind: "correction" });
  });
});
