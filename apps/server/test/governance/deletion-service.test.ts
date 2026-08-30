import { describe, expect, it, vi } from "vitest";
import { GovernanceService } from "../../src/modules/governance/governance-service.js";

const roomId = "11111111-1111-4111-8111-111111111111";
const teacherId = "22222222-2222-4222-8222-222222222222";
const principal = { role: "teacher" as const, teacherId, actorId: teacherId };

function fakePool() {
  const queries: string[] = [];
  let inserted = false;
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SELECT room_id, teacher_id, status")) return { rows: [{ room_id: roomId, teacher_id: teacherId, status: "open" }] };
      if (sql.includes("SELECT deletion_job_id")) return { rows: inserted ? [{ deletion_job_id: "33333333-3333-4333-8333-333333333333" }] : [] };
      if (sql.includes("INSERT INTO deletion_job")) { inserted = true; return { rows: [{ deletion_job_id: "33333333-3333-4333-8333-333333333333" }] }; }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(async () => client) } as any, queries };
}

describe("governance deletion service", () => {
  it("converges repeated teacher requests to one content-free job", async () => {
    const first = fakePool();
    const service = new GovernanceService(first.pool, { auditSalt: "test-salt-01234567" });
    const result = await service.requestDeletion(principal, roomId, { confirmation: `DELETE ${roomId}` });
    expect(result).toEqual({ deletionJobId: "33333333-3333-4333-8333-333333333333", status: "queued" });
    await expect(service.requestDeletion(principal, roomId, { confirmation: `DELETE ${roomId}` })).resolves.toEqual(result);
    expect(result).not.toHaveProperty("roomId");
    expect(first.queries.some((query) => query.includes("deletion_surface_manifest"))).toBe(true);
  });

  it("removes URLs, secrets and provider payloads from exports", () => {
    const service = new GovernanceService({} as any, { auditSalt: "test-salt-01234567" });
    expect(service.sanitizeExport({ text: "可匯出的訊息", uploadUrl: "https://secret", apiKey: "secret", providerPayload: { raw: "secret" } })).toEqual({ text: "可匯出的訊息" });
  });
});
