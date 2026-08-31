import { describe, expect, it, vi } from "vitest";

import {
  CleanupStack,
  LocalPilotFailure,
  runLocalPilotWorkflow,
} from "../../scripts/local-pilot/workflow.mjs";

describe("local pilot fail-fast workflow and receipt", () => {
  it("runs deterministic stages and cleanup in reverse order", async () => {
    const order: string[] = [];
    const cleanup = new CleanupStack();
    const receipt = await runLocalPilotWorkflow({
      runId: "0123456789abcdef",
      sourceSha: "a".repeat(40),
      cleanup,
      stages: [
        { id: "preflight", run: async () => { order.push("preflight"); } },
        { id: "resources", run: async () => {
          order.push("resources");
          cleanup.register("first", async () => { order.push("cleanup-first"); }, {
            requiresIfRegistered: ["second"],
          });
          cleanup.register("second", async () => { order.push("cleanup-second"); });
          cleanup.register("partial-setup", async () => { order.push("cleanup-partial-setup"); }, {
            requiresIfRegistered: ["resource-never-created"],
          });
        } },
      ],
      now: (() => {
        let value = Date.parse("2026-08-31T00:00:00.000Z");
        return () => new Date(value += 1_000);
      })(),
    });
    expect(order).toEqual([
      "preflight",
      "resources",
      "cleanup-partial-setup",
      "cleanup-second",
      "cleanup-first",
    ]);
    expect(receipt.status).toBe("passed");
    expect(receipt.stages.map(({ id, status }) => [id, status])).toEqual([
      ["preflight", "passed"],
      ["resources", "passed"],
    ]);
    expect(receipt.cleanup).toEqual([
      { id: "partial-setup", status: "passed", failureCode: null },
      { id: "second", status: "passed", failureCode: null },
      { id: "first", status: "passed", failureCode: null },
    ]);
  });

  it("redacts stage errors, still cleans everything, and preserves the stable failure code", async () => {
    const order: string[] = [];
    const cleanup = new CleanupStack();
    await expect(runLocalPilotWorkflow({
      runId: "fedcba9876543210",
      sourceSha: "b".repeat(40),
      cleanup,
      stages: [{
        id: "compose",
        run: async () => {
          cleanup.register("owned-compose", async () => { order.push("compose-down"); });
          throw new Error("LOCAL_PILOT_DOCKER_UNAVAILABLE:sensitive socket path");
        },
      }],
    })).rejects.toMatchObject({
      name: "LocalPilotFailure",
      code: "LOCAL_PILOT_DOCKER_UNAVAILABLE",
      receipt: expect.objectContaining({ status: "failed", failureCode: "LOCAL_PILOT_DOCKER_UNAVAILABLE" }),
    });
    expect(order).toEqual(["compose-down"]);
  });

  it("makes any cleanup failure invalidate an otherwise passing run", async () => {
    const cleanup = new CleanupStack();
    const ran = vi.fn();
    const failedRun = runLocalPilotWorkflow({
      runId: "1111111111111111",
      sourceSha: "c".repeat(40),
      cleanup,
      stages: [{ id: "gate", run: async () => {
        cleanup.register("bad-cleanup", async () => {
          throw new Error("LOCAL_PILOT_WORKTREE_FINAL_DIRTY:sensitive cleanup detail");
        });
        cleanup.register("good-cleanup", async () => { ran(); });
      } }],
    });
    await expect(failedRun).rejects.toBeInstanceOf(LocalPilotFailure);
    await expect(failedRun).rejects.toMatchObject({
      receipt: expect.objectContaining({
        cleanup: [
          { id: "good-cleanup", status: "passed", failureCode: null },
          {
            id: "bad-cleanup",
            status: "failed",
            failureCode: "LOCAL_PILOT_WORKTREE_FINAL_DIRTY",
          },
        ],
      }),
    });
    expect(ran).toHaveBeenCalledTimes(1);
    try {
      await runLocalPilotWorkflow({
        runId: "2222222222222222",
        sourceSha: "d".repeat(40),
        cleanup: new CleanupStack(),
        stages: [{ id: "invalid id!", run: async () => undefined }],
      });
    } catch (error) {
      expect(error).toMatchObject({ code: "LOCAL_PILOT_WORKFLOW_INVALID" });
    }
  });

  it("does not run cleanup whose prerequisite failed", async () => {
    const cleanup = new CleanupStack();
    const mailpitCleanup = vi.fn();
    const composeDown = vi.fn();
    const worktreeCleanup = vi.fn();
    const runtimeCleanup = vi.fn();
    const tlsCleanup = vi.fn();
    const failedRun = runLocalPilotWorkflow({
      runId: "3333333333333333",
      sourceSha: "e".repeat(40),
      cleanup,
      stages: [{ id: "gate", run: async () => {
        cleanup.register("tls-material", tlsCleanup, { requiresIfRegistered: ["runtime-material"] });
        cleanup.register("runtime-material", runtimeCleanup, {
          requiresIfRegistered: ["disposable-worktree"],
        });
        cleanup.register("disposable-worktree", worktreeCleanup, {
          requiresIfRegistered: ["compose-project"],
        });
        cleanup.register("compose-project", composeDown, {
          requiresIfRegistered: ["mailpit-residual"],
        });
        cleanup.register("mailpit-residual", mailpitCleanup, {
          requiresIfRegistered: ["application-processes"],
        });
        cleanup.register("application-processes", async () => {
          throw new Error("LOCAL_PILOT_CHILD_STOP_FAILED");
        });
      } }],
    });

    await expect(failedRun).rejects.toMatchObject({
      receipt: expect.objectContaining({
        cleanup: [
          {
            id: "application-processes",
            status: "failed",
            failureCode: "LOCAL_PILOT_CHILD_STOP_FAILED",
          },
          {
            id: "mailpit-residual",
            status: "failed",
            failureCode: "LOCAL_PILOT_CLEANUP_DEPENDENCY_FAILED",
          },
          {
            id: "compose-project",
            status: "failed",
            failureCode: "LOCAL_PILOT_CLEANUP_DEPENDENCY_FAILED",
          },
          {
            id: "disposable-worktree",
            status: "failed",
            failureCode: "LOCAL_PILOT_CLEANUP_DEPENDENCY_FAILED",
          },
          {
            id: "runtime-material",
            status: "failed",
            failureCode: "LOCAL_PILOT_CLEANUP_DEPENDENCY_FAILED",
          },
          {
            id: "tls-material",
            status: "failed",
            failureCode: "LOCAL_PILOT_CLEANUP_DEPENDENCY_FAILED",
          },
        ],
      }),
    });
    expect(mailpitCleanup).not.toHaveBeenCalled();
    expect(composeDown).not.toHaveBeenCalled();
    expect(worktreeCleanup).not.toHaveBeenCalled();
    expect(runtimeCleanup).not.toHaveBeenCalled();
    expect(tlsCleanup).not.toHaveBeenCalled();
  });
});
