import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  adaptRunnerReport,
  assertRequiredTestReports,
  validateRequiredTestManifest,
} from "./required-test-gates.mjs";
import { ownedSummaryDirectory } from "./summary-storage.mjs";

const execFileAsync = promisify(execFile);
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const RUNNER_TIMEOUT_MS = 15 * 60 * 1_000;

export const REQUIRED_GATE_ORDER = Object.freeze([
  "contracts-vitest",
  "server-vitest",
  "web-vitest",
  "pilot-harness-vitest",
  "worker-python",
  "browser-playwright",
  "pilot-load",
]);

const REQUIRED_RUNNERS = Object.freeze([
  "vitest",
  "vitest",
  "vitest",
  "vitest",
  "python-unittest",
  "playwright",
  "load",
]);

function fail(code) {
  throw new Error(code);
}

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) {
    fail("REQUIRED_TEST_CLOCK_INVALID");
  }
  return value.toISOString();
}

export function assertRequiredGateOrder(manifest) {
  validateRequiredTestManifest(manifest);
  if (manifest.gates.length !== REQUIRED_GATE_ORDER.length
    || manifest.gates.some((gate, index) => gate.id !== REQUIRED_GATE_ORDER[index])) {
    fail("REQUIRED_TEST_GATE_ORDER");
  }
  if (manifest.gates.some((gate, index) => gate.runner !== REQUIRED_RUNNERS[index])) {
    fail("REQUIRED_TEST_GATE_RUNNER");
  }
  return manifest;
}

export function assertRequiredGateEntrypoints(manifest, rootPackage) {
  assertRequiredGateOrder(manifest);
  const loadGate = manifest.gates.find(({ id }) => id === "pilot-load");
  if (!loadGate || loadGate.argv.length !== 2 || loadGate.argv[0] !== "pnpm"
    || loadGate.argv[1] !== "load:pilot") {
    fail("REQUIRED_TEST_ENTRYPOINT_INVALID:pilot-load");
  }
  const script = rootPackage?.scripts?.["load:pilot"];
  if (typeof script !== "string" || script.length === 0 || script.length > 512
    || /[\r\n\u0000]/.test(script)) {
    fail("REQUIRED_TEST_ENTRYPOINT_MISSING:pilot-load");
  }
  return true;
}

export function sanitizeGateArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0
    || argv.some((argument) => typeof argument !== "string" || argument.length === 0
      || argument.includes("\u0000"))) {
    fail("REQUIRED_TEST_ARGV");
  }
  for (const argument of argv) {
    if (/^(?:--)?(?:token|cookie|password|secret|database[-_]url)(?:=|$)/i.test(argument)
      || /(?:[?&](?:token|cookie|password|secret)=|postgres(?:ql)?:\/\/)/i.test(argument)) {
      fail("REQUIRED_TEST_ARGV_SENSITIVE");
    }
    try {
      const value = new URL(argument);
      if (value.username || value.password) fail("REQUIRED_TEST_ARGV_SENSITIVE");
    } catch (error) {
      if (error instanceof Error && error.message === "REQUIRED_TEST_ARGV_SENSITIVE") throw error;
    }
  }
  return Object.freeze([...argv]);
}

function assertEnvironment(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)
    || Object.entries(environment).some(([key, value]) => !/^[A-Z][A-Z0-9_]*$/.test(key)
      || typeof value !== "string" || value.includes("\u0000"))) {
    fail("REQUIRED_TEST_ENVIRONMENT_INVALID");
  }
}

function invocation(gate, { checkout, pnpmPath, pythonPath }) {
  if (!isAbsolute(checkout) || !isAbsolute(pnpmPath) || !isAbsolute(pythonPath)
    || resolve(pythonPath) !== resolve(checkout, ".venv/bin/python")) {
    fail("REQUIRED_TEST_EXECUTABLE_INVALID");
  }
  const sanitized = sanitizeGateArgv(gate.argv);
  const expectedPrefix = gate.runner === "python-unittest" ? ".venv/bin/python" : "pnpm";
  if (sanitized[0] !== expectedPrefix) fail("REQUIRED_TEST_EXECUTABLE_INVALID");
  return Object.freeze({
    executable: gate.runner === "python-unittest" ? pythonPath : pnpmPath,
    argv: Object.freeze(sanitized.slice(1)),
    sanitizedArgv: sanitized,
  });
}

