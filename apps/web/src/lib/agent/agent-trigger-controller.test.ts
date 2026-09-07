import { describe, expect, it, vi } from "vitest";

import { AgentTriggerController } from "./agent-trigger-controller.js";

const NOVA = "00000000-0000-4000-8000-000000000014";
const ME = "00000000-0000-4000-8000-000000000012";
const SOMEONE_ELSE = "00000000-0000-4000-8000-000000000013";

function committed(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "00000000-0000-4000-8000-000000000101",
    schemaVersion: 1,
    roomId: "00000000-0000-4000-8000-000000000010",
    roomSeq: 5,
    type: "message.added",
    actorId: ME,
    actorKind: "human",
    actorRole: "student",
    revision: 1,
    operation: "add",
    eventTime: "2026-08-30T08:00:00.000Z",
    ingestTime: "2026-08-30T08:00:00.000Z",
    causationId: "00000000-0000-4000-8000-000000000102",
    correlationId: "00000000-0000-4000-8000-000000000103",
    payload: {
      messageId: "00000000-0000-4000-8000-000000000104",
      text: "@Nova 這個推論哪裡需要更多證據？",
      replyTo: null,
      mentions: [NOVA],
      mediaIds: [],
    },
    ...overrides,
  } as never;
}

function controller(requestRun = vi.fn(async () => undefined)) {
  return {
    requestRun,
    controller: new AgentTriggerController({ novaActorId: NOVA, actorId: ME, requestRun }),
  };
}

describe("agent trigger controller", () => {
  it("asks once for a committed message that mentions Nova", async () => {
    const { controller: subject, requestRun } = controller();
    expect(await subject.observe(committed())).toBe(true);
    expect(requestRun).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000101");
  });

  it("never asks twice for the same event, however often it replays", async () => {
    const { controller: subject, requestRun } = controller();
    await subject.observe(committed());
    await subject.observe(committed());
    await subject.observe(committed());
    expect(requestRun).toHaveBeenCalledTimes(1);
    expect(subject.requestedEventIds()).toEqual(["00000000-0000-4000-8000-000000000101"]);
  });

  it("triggers only on the author's own client", async () => {
    const { controller: subject, requestRun } = controller();
    // Four students see the same message; one run, not four.
    expect(await subject.observe(committed({ actorId: SOMEONE_ELSE }))).toBe(false);
    expect(requestRun).not.toHaveBeenCalled();
  });

  it("ignores a mention of anything that is not this room's Nova", async () => {
    const { controller: subject, requestRun } = controller();
    for (const mentions of [[], [SOMEONE_ELSE], ["Nova"], undefined]) {
      expect(await subject.observe(committed({
        payload: { messageId: "m", text: "t", replyTo: null, mentions, mediaIds: [] },
      }))).toBe(false);
    }
    expect(requestRun).not.toHaveBeenCalled();
  });

  it("ignores anything that is not a newly added student message", async () => {
    const { controller: subject, requestRun } = controller();
    for (const overrides of [
      { type: "message.revised" },
      { operation: "retract" },
      { actorKind: "agent", actorRole: "socratic_facilitator" },
      { actorRole: "teacher" },
      { type: "room.opened" },
    ]) {
      expect(await subject.observe(committed(overrides))).toBe(false);
    }
    expect(requestRun).not.toHaveBeenCalled();
  });

  it("does not re-ask after a failed request", async () => {
    const requestRun = vi.fn(async () => { throw new Error("AGENT_SERVICE_UNAVAILABLE"); });
    const subject = new AgentTriggerController({ novaActorId: NOVA, actorId: ME, requestRun });

    expect(await subject.observe(committed())).toBe(false);
    expect(await subject.observe(committed())).toBe(false);
    // The server owns the retry through its own run state; a client that
    // re-asks on every replay turns one failure into a flood.
    expect(requestRun).toHaveBeenCalledTimes(1);
  });
});
