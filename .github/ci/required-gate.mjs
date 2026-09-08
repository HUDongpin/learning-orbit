/**
 * Run one gate from the required-test manifest and judge it with the
 * repository's own gate policy.
 *
 * The counts live in `tests/pilot/required-test-manifest.v1.json` and the rules
 * that read them live in `scripts/local-pilot/required-test-gates.mjs`. Both are
 * imported here rather than restated, because a second copy of "492 server
 * tests" in a workflow file would be a third place to forget, and a
 * hand-written pass/fail rule in CI could disagree with the harness about what
 * passing means. Nothing in this file decides anything; it runs the manifest's
 * own argv and hands the result to the manifest's own judge.
 *
 * It deliberately writes no summary. `test-results/local-pilot/summaries/` is
 * owned by the pilot harness and its contents are release evidence; a file put
 * there by a Linux runner could be mistaken for something it is not.
 *
 *   node .github/ci/required-gate.mjs <gate-id>
 *   node .github/ci/required-gate.mjs <gate-id> --subset <count> <extra argv...>
 *
 * `--subset` is for the one gate a Linux runner cannot run whole. It keeps
 * every rule the harness applies, and swaps the manifest's count for a second
 * pinned count that the caller must state.
 *
 * Stating it is the point. An earlier version substituted whatever count it
 * observed and only checked that the run was strictly smaller than the
 * manifest's, which bounds a stale exclusion from above and nothing from
 * below: an exclusion glob matching most of a gate's files ran a fraction of
 * it and still reported PASS. A subset that can shrink silently has switched off the
 * count check for the one gate that needed it most - so the count is pinned on
 * both sides, and either an exclusion that stopped excluding or one that
 * started excluding more is a failure that names itself.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adaptRunnerReport,
  assertRequiredTestReports,
} from "../../scripts/local-pilot/required-test-gates.mjs";

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const [gateId, ...rest] = process.argv.slice(2);
if (!gateId) {
  process.stderr.write("usage: required-gate.mjs <gate-id> [--subset <count> <extra argv...>]\n");
  process.exit(2);
}
const subset = rest[0] === "--subset";
if (rest.length > 0 && !subset) {
  process.stderr.write("extra argv is only accepted after --subset\n");
  process.exit(2);
}
const subsetExpected = subset ? Number(rest[1]) : undefined;
if (subset && !Number.isSafeInteger(subsetExpected)) {
  process.stderr.write("--subset requires the exact number of tests the subset must run\n");
  process.exit(2);
}
const extraArgv = subset ? rest.slice(2) : [];

const manifest = JSON.parse(
  readFileSync(resolve(root, "tests/pilot/required-test-manifest.v1.json"), "utf8"),
);
const gate = manifest.gates.find(({ id }) => id === gateId);
if (!gate) {
  process.stderr.write(`no such gate in the manifest: ${gateId}\n`);
  process.exit(2);
}

// The manifest addresses its Python runner by the checkout-relative interpreter
// the harness insists on; every other gate is a pnpm script found on the PATH
// the closed environment supplies.
const executable = gate.argv[0] === ".venv/bin/python"
  ? resolve(root, ".venv/bin/python")
  : gate.argv[0];
const argv = [...gate.argv.slice(1), ...extraArgv];

process.stdout.write(`gate ${gate.id}: ${executable} ${argv.join(" ")}\n`);

const run = spawnSync(executable, argv, {
  cwd: root,
  // Already closed by .github/ci/closed-env.sh; this process adds nothing.
  env: process.env,
  shell: false,
  encoding: "utf8",
  maxBuffer: MAX_REPORT_BYTES,
  // The report is read from stdout; stderr goes straight to the job log so a
  // failing suite is readable without unpacking JSON.
  stdio: ["ignore", "pipe", "inherit"],
});

if (run.error) {
  process.stderr.write(`gate ${gate.id}: runner did not start: ${run.error.message}\n`);
  process.exit(1);
}

let summary;
try {
  summary = adaptRunnerReport(gate, JSON.parse(run.stdout));
} catch (error) {
  process.stderr.write(`gate ${gate.id}: unreadable report (${error?.message ?? error})\n`);
  process.stderr.write(run.stdout.slice(0, 4096));
  process.exit(1);
}

process.stdout.write(
  `gate ${gate.id}: manifest expects ${gate.expectedTests}, ran ${summary.expected}`
  + ` (passed ${summary.passed}, failed ${summary.failed}, skipped ${summary.skipped},`
  + ` pending ${summary.pending}, focused ${summary.focused})\n`,
);

// A judged gate is a passing one, so the exit code is checked first: a runner
// that died before writing a usable report has already been caught above, and
// one that wrote a report while failing is caught by the policy below.
let failure = run.status === 0 ? undefined : `runner exit ${run.status}`;

const judged = subset ? { ...gate, expectedTests: subsetExpected } : gate;
if (subset && subsetExpected >= gate.expectedTests) {
  failure ??= `subset pins ${subsetExpected} of ${gate.expectedTests} tests:`
    + " the exclusion is stale, remove it or re-scope it";
}
// Bounded from below as well: the pinned subset is a count to meet, not a
// ceiling to fall under. `assertRequiredTestReports` compares against
// `judged.expectedTests`, so a run that lost tests fails here rather than
// reporting PASS over a fraction of the gate.
try {
  assertRequiredTestReports(
    { schemaVersion: 1, gates: [judged] },
    new Map([[judged.report, summary]]),
  );
} catch (error) {
  failure ??= error?.message ?? String(error);
}

if (failure) {
  process.stderr.write(`gate ${gate.id}: FAILED - ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`gate ${gate.id}: PASS${subset ? " (subset)" : ""}\n`);
