import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, it as test } from "vitest";

import {
  adaptRunnerReport,
  assertRequiredTestReports,
  validateRequiredTestManifest,
  validateTestSummary,
} from "../../scripts/local-pilot/required-test-gates.mjs";

const manifestUrl = new URL("./required-test-manifest.v1.json", import.meta.url);
const writeSummaryScript = fileURLToPath(
  new URL("../../scripts/local-pilot/write-required-test-summary.mjs", import.meta.url),
);
const verifySummariesScript = fileURLToPath(
  new URL("../../scripts/local-pilot/verify-required-test-summaries.mjs", import.meta.url),
);
const pythonReportScript = fileURLToPath(
  new URL("../../scripts/local-pilot/python-unittest-report.py", import.meta.url),
);
const projectPython = fileURLToPath(new URL("../../.venv/bin/python", import.meta.url));
const cleanupPaths = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const passingSummary = (expected) => ({
  expected,
  executed: expected,
  passed: expected,
  failed: 0,
  skipped: 0,
  pending: 0,
  focused: 0,
});

function validManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    gates: [
      {
        id: "unit-vitest",
        runner: "vitest",
        argv: ["pnpm", "exec", "vitest", "run", "--allowOnly=false", "--reporter=json"],
        report: "test-results/local-pilot/summaries/unit-vitest.summary.json",
        expectedTests: 3,
      },
    ],
    ...overrides,
  };
}

test("the checked-in required-test manifest is closed and valid", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.equal(validateRequiredTestManifest(manifest), manifest);
  assert.ok(manifest.gates.some(({ runner }) => runner === "playwright"));
  assert.ok(manifest.gates.some(({ runner }) => runner === "load"));
  assert.deepEqual(
    Object.fromEntries(manifest.gates.map(({ id, expectedTests }) => [id, expectedTests])),
    {
      "contracts-vitest": 63,
      "server-vitest": 308,
      "web-vitest": 284,
      "pilot-harness-vitest": 82,
      "worker-python": 80,
      "browser-playwright": 2,
      "pilot-load": 1,
    },
  );
});

test("manifest validation rejects open shapes, duplicate ownership, and unsafe empty runs", () => {
  assert.throws(
    () => validateRequiredTestManifest({ ...validManifest(), extra: true }),
    /REQUIRED_TEST_MANIFEST_SHAPE/,
  );
  assert.throws(
    () => validateRequiredTestManifest({ schemaVersion: 1, gates: [] }),
    /REQUIRED_TEST_MANIFEST_EMPTY/,
  );
  assert.throws(
    () =>
      validateRequiredTestManifest({
        ...validManifest(),
        gates: [{ ...validManifest().gates[0], unexpected: true }],
      }),
    /REQUIRED_TEST_GATE_SHAPE/,
  );
  assert.throws(
    () =>
      validateRequiredTestManifest({
        ...validManifest(),
        gates: [{ ...validManifest().gates[0], runner: "shell" }],
      }),
    /REQUIRED_TEST_RUNNER/,
  );
  assert.throws(
    () =>
      validateRequiredTestManifest({
        ...validManifest(),
        gates: [{ ...validManifest().gates[0], expectedTests: 0 }],
      }),
    /REQUIRED_TEST_EXPECTED_COUNT/,
  );
  assert.throws(
    () =>
      validateRequiredTestManifest({
        ...validManifest(),
        gates: [
          validManifest().gates[0],
          { ...validManifest().gates[0], report: "test-results/local-pilot/summaries/other.summary.json" },
        ],
      }),
    /REQUIRED_TEST_GATE_DUPLICATE/,
  );
  assert.throws(
    () =>
      validateRequiredTestManifest({
        ...validManifest(),
        gates: [
          validManifest().gates[0],
          {
            ...validManifest().gates[0],
            id: "other",
            report: validManifest().gates[0].report,
          },
        ],
      }),
    /REQUIRED_TEST_REPORT_DUPLICATE/,
  );
  assert.throws(
    () =>
      validateRequiredTestManifest({
        ...validManifest(),
        gates: [{ ...validManifest().gates[0], argv: ["vitest", "run", "--passWithNoTests"] }],
      }),
    /REQUIRED_TEST_EMPTY_RUN_FLAG/,
  );
});