async function defaultRunCommand(executable, argv, options) {
  try {
    const { stdout } = await execFileAsync(executable, argv, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      encoding: "utf8",
      maxBuffer: MAX_REPORT_BYTES,
      windowsHide: true,
      signal: options.signal,
      timeout: RUNNER_TIMEOUT_MS,
      killSignal: "SIGTERM",
    });
    return { exitCode: 0, stdout };
  } catch {
    fail("REQUIRED_TEST_RUNNER_EXIT_NONZERO");
  }
}

function parseRunnerReport(result) {
  if (!result || result.exitCode !== 0 || typeof result.stdout !== "string") {
    fail("REQUIRED_TEST_RUNNER_EXIT_NONZERO");
  }
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_REPORT_BYTES
    || result.stdout.includes("\u0000")) {
    fail("REQUIRED_TEST_RUNNER_REPORT");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("REQUIRED_TEST_RUNNER_REPORT");
  }
}

async function defaultWriteSummary(checkout, gate, summary) {
  const directory = await ownedSummaryDirectory(checkout, { create: true });
  const path = join(directory, `${gate.id}.summary.json`);
  try {
    await writeFile(path, `${JSON.stringify(summary)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(path, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") fail("REQUIRED_TEST_SUMMARY_EXISTS");
    fail("REQUIRED_TEST_SUMMARY_WRITE_FAILED");
  }
}

function selectedGates(manifest, gateIds) {
  if (!Array.isArray(gateIds) || gateIds.length === 0
    || gateIds.some((id) => typeof id !== "string")
    || new Set(gateIds).size !== gateIds.length) {
    fail("REQUIRED_TEST_GATE_SELECTION");
  }
  const indices = gateIds.map((id) => manifest.gates.findIndex((gate) => gate.id === id));
  if (indices.some((index) => index < 0)
    || indices.some((index, position) => position > 0 && index <= indices[position - 1])) {
    fail("REQUIRED_TEST_GATE_SELECTION");
  }
  return indices.map((index) => manifest.gates[index]);
}

export async function executeRequiredGateSet({
  manifest,
  gateIds,
  checkout,
  pnpmPath,
  pythonPath,
  environment,
  runCommand = defaultRunCommand,
  writeSummary = (gate, summary) => defaultWriteSummary(checkout, gate, summary),
  recordReceipt = async () => undefined,
  now = () => new Date(),
  signal,
}) {
  assertRequiredGateOrder(manifest);
  assertEnvironment(environment);
  if (typeof runCommand !== "function" || typeof writeSummary !== "function"
    || typeof recordReceipt !== "function"
    || typeof now !== "function") {
    fail("REQUIRED_TEST_RUNNER_CONFIG_INVALID");
  }
  const gates = selectedGates(manifest, gateIds);
  const receipts = [];
  for (const gate of gates) {
    const startedAt = timestamp(now);
    const command = invocation(gate, { checkout, pnpmPath, pythonPath });
    let result;
    let summary;
    try {
      try {
        result = await runCommand(command.executable, [...command.argv], {
          cwd: checkout,
          env: { ...environment },
          shell: false,
          signal,
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("REQUIRED_TEST_")) throw error;
        fail("REQUIRED_TEST_RUNNER_EXIT_NONZERO");
      }
      summary = adaptRunnerReport(gate, parseRunnerReport(result));
      assertRequiredTestReports(
        { schemaVersion: 1, gates: [gate] },
        new Map([[gate.report, summary]]),
      );
      await writeSummary(gate, summary);
      const summaryBytes = `${JSON.stringify(summary)}\n`;
      const receipt = Object.freeze({
        id: gate.id,
        status: "passed",
        argv: command.sanitizedArgv,
        startedAt,
        endedAt: timestamp(now),
        exitCode: 0,
        reportSha256: createHash("sha256").update(summaryBytes).digest("hex"),
        summary: Object.freeze({ ...summary }),
        noSkipCount: summary.skipped + summary.pending + summary.focused,
        expectedTests: gate.expectedTests,
      });
      await recordReceipt(receipt);
      receipts.push(receipt);
    } catch (error) {
      const summaryBytes = summary ? `${JSON.stringify(summary)}\n` : undefined;
      await recordReceipt(Object.freeze({
        id: gate.id,
        status: "failed",
        argv: command.sanitizedArgv,
        startedAt,
        endedAt: timestamp(now),
        exitCode: Number.isSafeInteger(result?.exitCode) ? result.exitCode : 1,
        reportSha256: summaryBytes
          ? createHash("sha256").update(summaryBytes).digest("hex")
          : null,
        summary: summary ? Object.freeze({ ...summary }) : null,
        noSkipCount: summary ? summary.skipped + summary.pending + summary.focused : null,
        expectedTests: gate.expectedTests,
      }));
      throw error;
    }
  }
  return Object.freeze(receipts);
}
