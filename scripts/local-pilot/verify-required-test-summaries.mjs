import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertRequiredTestReports,
  validateRequiredTestManifest,
} from "./required-test-gates.mjs";
import { assertOwnedSummaryFile, ownedSummaryDirectory } from "./summary-storage.mjs";

const reportPrefix = "test-results/local-pilot/summaries/";

function fail(code) {
  throw new Error(code);
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--manifest" || !argv[1]) {
    fail("REQUIRED_TEST_CLI_ARGS");
  }
  return { manifest: argv[1] };
}

async function readJson(path, errorCode) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(errorCode);
  }
}

async function readSummaryEntries(root, registeredReports) {
  const summaryDirectory = await ownedSummaryDirectory(root, { create: false });
  if (!summaryDirectory) return new Map();
  let entries;
  try {
    entries = await readdir(summaryDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    fail("REQUIRED_TEST_REPORT_SET");
  }

  const reports = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".summary.json")) {
      fail("REQUIRED_TEST_REPORT_SET");
    }
    const reportName = `${reportPrefix}${entry.name}`;
    if (!registeredReports.has(reportName)) fail("REQUIRED_TEST_SUITE_UNREGISTERED");
    const reportPath = resolve(summaryDirectory, entry.name);
    await assertOwnedSummaryFile(reportPath);
    reports.set(
      reportName,
      await readJson(reportPath, "REQUIRED_TEST_SUMMARY_READ_FAILED"),
    );
  }
  return reports;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = process.cwd();
  const manifest = validateRequiredTestManifest(
    await readJson(resolve(root, options.manifest), "REQUIRED_TEST_MANIFEST_READ_FAILED"),
  );
  const registeredReports = new Set(manifest.gates.map(({ report }) => report));
  const result = assertRequiredTestReports(manifest, await readSummaryEntries(root, registeredReports));
  process.stdout.write(
    `required-tests: PASS gates=${result.gates} expected=${result.expectedTests}\n`,
  );
}

try {
  await main();
} catch (error) {
  const code =
    typeof error?.message === "string" && error.message.startsWith("REQUIRED_TEST_")
      ? error.message
      : "REQUIRED_TEST_VERIFICATION_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
