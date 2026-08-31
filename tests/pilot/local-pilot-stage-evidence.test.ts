import { describe, expect, it } from "vitest";

import { assertContentFreeReceipt } from "../../scripts/local-pilot/evidence.mjs";
import { createLocalPilotEvidenceRecorder } from "../../scripts/local-pilot/stage-evidence.mjs";

const deterministicClock = () => {
  let value = Date.parse("2026-08-31T00:00:00.000Z");
  return () => new Date(value += 1_000);
};

describe("local pilot dynamic stage evidence", () => {
  it("records only checks that actually ran and preserves a redacted failure code", async () => {
    const recorder = createLocalPilotEvidenceRecorder({
      id: "disposable-worktree",
      now: deterministicClock(),
    });
    await recorder.runCheck("tls-material", async () => "tls-ready");
    await expect(recorder.runCheck("runtime-material", async () => {
      throw new Error("LOCAL_PILOT_MATERIAL_GENERATION_FAILED:sensitive path");
    })).rejects.toThrow("LOCAL_PILOT_MATERIAL_GENERATION_FAILED");

    expect(recorder.snapshot().checks).toEqual([
      {
        id: "tls-material",
        status: "passed",
        failureCode: null,
        startedAt: "2026-08-31T00:00:01.000Z",
        endedAt: "2026-08-31T00:00:02.000Z",
      },
      {
        id: "runtime-material",
        status: "failed",
        failureCode: "LOCAL_PILOT_MATERIAL_GENERATION_FAILED",
        startedAt: "2026-08-31T00:00:03.000Z",
        endedAt: "2026-08-31T00:00:04.000Z",
      },
    ]);
    expect(recorder.snapshot().checks.some(({ id }) => id === "detached-worktree")).toBe(false);
  });

  it("stores sanitized argv and a hash instead of command output", () => {
    const recorder = createLocalPilotEvidenceRecorder({
      id: "production-builds",
      now: deterministicClock(),
    });
    recorder.recordCommand({
      executable: "/approved/runtime/node",
      argv: ["/private/var/run/scripts/build.mjs", "--mode", "production"],
      exitCode: 0,
      startedAt: "2026-08-31T00:00:01.000Z",
      endedAt: "2026-08-31T00:00:02.000Z",
      stdout: "private build output",
      stderr: "",
    });

    const [command] = recorder.snapshot().commands;
    expect(command).toEqual({
      argv: ["node", "<absolute:build.mjs>", "--mode", "production"],
      exitCode: 0,
      startedAt: "2026-08-31T00:00:01.000Z",
      endedAt: "2026-08-31T00:00:02.000Z",
      outputSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(command)).not.toContain("private build output");
    expect(JSON.stringify(command)).not.toContain("/private/var");
  });

  it("rejects command evidence that could expose a credential", () => {
    const recorder = createLocalPilotEvidenceRecorder({ id: "required-tests" });
    expect(() => recorder.recordCommand({
      executable: "/approved/pnpm",
      argv: ["test", "--token=must-not-appear"],
      exitCode: 1,
      startedAt: "2026-08-31T00:00:01.000Z",
      endedAt: "2026-08-31T00:00:02.000Z",
      stdout: "",
      stderr: "",
    })).toThrow("LOCAL_PILOT_COMMAND_EVIDENCE_INVALID");
  });

  it("produces stage and gate summary evidence accepted by the content-free receipt validator", async () => {
    const recorder = createLocalPilotEvidenceRecorder({
      id: "manifest-verification",
      now: deterministicClock(),
    });
    await recorder.runCheck("closed-summary-set", async () => undefined);
    recorder.recordCommand({
      executable: "/approved/node",
      argv: ["scripts/local-pilot/verify-required-test-summaries.mjs"],
      exitCode: 0,
      startedAt: "2026-08-31T00:00:03.000Z",
      endedAt: "2026-08-31T00:00:04.000Z",
      stdout: "required-test-summaries: PASS\n",
      stderr: "",
    });
    const summary = {
      expected: 1,
      executed: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      pending: 0,
      focused: 0,
    };
    const receipt = {
      schemaVersion: 1,
      runId: "0123456789abcdef",
      sourceSha: "a".repeat(40),
      status: "passed",
      stages: [{ id: "manifest-verification", status: "passed", ...recorder.snapshot() }],
      gates: [{ id: "pilot-load", status: "passed", summary }],
      cleanup: [],
    };

    expect(assertContentFreeReceipt(receipt)).toBe(receipt);
  });
});