test("manifest validation pins report ownership and focused-test guards", () => {
  assert.throws(
    () =>
      validateRequiredTestManifest({
        ...validManifest(),
        gates: [{ ...validManifest().gates[0], report: "../unit-vitest.summary.json" }],
      }),
    /REQUIRED_TEST_REPORT_PATH/,
  );
  assert.throws(
    () =>
      validateRequiredTestManifest({
        ...validManifest(),
        gates: [{ ...validManifest().gates[0], argv: ["pnpm", "exec", "vitest", "run"] }],
      }),
    /REQUIRED_TEST_FOCUS_GUARD/,
  );
});

test("runner adapters emit only the seven content-free counters", () => {
  const vitestGate = validManifest().gates[0];
  assert.deepEqual(
    adaptRunnerReport(vitestGate, {
      numTotalTests: 3,
      numPassedTests: 2,
      numFailedTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      numFailedTestSuites: 1,
      success: false,
      testResults: [{ title: "must never reach the summary" }],
    }),
    {
      expected: 3,
      executed: 3,
      passed: 2,
      failed: 2,
      skipped: 0,
      pending: 0,
      focused: 0,
    },
  );

  assert.deepEqual(
    adaptRunnerReport(
      {
        id: "worker-python",
        runner: "python-unittest",
        argv: [".venv/bin/python", "-m", "unittest", "discover", "-s", "services/worker/tests", "-v"],
        report: "test-results/local-pilot/summaries/worker-python.summary.json",
        expectedTests: 4,
      },
      {
        testsRun: 4,
        failures: 1,
        errors: 0,
        skipped: 1,
        expectedFailures: 1,
        unexpectedSuccesses: 0,
        focused: 0,
        capturedOutput: "must never reach the summary",
      },
    ),
    {
      expected: 4,
      executed: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      pending: 1,
      focused: 0,
    },
  );

  assert.deepEqual(
    adaptRunnerReport(
      {
        id: "browser-playwright",
        runner: "playwright",
        argv: ["pnpm", "exec", "playwright", "test", "--config", "apps/web/playwright.config.ts", "--reporter=json"],
        report: "test-results/local-pilot/summaries/browser-playwright.summary.json",
        expectedTests: 5,
      },
      {
        config: { forbidOnly: true },
        stats: { expected: 2, skipped: 1, unexpected: 1, flaky: 1 },
        suites: [{ title: "must never reach the summary" }],
      },
    ),
    {
      expected: 5,
      executed: 4,
      passed: 2,
      failed: 2,
      skipped: 1,
      pending: 0,
      focused: 0,
    },
  );

  assert.deepEqual(
    adaptRunnerReport(
      {
        id: "pilot-load",
        runner: "load",
        argv: ["pnpm", "load:pilot"],
        report: "test-results/local-pilot/summaries/pilot-load.summary.json",
        expectedTests: 1,
      },
      { ok: true, fixture: "controlled-pilot", rawMeasurements: ["must not leak"] },
    ),
    passingSummary(1),
  );
});

test("adapters fail closed on malformed reports and absent focus protection", () => {
  assert.throws(
    () => adaptRunnerReport(validManifest().gates[0], { numTotalTests: 3 }),
    /REQUIRED_TEST_RUNNER_REPORT/,
  );
  assert.throws(
    () =>
      adaptRunnerReport(
        {
          id: "browser-playwright",
          runner: "playwright",
          argv: ["pnpm", "exec", "playwright", "test"],
          report: "test-results/local-pilot/summaries/browser-playwright.summary.json",
          expectedTests: 1,
        },
        { config: { forbidOnly: false }, stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 } },
      ),
    /REQUIRED_TEST_FOCUS_GUARD/,
  );
});

