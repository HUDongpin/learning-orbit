import { describe, expect, it, vi } from "vitest";
import { AnalyticsTeacherService } from "../../src/modules/analytics/analytics-teacher-service.js";

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

function service() {
  const pool = { query: vi.fn().mockResolvedValue({ rows: [artifactRow] }) } as any;
  const policy = { requireRoomAccess: vi.fn().mockResolvedValue({ roomId, role: "teacher", studentProjectionAllowlist: new Set() }) } as any;
  const events = { transact: vi.fn() } as any;
  return { svc: new AnalyticsTeacherService(pool, events, policy), pool, policy, events };
}

describe("teacher analytics surfaces", () => {
  it("returns a schema-validated active artifact page with a bounded cursor", async () => {
    const { svc, policy } = service();
    const page = await svc.listArtifacts(teacher, "00000000-0000-4000-8000-000000000016", roomId, {
      includeHistory: false, limit: 20,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.artifactId).toBe(artifactId);
    expect(page.includeHistory).toBe(false);
    expect(policy.requireRoomAccess).toHaveBeenCalledWith(teacher, roomId, "latest", expect.any(String));
  });

  it("appends a content-free review notice and replay authority atomically", async () => {
    const { svc, events } = service();
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("analysis_room_heads")) return { rows: [{ analysis_epoch: epoch, version: "1" }] };
      if (sql.includes("derived_text_artifact")) return { rowCount: 1, rows: [{}] };
      return { rowCount: 1, rows: [] };
    }) };
    events.transact.mockImplementation(async (_room: string, work: any) => work({
      client,
      room: { next_room_seq: 2 },
      append: async () => ({ eventId: "00000000-0000-4000-8000-000000000017", roomSeq: 2, correlationId: "00000000-0000-4000-8000-000000000018" }),
    }));
    const result = await svc.review(teacher, "00000000-0000-4000-8000-000000000016", roomId, {
      targetType: "derived_text", targetId: artifactId, decision: "approve", rationale: "可追溯至原始文字。",
      expectedAnalysisEpoch: epoch, expectedProjectionVersion: 1,
    });
    expect(result.changeKind).toBe("review");
    expect(result.reviewEventId).toBe("00000000-0000-4000-8000-000000000017");
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("analytics_review_detail"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("analytics_replay_request"))).toBe(true);
  });
});
