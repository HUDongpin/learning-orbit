const MANIFEST_KEYS = ["gates", "schemaVersion"];
const GATE_KEYS = ["argv", "expectedTests", "id", "report", "runner"];
const SUMMARY_KEYS = [
  "executed",
  "expected",
  "failed",
  "focused",
  "passed",
  "pending",
  "skipped",
];
const RUNNERS = new Set(["vitest", "python-unittest", "playwright", "load"]);
const REPORT_PREFIX = "test-results/local-pilot/summaries/";
const REPORT_SUFFIX = ".summary.json";

function fail(code) {
  throw new Error(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function requireCount(value) {
  if (!isCount(value)) fail("REQUIRED_TEST_RUNNER_REPORT");
  return value;
}

function hasArg(argv, name, value) {
  return (
    argv.includes(`${name}=${value}`) ||
    argv.some((argument, index) => argument === name && argv[index + 1] === value)
  );
}

function validateGate(gate) {
  if (!hasExactKeys(gate, GATE_KEYS)) fail("REQUIRED_TEST_GATE_SHAPE");
  if (typeof gate.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gate.id)) {
    fail("REQUIRED_TEST_GATE_ID");
  }
  if (!RUNNERS.has(gate.runner)) fail("REQUIRED_TEST_RUNNER");
  if (
    !Array.isArray(gate.argv) ||
    gate.argv.length === 0 ||
    gate.argv.some(
      (argument) =>
        typeof argument !== "string" || argument.length === 0 || argument.includes("\0"),
    )
  ) {
    fail("REQUIRED_TEST_ARGV");
  }
  if (gate.argv.some((argument) => argument.startsWith("--passWithNoTests"))) {
    fail("REQUIRED_TEST_EMPTY_RUN_FLAG");
  }
  if (gate.runner === "vitest" && !hasArg(gate.argv, "--allowOnly", "false")) {
    fail("REQUIRED_TEST_FOCUS_GUARD");
  }
  const expectedReport = `${REPORT_PREFIX}${gate.id}${REPORT_SUFFIX}`;
  if (gate.report !== expectedReport) fail("REQUIRED_TEST_REPORT_PATH");
  if (!Number.isSafeInteger(gate.expectedTests) || gate.expectedTests <= 0) {
    fail("REQUIRED_TEST_EXPECTED_COUNT");
  }
  return gate;
}

export function validateRequiredTestManifest(manifest) {
  if (!hasExactKeys(manifest, MANIFEST_KEYS)) fail("REQUIRED_TEST_MANIFEST_SHAPE");
  if (manifest.schemaVersion !== 1) fail("REQUIRED_TEST_MANIFEST_VERSION");
  if (!Array.isArray(manifest.gates) || manifest.gates.length === 0) {
    fail("REQUIRED_TEST_MANIFEST_EMPTY");
  }

  const ids = new Set();
  const reports = new Set();
  for (const gate of manifest.gates) {
    if (!hasExactKeys(gate, GATE_KEYS)) fail("REQUIRED_TEST_GATE_SHAPE");
    if (ids.has(gate.id)) fail("REQUIRED_TEST_GATE_DUPLICATE");
    if (reports.has(gate.report)) fail("REQUIRED_TEST_REPORT_DUPLICATE");
    validateGate(gate);
    ids.add(gate.id);
    reports.add(gate.report);
  }
  return manifest;
}

export function validateTestSummary(summary) {
  if (!hasExactKeys(summary, SUMMARY_KEYS)) fail("REQUIRED_TEST_SUMMARY_SHAPE");
  if (SUMMARY_KEYS.some((key) => !isCount(summary[key]))) {
    fail("REQUIRED_TEST_SUMMARY_COUNT");
  }
  return summary;
}

function adaptVitestReport(gate, report) {
  if (!isRecord(report) || typeof report.success !== "boolean") {
    fail("REQUIRED_TEST_RUNNER_REPORT");
  }
  const expected = requireCount(report.numTotalTests);
  const passed = requireCount(report.numPassedTests);
  const failedTests = requireCount(report.numFailedTests);
  const skipped = requireCount(report.numPendingTests);
  const pending = requireCount(report.numTodoTests);
  const failedSuites = requireCount(report.numFailedTestSuites);
  const reportedFocused = report.numFocusedTests === undefined ? 0 : requireCount(report.numFocusedTests);
  if (!hasArg(gate.argv, "--allowOnly", "false")) fail("REQUIRED_TEST_FOCUS_GUARD");

  return {
    expected,
    executed: passed + failedTests,
    passed,
    failed: Math.max(failedTests + failedSuites, report.success ? 0 : 1),
    skipped,
    pending,
    focused: reportedFocused,
  };
}

function adaptPythonUnittestReport(report) {
  if (!isRecord(report)) fail("REQUIRED_TEST_RUNNER_REPORT");
  const expected = requireCount(report.testsRun);
  const failures = requireCount(report.failures);
  const errors = requireCount(report.errors);
  const skipped = requireCount(report.skipped);
  const pending = requireCount(report.expectedFailures);
  const unexpectedSuccesses = requireCount(report.unexpectedSuccesses);
  const focused = requireCount(report.focused);
  const passed = expected - failures - errors - skipped - pending - unexpectedSuccesses;
  if (passed < 0) fail("REQUIRED_TEST_RUNNER_REPORT");

  return {
    expected,
    executed: expected - skipped,
    passed,
    failed: failures + errors + unexpectedSuccesses,
    skipped,
    pending,
    focused,
  };
}

function adaptPlaywrightReport(report) {
  if (!isRecord(report) || !isRecord(report.config) || !isRecord(report.stats)) {
    fail("REQUIRED_TEST_RUNNER_REPORT");
  }
  if (report.config.forbidOnly !== true) fail("REQUIRED_TEST_FOCUS_GUARD");
  const passed = requireCount(report.stats.expected);
  const skipped = requireCount(report.stats.skipped);
  const unexpected = requireCount(report.stats.unexpected);
  const flaky = requireCount(report.stats.flaky);
  const failed = unexpected + flaky;

  return {
    expected: passed + skipped + failed,
    executed: passed + failed,
    passed,
    failed,
    skipped,
    pending: 0,
    focused: 0,
  };
}

function adaptLoadReport(report) {
  if (!isRecord(report) || typeof report.ok !== "boolean" || report.fixture !== "controlled-pilot") {
    fail("REQUIRED_TEST_RUNNER_REPORT");
  }
  return {
    expected: 1,
    executed: 1,
    passed: report.ok ? 1 : 0,
    failed: report.ok ? 0 : 1,
    skipped: 0,
    pending: 0,
    focused: 0,
  };
}

export function adaptRunnerReport(gate, report) {
  validateGate(gate);
  let summary;
  switch (gate.runner) {
    case "vitest":
      summary = adaptVitestReport(gate, report);
      break;
    case "python-unittest":
      summary = adaptPythonUnittestReport(report);
      break;
    case "playwright":
      summary = adaptPlaywrightReport(report);
      break;
    case "load":
      summary = adaptLoadReport(report);
      break;
    default:
      fail("REQUIRED_TEST_RUNNER");
  }
  return validateTestSummary(summary);
}

function assertGatePass(gate, summary) {
  if (summary.expected !== gate.expectedTests || summary.expected === 0) {
    fail(`REQUIRED_TEST_GATE_FAILED:${gate.id}:expected`);
  }
  for (const counter of ["failed", "skipped", "pending", "focused"]) {
    if (summary[counter] !== 0) fail(`REQUIRED_TEST_GATE_FAILED:${gate.id}:${counter}`);
  }
  if (summary.executed !== summary.expected) {
    fail(`REQUIRED_TEST_GATE_FAILED:${gate.id}:executed`);
  }
  if (summary.passed !== summary.executed) {
    fail(`REQUIRED_TEST_GATE_FAILED:${gate.id}:passed`);
  }
}

export function assertRequiredTestReports(manifest, reports) {
  validateRequiredTestManifest(manifest);
  if (!(reports instanceof Map)) fail("REQUIRED_TEST_REPORT_SET");

  const registeredReports = new Set(manifest.gates.map(({ report }) => report));
  for (const report of reports.keys()) {
    if (!registeredReports.has(report)) fail("REQUIRED_TEST_SUITE_UNREGISTERED");
  }

  let expectedTests = 0;
  for (const gate of manifest.gates) {
    if (!reports.has(gate.report)) fail(`REQUIRED_TEST_REPORT_MISSING:${gate.id}`);
    const summary = validateTestSummary(reports.get(gate.report));
    assertGatePass(gate, summary);
    expectedTests += gate.expectedTests;
  }

  return { gates: manifest.gates.length, expectedTests };
}

export const requiredTestSummaryKeys = Object.freeze([
  "expected",
  "executed",
  "passed",
  "failed",
  "skipped",
  "pending",
  "focused",
]);