test("summary validation accepts only exact non-negative integer counters", () => {
  const summary = passingSummary(3);
  assert.equal(validateTestSummary(summary), summary);
  assert.throws(
    () => validateTestSummary({ ...passingSummary(3), payload: "not content-free" }),
    /REQUIRED_TEST_SUMMARY_SHAPE/,
  );
  assert.throws(
    () => validateTestSummary({ ...passingSummary(3), passed: 2.5 }),
    /REQUIRED_TEST_SUMMARY_COUNT/,
  );
});

test("the closed manifest rejects missing, unregistered, skipped, focused, and count-drift reports", () => {
  const manifest = validManifest();
  const reportName = manifest.gates[0].report;

  assert.deepEqual(
    assertRequiredTestReports(manifest, new Map([[reportName, passingSummary(3)]])),
    { gates: 1, expectedTests: 3 },
  );
  assert.throws(
    () => assertRequiredTestReports(manifest, new Map()),
    /REQUIRED_TEST_REPORT_MISSING:unit-vitest/,
  );
  assert.throws(
    () =>
      assertRequiredTestReports(
        manifest,
        new Map([
          [reportName, passingSummary(3)],
          ["test-results/local-pilot/summaries/unregistered.summary.json", passingSummary(1)],
        ]),
      ),
    /REQUIRED_TEST_SUITE_UNREGISTERED/,
  );
  assert.throws(
    () =>
      assertRequiredTestReports(
        manifest,
        new Map([[reportName, { ...passingSummary(3), skipped: 1 }]]),
      ),
    /REQUIRED_TEST_GATE_FAILED:unit-vitest:skipped/,
  );
  assert.throws(
    () =>
      assertRequiredTestReports(
        manifest,
        new Map([[reportName, { ...passingSummary(3), focused: 1 }]]),
      ),
    /REQUIRED_TEST_GATE_FAILED:unit-vitest:focused/,
  );
  assert.throws(
    () =>
      assertRequiredTestReports(
        manifest,
        new Map([[reportName, passingSummary(2)]]),
      ),
    /REQUIRED_TEST_GATE_FAILED:unit-vitest:expected/,
  );
  assert.throws(
    () =>
      assertRequiredTestReports(
        manifest,
        new Map([[reportName, passingSummary(0)]]),
      ),
    /REQUIRED_TEST_GATE_FAILED:unit-vitest:expected/,
  );
});

