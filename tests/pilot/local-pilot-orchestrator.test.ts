import { describe, expect, it, vi } from "vitest";

import {
  POST_PREFLIGHT_STAGE_ORDER,
  runLocalPilotOrchestrator,
} from "../../scripts/local-pilot/orchestrator.mjs";

const preflight = {
  sha: "a".repeat(40),
  checkout: "main",
  node: "v24.19.0",
  pnpm: "11.19.0",
  python: "Python 3.12.13",
};

function operations(order: string[]) {
  return Object.fromEntries(POST_PREFLIGHT_STAGE_ORDER.map((id) => [id, async ({ cleanup }) => {
    order.push(id);
    if (id === "isolated-postgres") {
      cleanup.register("compose", async () => { order.push("cleanup-compose"); });
    }
    if (id === "application-startup") {
      cleanup.register("application-processes", async () => { order.push("cleanup-apps"); });
    }
  }]));
}

describe("single local-pilot orchestrator", () => {
  it("runs the frozen stage order and reverse cleanup against one captured SHA", async () => {
    const order: string[] = [];
    const receipt = await runLocalPilotOrchestrator({
      preflight: async () => { order.push("preflight"); return preflight; },
      runId: () => "0123456789abcdef",
      creatorPid: 42,
      operations: operations(order),
    });
    expect(order).toEqual([
      "preflight",
      ...POST_PREFLIGHT_STAGE_ORDER,
      "cleanup-apps",
      "cleanup-compose",
    ]);
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      runId: "0123456789abcdef",
      sourceSha: preflight.sha,
      status: "passed",
    });
    expect(receipt.stages.map(({ id }) => id)).toEqual(POST_PREFLIGHT_STAGE_ORDER);
  });

  it("fails before resources when preflight is red", async () => {
    const operation = vi.fn();
    await expect(runLocalPilotOrchestrator({
      preflight: async () => { throw new Error("LOCAL_PILOT_DOCKER_UNAVAILABLE:private path"); },
      runId: () => "0123456789abcdef",
      creatorPid: 42,
      operations: Object.fromEntries(POST_PREFLIGHT_STAGE_ORDER.map((id) => [id, operation])),
    })).rejects.toThrow("LOCAL_PILOT_DOCKER_UNAVAILABLE");
    expect(operation).not.toHaveBeenCalled();
  });

  it("stops at the first failed stage and still runs registered cleanup", async () => {
    const order: string[] = [];
    const configured = operations(order);
    configured["production-builds"] = async () => {
      order.push("production-builds");
      throw new Error("LOCAL_PILOT_BUILD_FAILED:sensitive compiler output");
    };
    await expect(runLocalPilotOrchestrator({
      preflight: async () => preflight,
      runId: () => "fedcba9876543210",
      creatorPid: 43,
      operations: configured,
    })).rejects.toMatchObject({ code: "LOCAL_PILOT_BUILD_FAILED" });
    expect(order).toEqual([
      "disposable-worktree",
      "frozen-dependencies",
      "isolated-postgres",
      "repository-foundations",
      "production-builds",
      "cleanup-compose",
    ]);
  });

  it("rejects missing, extra, or reordered stage composition", async () => {
    const configured = operations([]);
    delete configured["pilot-load"];
    await expect(runLocalPilotOrchestrator({
      preflight: async () => preflight,
      runId: () => "0011223344556677",
      creatorPid: 44,
      operations: configured,
    })).rejects.toThrow("LOCAL_PILOT_STAGE_PLAN_INVALID");
  });
});
