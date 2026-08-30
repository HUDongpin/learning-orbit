import { describe, expect, it, vi } from "vitest";

import { AgentRepository, type AgentRunRequest } from "../../src/modules/agent/agent-repository.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const MEMBER_ID = "00000000-0000-4000-8000-000000000011";
const ACTOR_ID = "00000000-0000-4000-8000-000000000012";
const NOVA_ID = "00000000-0000-4000-8000-000000000013";
const SESSION_ID = "00000000-0000-4000-8000-000000000014";
const EVENT_ID = "00000000-0000-4000-8000-000000000015";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000016";
const RUN_ID = "00000000-0000-4000-8000-000000000017";

const input = (beforeCreate = vi.fn(async () => undefined)): AgentRunRequest => ({
  roomId: ROOM_ID,
  triggerEventId: EVENT_ID,
  owner: { role: "student", teacherId: null, roomMemberId: MEMBER_ID, actorId: ACTOR_ID },
  sessionId: SESSION_ID,
  beforeCreate,
});

type HarnessOptions = Readonly<{
  status?: "open" | "paused" | "closed";
  enabled?: boolean;
  latestOperation?: "add" | "revise" | "retract";
  latestMentions?: readonly string[];
  existing?: boolean;
  active?: boolean;
}>;

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const release = vi.fn();
  const existingRow = {
    agent_run_id: RUN_ID,
    room_id: ROOM_ID,
    state: "completed",
    trigger_event_id: EVENT_ID,
    requested_by_actor_id: ACTOR_ID,
    requested_by_role: "student",
    input_from_room_seq: "1",
    input_through_room_seq: "1",
    model_provider: "fixture",
    model_id: "fixture-socratic-v1",
    prompt_version: "socratic-facilitator-v1",
    policy_version: "socratic-policy-v1",
    failure_code: null,
    created_at: new Date("2026-08-31T05:59:00.000Z"),
    updated_at: new Date("2026-08-31T05:59:01.000Z"),
  };
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK)/u.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (sql.includes("SELECT status, agent_enabled, nova_actor_id FROM classroom_room")) {
      return { rows: [{ status: options.status ?? "open", agent_enabled: options.enabled ?? true, nova_actor_id: NOVA_ID }], rowCount: 1 };
    }
    if (sql.includes("FROM auth_session s") && sql.includes("JOIN room_member m")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
    if (sql.includes("trigger_event_id = $2 FOR UPDATE")) return options.existing
      ? { rows: [existingRow], rowCount: 1 }
      : { rows: [], rowCount: 0 };
    if (sql.includes("FROM room_event WHERE room_id = $1 AND event_id = $2")) {
      return {
        rows: [{ room_seq: "1", correlation_id: "00000000-0000-4000-8000-000000000018", actor_kind: "human", type: "message.added", operation: "add", payload: { messageId: MESSAGE_ID, mentions: [NOVA_ID] } }],
        rowCount: 1,
      };
    }
    if (sql.includes("payload->>'messageId'")) {
      return { rows: [{ room_seq: "2", operation: options.latestOperation ?? "revise", payload: { mentions: options.latestMentions ?? [NOVA_ID] } }], rowCount: 1 };
    }
    if (sql.includes("state IN ('queued','running','streaming')")) return options.active
      ? { rows: [{ agent_run_id: "00000000-0000-4000-8000-000000000019" }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
    throw new Error(`UNEXPECTED_QUERY:${sql.slice(0, 80)}`);
  });
  const client = { query, release };
  const pool = { connect: vi.fn(async () => client) };
  return {
    calls,
    query,
    release,
    repository: new AgentRepository(pool as never, { now: () => new Date("2026-08-31T06:00:00.000Z") }),
  };
}

describe("Agent locked create admission", () => {
  it.each([
    [{ status: "paused" as const }, "ROOM_NOT_OPEN"],
    [{ status: "closed" as const }, "ROOM_NOT_OPEN"],
    [{ enabled: false }, "AGENT_DISABLED"],
  ])("rechecks room state under the canonical lock: %j", async (options, code) => {
    const state = harness(options);
    const beforeCreate = vi.fn(async () => undefined);
    await expect(state.repository.getOrCreateRunAndJob(input(beforeCreate))).rejects.toThrow(code);
    expect(beforeCreate).not.toHaveBeenCalled();
    expect(state.calls.some((sql) => /^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql))).toBe(false);
    expect(state.calls.findIndex((sql) => sql.includes("pg_advisory_xact_lock")))
      .toBeLessThan(state.calls.findIndex((sql) => sql.includes("FOR UPDATE")));
    expect(state.release).toHaveBeenCalledOnce();
  });

  it("rejects a trigger whose latest message lineage is retracted", async () => {
    const state = harness({ latestOperation: "retract" });
    const beforeCreate = vi.fn(async () => undefined);
    await expect(state.repository.getOrCreateRunAndJob(input(beforeCreate))).rejects.toThrow("TRIGGER_EVENT_NOT_ACTIVE");
    expect(beforeCreate).not.toHaveBeenCalled();
    expect(state.calls.some((sql) => /^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql))).toBe(false);
  });

  it("rechecks the latest explicit Nova mention and active-run constraint before admission", async () => {
    const removedMention = harness({ latestMentions: [] });
    const beforeRemoved = vi.fn(async () => undefined);
    await expect(removedMention.repository.getOrCreateRunAndJob(input(beforeRemoved))).rejects.toThrow("EXPLICIT_TRIGGER_REQUIRED");
    expect(beforeRemoved).not.toHaveBeenCalled();

    const active = harness({ active: true });
    const beforeActive = vi.fn(async () => undefined);
    await expect(active.repository.getOrCreateRunAndJob(input(beforeActive))).rejects.toThrow("AGENT_RUN_ALREADY_ACTIVE");
    expect(beforeActive).not.toHaveBeenCalled();
  });

  it("returns an existing same-trigger run before room, Provider, or rate creation gates", async () => {
    const state = harness({ status: "closed", enabled: false, latestOperation: "retract", existing: true });
    const beforeCreate = vi.fn(async () => undefined);
    await expect(state.repository.getOrCreateRunAndJob(input(beforeCreate))).resolves.toMatchObject({
      created: false,
      run: { agentRunId: RUN_ID, state: "completed", triggerEventId: EVENT_ID },
    });
    expect(beforeCreate).not.toHaveBeenCalled();
    expect(state.calls.some((sql) => sql.includes("payload->>'messageId'"))).toBe(false);
    expect(state.calls.some((sql) => /^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql))).toBe(false);
  });
});
