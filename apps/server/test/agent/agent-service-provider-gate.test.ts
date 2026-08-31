import { describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@learning-orbit/contracts";
import { AgentError, AgentService } from "../../src/modules/agent/agent-service.js";
import { ProviderHealthRepository } from "../../src/modules/agent/provider-health-repository.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const MEMBER_ID = "00000000-0000-4000-8000-000000000011";
const ACTOR_ID = "00000000-0000-4000-8000-000000000012";
const NOVA_ID = "00000000-0000-4000-8000-000000000013";
const SESSION_ID = "00000000-0000-4000-8000-000000000014";
const EVENT_ID = "00000000-0000-4000-8000-000000000015";

const student: Extract<AuthSession, { role: "student" }> = {
  role: "student",
  roomId: ROOM_ID,
  roomMemberId: MEMBER_ID,
  actorId: ACTOR_ID,
  pseudonym: "探索者 A",
  nova: {
    actorId: NOVA_ID,
    actorKind: "agent",
    actorRole: "socratic_facilitator",
    displayName: "Nova Agent",
  },
};
const teacher: Extract<AuthSession, { role: "teacher" }> = {
  role: "teacher",
  teacherId: ACTOR_ID,
  actorId: ACTOR_ID,
};

describe("Agent Provider admission gate", () => {
  it("maps a deletion race from locked run admission to the public tombstone code", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM room_member m JOIN auth_session")) {
        return { rows: [{ room_member_id: MEMBER_ID, actor_id: ACTOR_ID, deletion_active: false }], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql.slice(0, 40)}`);
    });
    const service = new AgentService(
      { query } as never,
      { now: () => new Date("2026-08-31T06:00:00.000Z") },
    );
    vi.spyOn(service.repository, "getOrCreateRunAndJob")
      .mockRejectedValue(new Error("ROOM_DELETION_IN_PROGRESS"));

    await expect(service.request(student, SESSION_ID, ROOM_ID, EVENT_ID))
      .rejects.toEqual(new AgentError("ROOM_DELETION_IN_PROGRESS"));
  });

  it("maps a deletion race from the locked current-state read to the public tombstone code", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM room_member m JOIN auth_session")) {
        return { rows: [{ room_member_id: MEMBER_ID, actor_id: ACTOR_ID, deletion_active: false }], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql.slice(0, 40)}`);
    });
    const service = new AgentService(
      { query } as never,
      { now: () => new Date("2026-08-31T06:00:00.000Z") },
    );
    vi.spyOn(service.repository, "getCurrent")
      .mockRejectedValue(new Error("ROOM_DELETION_IN_PROGRESS"));

    await expect(service.current(student, SESSION_ID, ROOM_ID))
      .rejects.toEqual(new AgentError("ROOM_DELETION_IN_PROGRESS"));
  });

  it("blocks Agent settings once an owned room has an active deletion tombstone", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT r.teacher_id AS actor_id")) {
        return { rows: [{ actor_id: ACTOR_ID, deletion_active: true }], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql.slice(0, 40)}`);
    });
    const service = new AgentService(
      { query } as never,
      { now: () => new Date("2026-08-31T06:00:00.000Z") },
    );
    const write = vi.spyOn(service.repository, "setEnabled");
    await expect(service.settings(teacher, SESSION_ID, ROOM_ID, false))
      .rejects.toEqual(new AgentError("ROOM_DELETION_IN_PROGRESS"));
    expect(write).not.toHaveBeenCalled();
  });

  it("share-locks an existing signed health sample when it is used as create authority", async () => {
    const checkedAt = new Date("2026-08-31T05:59:50.000Z");
    const query = vi.fn(async () => ({ rows: [{ health: "healthy", checked_at: checkedAt }], rowCount: 1 }));
    const repository = new ProviderHealthRepository(
      { query: vi.fn() } as never,
      { now: () => new Date("2026-08-31T06:00:00.000Z") },
    );
    await expect(repository.current("fixture", "0".repeat(64), { query } as never, true)).resolves.toBe("healthy");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FOR SHARE"), ["fixture", "0".repeat(64)]);
  });

  it.each(["degraded", "unavailable"] as const)("rejects %s health before any run or job write", async (health) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM room_member m JOIN auth_session")) {
        return { rows: [{ room_member_id: MEMBER_ID, actor_id: ACTOR_ID, deletion_active: false }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT status, agent_enabled, nova_actor_id FROM classroom_room")) {
        return { rows: [{ status: "open", agent_enabled: true, nova_actor_id: NOVA_ID }], rowCount: 1 };
      }
      if (sql.includes("FROM room_event WHERE room_id")) {
        return {
          rows: [{
            event_id: EVENT_ID,
            actor_kind: "human",
            operation: "add",
            payload: { mentions: [NOVA_ID] },
            correlation_id: "00000000-0000-4000-8000-000000000016",
          }],
          rowCount: 1,
        };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql.slice(0, 40)}`);
    });
    const service = new AgentService(
      { query } as never,
      { now: () => new Date("2026-08-31T06:00:00.000Z") },
      { current: vi.fn(async () => health) } as never,
    );
    vi.spyOn(service.repository, "getOrCreateRunAndJob").mockImplementation(async (input) => {
      await input.beforeCreate?.({ query } as never);
      throw new Error("CREATE_GATE_DID_NOT_CLOSE");
    });
    await expect(service.request(student, SESSION_ID, ROOM_ID, EVENT_ID))
      .rejects.toEqual(new AgentError("AGENT_SERVICE_UNAVAILABLE"));
    expect(query.mock.calls.some(([sql]) => /\b(?:INSERT|UPDATE|DELETE)\b/iu.test(String(sql)))).toBe(false);
  });

  it("returns an existing same-trigger run during a later Provider outage", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM room_member m JOIN auth_session")) return { rows: [{ room_member_id: MEMBER_ID, actor_id: ACTOR_ID, deletion_active: false }], rowCount: 1 };
      if (sql.startsWith("SELECT status, agent_enabled, nova_actor_id FROM classroom_room")) return { rows: [{ status: "open", agent_enabled: true, nova_actor_id: NOVA_ID }], rowCount: 1 };
      if (sql.includes("FROM room_event WHERE room_id")) return { rows: [{ event_id: EVENT_ID, actor_kind: "human", operation: "add", payload: { mentions: [NOVA_ID] }, correlation_id: "00000000-0000-4000-8000-000000000016" }], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql.slice(0, 40)}`);
    });
    const health = { current: vi.fn(async () => "unavailable" as const) };
    const service = new AgentService(
      { query } as never,
      { now: () => new Date("2026-08-31T06:00:00.000Z") },
      health as never,
    );
    const existing = {
      run: {
        agentRunId: "00000000-0000-4000-8000-000000000017",
        roomId: ROOM_ID,
        state: "completed" as const,
        triggerEventId: EVENT_ID,
        requestedByActorId: ACTOR_ID,
        requestedByRole: "student" as const,
        inputFromRoomSeq: 1,
        inputThroughRoomSeq: 1,
        modelProvider: "fixture",
        modelId: "fixture-socratic-v1",
        promptVersion: "socratic-facilitator-v1",
        policyVersion: "socratic-policy-v1",
        failureCode: null,
        createdAt: "2026-08-31T05:59:00.000Z",
        updatedAt: "2026-08-31T05:59:01.000Z",
      },
      created: false,
    };
    vi.spyOn(service.repository, "getOrCreateRunAndJob").mockResolvedValue(existing);
    await expect(service.request(student, SESSION_ID, ROOM_ID, EVENT_ID)).resolves.toEqual(existing);
    expect(health.current).not.toHaveBeenCalled();
  });
});
