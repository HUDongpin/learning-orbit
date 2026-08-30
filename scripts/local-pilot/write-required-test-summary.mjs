import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  adaptRunnerReport,
  validateRequiredTestManifest,
} from "./required-test-gates.mjs";
import { ownedSummaryDirectory } from "./summary-storage.mjs";

function fail(code) {
  throw new Error(code);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !["--manifest", "--gate", "--input", "--exit-code"].includes(name) ||
      typeof value !== "string" ||
      value.length === 0 ||
      values.has(name)
    ) {
      fail("REQUIRED_TEST_CLI_ARGS");
    }
    values.set(name, value);
  }
  if (values.size !== 4) fail("REQUIRED_TEST_CLI_ARGS");
  return {
    manifest: values.get("--manifest"),
    gate: values.get("--gate"),
    input: values.get("--input"),
    exitCode: values.get("--exit-code"),
  };
}

async function readJson(path, errorCode) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(errorCode);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.exitCode !== "0") fail("REQUIRED_TEST_RUNNER_EXIT_NONZERO");
  const root = process.cwd();
  const manifest = validateRequiredTestManifest(
    await readJson(resolve(root, options.manifest), "REQUIRED_TEST_MANIFEST_READ_FAILED"),
  );
  const gate = manifest.gates.find(({ id }) => id === options.gate);
  if (!gate) fail("REQUIRED_TEST_GATE_UNREGISTERED");

  const rawReport = await readJson(
    resolve(root, options.input),
    "REQUIRED_TEST_RUNNER_REPORT",
  );
  const summary = adaptRunnerReport(gate, rawReport);
  const summaryDirectory = await ownedSummaryDirectory(root, { create: true });
  const outputPath = resolve(summaryDirectory, `${gate.id}.summary.json`);
  try {
    await writeFile(outputPath, `${JSON.stringify(summary)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(outputPath, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") fail("REQUIRED_TEST_SUMMARY_EXISTS");
    fail("REQUIRED_TEST_SUMMARY_WRITE_FAILED");
  }
  process.stdout.write("test-summary: PASS\n");
}

try {
  await main();
} catch (error) {
  const code =
    typeof error?.message === "string" && error.message.startsWith("REQUIRED_TEST_")
      ? error.message
      : "REQUIRED_TEST_SUMMARY_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