test("summary and verification CLIs write only registered content-free reports", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "lo-required-gates-"));
  cleanupPaths.push(root);
  const manifest = {
    schemaVersion: 1,
    gates: [
      {
        id: "pilot-load",
        runner: "load",
        argv: ["pnpm", "load:pilot"],
        report: "test-results/local-pilot/summaries/pilot-load.summary.json",
        expectedTests: 1,
      },
    ],
  };
  const manifestPath = join(root, "manifest.json");
  const rawPath = join(root, "raw-load.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await writeFile(
    rawPath,
    `${JSON.stringify({ ok: true, fixture: "controlled-pilot", secretPayload: "DO_NOT_COPY" })}\n`,
    { mode: 0o600 },
  );

  const writeResult = spawnSync(
    process.execPath,
    [writeSummaryScript, "--manifest", "manifest.json", "--gate", "pilot-load", "--input", "raw-load.json", "--exit-code", "0"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(writeResult.status, 0, writeResult.stderr);
  assert.equal(writeResult.stdout, "test-summary: PASS\n");

  const reportPath = join(root, manifest.gates[0].report);
  assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), passingSummary(1));
  assert.doesNotMatch(await readFile(reportPath, "utf8"), /DO_NOT_COPY/);

  const overwriteResult = spawnSync(
    process.execPath,
    [writeSummaryScript, "--manifest", "manifest.json", "--gate", "pilot-load", "--input", "raw-load.json", "--exit-code", "0"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(overwriteResult.status, 1);
  assert.equal(overwriteResult.stderr, "REQUIRED_TEST_SUMMARY_EXISTS\n");

  const verifyResult = spawnSync(
    process.execPath,
    [verifySummariesScript, "--manifest", "manifest.json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(verifyResult.status, 0, verifyResult.stderr);
  assert.equal(verifyResult.stdout, "required-tests: PASS gates=1 expected=1\n");

  const unregisteredPath = join(
    root,
    "test-results/local-pilot/summaries/unregistered.summary.json",
  );
  await mkdir(dirname(unregisteredPath), { recursive: true });
  await writeFile(unregisteredPath, `${JSON.stringify(passingSummary(1))}\n`);
  const unregisteredResult = spawnSync(
    process.execPath,
    [verifySummariesScript, "--manifest", "manifest.json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(unregisteredResult.status, 1);
  assert.equal(unregisteredResult.stderr, "REQUIRED_TEST_SUITE_UNREGISTERED\n");
  assert.doesNotMatch(unregisteredResult.stderr, /DO_NOT_COPY/);

  const nonzeroRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "lo-required-gates-nonzero-"));
  cleanupPaths.push(nonzeroRoot);
  await writeFile(join(nonzeroRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await writeFile(join(nonzeroRoot, "raw-load.json"), `${JSON.stringify({ ok: true, fixture: "controlled-pilot" })}\n`, { mode: 0o600 });
  const nonzeroResult = spawnSync(
    process.execPath,
    [writeSummaryScript, "--manifest", "manifest.json", "--gate", "pilot-load", "--input", "raw-load.json", "--exit-code", "1"],
    { cwd: nonzeroRoot, encoding: "utf8" },
  );
  assert.equal(nonzeroResult.status, 1);
  assert.equal(nonzeroResult.stderr, "REQUIRED_TEST_RUNNER_EXIT_NONZERO\n");

  const symlinkRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "lo-required-gates-symlink-"));
  const outside = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "lo-required-gates-outside-"));
  cleanupPaths.push(symlinkRoot, outside);
  await writeFile(join(symlinkRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await writeFile(join(symlinkRoot, "raw-load.json"), `${JSON.stringify({ ok: true, fixture: "controlled-pilot" })}\n`, { mode: 0o600 });
  await mkdir(join(symlinkRoot, "test-results/local-pilot"), { recursive: true, mode: 0o700 });
  await symlink(outside, join(symlinkRoot, "test-results/local-pilot/summaries"));
  const symlinkResult = spawnSync(
    process.execPath,
    [writeSummaryScript, "--manifest", "manifest.json", "--gate", "pilot-load", "--input", "raw-load.json", "--exit-code", "0"],
    { cwd: symlinkRoot, encoding: "utf8" },
  );
  assert.equal(symlinkResult.status, 1);
  assert.equal(symlinkResult.stderr, "REQUIRED_TEST_SUMMARY_DIRECTORY_INVALID\n");
  await assert.rejects(stat(join(outside, "pilot-load.summary.json")), { code: "ENOENT" });
});

test("the Python unittest reporter emits counts without test names or failure content", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "lo-python-report-"));
  cleanupPaths.push(root);
  const testsDirectory = join(root, "tests");
  await mkdir(testsDirectory, { recursive: true });
  await writeFile(
    join(testsDirectory, "test_sample.py"),
    [
      "import unittest",
      "",
      "class SampleTest(unittest.TestCase):",
      "    def test_passes(self):",
      "        self.assertTrue(True)",
      "",
      "    @unittest.skip('SENSITIVE_SKIP_REASON')",
      "    def test_skips(self):",
      "        self.fail('SENSITIVE_FAILURE_CONTENT')",
      "",
    ].join("\n"),
  );

  const result = spawnSync(
    projectPython,
    [pythonReportScript, "--start-directory", testsDirectory],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /SampleTest|SENSITIVE|test_passes|test_skips/);
  assert.deepEqual(JSON.parse(result.stdout), {
    testsRun: 2,
    failures: 0,
    errors: 0,
    skipped: 1,
    expectedFailures: 0,
    unexpectedSuccesses: 0,
    focused: 0,
  });
});
