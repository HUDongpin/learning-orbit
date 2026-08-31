import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REQUIRED_GATE_ORDER,
  assertRequiredGateOrder,
  assertRequiredGateEntrypoints,
  executeRequiredGateSet,
  sanitizeGateArgv,
} from "../../scripts/local-pilot/required-test-runner.mjs";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const gate = (id: string, runner: "vitest" | "python-unittest" | "playwright" | "load", expectedTests = 2) => ({
  id,
  runner,
  argv: runner === "python-unittest"
    ? [".venv/bin/python", "scripts/local-pilot/python-unittest-report.py", "--start-directory", "services/worker/tests"]
    : runner === "load"
      ? ["pnpm", "load:pilot"]
      : runner === "playwright"
        ? ["pnpm", "exec", "playwright", "test", "--config", "apps/web/playwright.config.ts", "--reporter=json"]
        : ["pnpm", "exec", "vitest", "run", "--allowOnly=false", "--reporter=json"],
  report: `test-results/local-pilot/summaries/${id}.summary.json`,
  expectedTests,
});

const closedManifest = () => ({
  schemaVersion: 1,
  gates: [
    gate("contracts-vitest", "vitest"),
    gate("server-vitest", "vitest"),
    gate("web-vitest", "vitest"),
    gate("pilot-harness-vitest", "vitest"),
    gate("worker-python", "python-unittest"),
    gate("browser-playwright", "playwright"),
    gate("pilot-load", "load", 1),
  ],
});

describe("local pilot closed required-test execution", () => {
  it("freezes the required gate sequence and runner ownership", () => {
    expect(REQUIRED_GATE_ORDER).toEqual([
      "contracts-vitest",
      "server-vitest",
      "web-vitest",
      "pilot-harness-vitest",
      "worker-python",
      "browser-playwright",
      "pilot-load",
    ]);
    expect(() => assertRequiredGateOrder(closedManifest())).not.toThrow();
    const reordered = closedManifest();
    [reordered.gates[0], reordered.gates[1]] = [reordered.gates[1]!, reordered.gates[0]!];
    expect(() => assertRequiredGateOrder(reordered)).toThrow("REQUIRED_TEST_GATE_ORDER");
    const wrongRunner = closedManifest();
    wrongRunner.gates[5] = gate("browser-playwright", "vitest");
    expect(() => assertRequiredGateOrder(wrongRunner)).toThrow("REQUIRED_TEST_GATE_RUNNER");
    expect(() => assertRequiredGateEntrypoints(closedManifest(), {
      scripts: { "load:pilot": "node scripts/local-pilot/run-load.mjs" },
    })).not.toThrow();
    expect(() => assertRequiredGateEntrypoints(closedManifest(), { scripts: {} }))
      .toThrow("REQUIRED_TEST_ENTRYPOINT_MISSING:pilot-load");
  });

  it("runs a selected ordered group with direct argv, writes content-free summaries, and records hashes", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "lo-required-runner-"));
    roots.push(checkout);
    const calls: Array<{ executable: string; argv: string[]; shell: boolean }> = [];
    const written: Array<{ id: string; summary: Record<string, number> }> = [];
    const manifest = closedManifest();
    const result = await executeRequiredGateSet({
      manifest,
      gateIds: ["contracts-vitest", "server-vitest"],
      checkout,
      pnpmPath: "/approved/pnpm",
      pythonPath: join(checkout, ".venv/bin/python"),
      environment: { PATH: "/approved/bin", TMPDIR: checkout },
      runCommand: async (executable, argv, options) => {
        calls.push({ executable, argv, shell: options.shell });
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            numTotalTests: 2,
            numPassedTests: 2,
            numFailedTests: 0,
            numPendingTests: 0,
            numTodoTests: 0,
            numFailedTestSuites: 0,
            success: true,
          }),
        };
      },
      writeSummary: async (selected, summary) => {
        written.push({ id: selected.id, summary });
      },
      now: (() => {
        let value = Date.parse("2026-08-31T00:00:00.000Z");
        return () => new Date(value += 1_000);
      })(),
    });

    expect(calls).toEqual([
      { executable: "/approved/pnpm", argv: manifest.gates[0]!.argv.slice(1), shell: false },
      { executable: "/approved/pnpm", argv: manifest.gates[1]!.argv.slice(1), shell: false },
    ]);
    expect(written.map(({ id }) => id)).toEqual(["contracts-vitest", "server-vitest"]);
    expect(written[0]!.summary).toEqual({
      expected: 2, executed: 2, passed: 2, failed: 0, skipped: 0, pending: 0, focused: 0,
    });
    expect(result.map(({ id, exitCode, noSkipCount, reportSha256 }) => ({ id, exitCode, noSkipCount, reportSha256 })))
      .toEqual([
        { id: "contracts-vitest", exitCode: 0, noSkipCount: 0, reportSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        { id: "server-vitest", exitCode: 0, noSkipCount: 0, reportSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ]);
    expect(result.every(({ summary }) => summary.expected === 2
      && summary.executed === 2 && summary.passed === 2)).toBe(true);
  });

  it("fails fast on a skipped required test and never runs the next gate", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "lo-required-runner-"));
    roots.push(checkout);
    const runCommand = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        numTotalTests: 2,
        numPassedTests: 1,
        numFailedTests: 0,
        numPendingTests: 1,
        numTodoTests: 0,
        numFailedTestSuites: 0,
        success: true,
      }),
    });
    const recorded: Array<Record<string, unknown>> = [];
    await expect(executeRequiredGateSet({
      manifest: closedManifest(),
      gateIds: ["contracts-vitest", "server-vitest"],
      checkout,
      pnpmPath: "/approved/pnpm",
      pythonPath: join(checkout, ".venv/bin/python"),
      environment: { PATH: "/approved/bin", TMPDIR: checkout },
      runCommand,
      writeSummary: vi.fn(),
      recordReceipt: async (receipt) => { recorded.push(receipt); },
    })).rejects.toThrow("REQUIRED_TEST_GATE_FAILED:contracts-vitest:skipped");
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(recorded).toEqual([expect.objectContaining({
      id: "contracts-vitest",
      status: "failed",
      exitCode: 0,
      noSkipCount: 1,
      reportSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })]);
  });

  it("rejects manifest argv that could expose credentials in receipts", () => {
    expect(sanitizeGateArgv(["pnpm", "exec", "vitest", "run"])).toEqual([
      "pnpm", "exec", "vitest", "run",
    ]);
    expect(() => sanitizeGateArgv(["pnpm", "test", "--token=secret-value"]))
      .toThrow("REQUIRED_TEST_ARGV_SENSITIVE");
    expect(() => sanitizeGateArgv(["pnpm", "test", "postgres://user:secret@127.0.0.1/db"]))
      .toThrow("REQUIRED_TEST_ARGV_SENSITIVE");
  });

  it("returns a closed JSON failure summary for the outer required gate to evaluate", async () => {
    const suite = await mkdtemp(join(tmpdir(), "lo-python-summary-"));
    roots.push(suite);
    await writeFile(join(suite, "test_failure.py"), [
      "import unittest",
      "class ExpectedFailureReport(unittest.TestCase):",
      "    def test_failure(self):",
      "        self.assertEqual(1, 2)",
      "",
    ].join("\n"));

    const { stdout, stderr } = await execFileAsync(
      resolve(".venv/bin/python"),
      [
        resolve("scripts/local-pilot/python-unittest-report.py"),
        "--start-directory",
        suite,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      testsRun: 1,
      failures: 1,
      errors: 0,
      skipped: 0,
      expectedFailures: 0,
      unexpectedSuccesses: 0,
      focused: 0,
    });
  });
});
