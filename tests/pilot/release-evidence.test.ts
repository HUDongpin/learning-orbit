import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it as test } from "vitest";

import {
  buildReleaseEvidenceChain,
  checkGateCoverage,
  checkHumanAuthority,
  HUMAN_AUTHORITY_RECORDS,
  listReceipts,
} from "../../scripts/release-evidence.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPORT = "a".repeat(64);

const manifest = {
  schemaVersion: 1,
  gates: [
    { id: "server-vitest", expectedTests: 12 },
    { id: "worker-python", expectedTests: 5 },
  ],
};

function gate(id: string, expectedTests: number, override: Record<string, unknown> = {}) {
  return {
    id, status: "passed", expectedTests, noSkipCount: 0,
    reportSha256: REPORT, summary: { total: expectedTests },
    ...override,
  };
}

function receipt(override: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, runId: "0123456789abcdef", sourceSha: SHA, status: "passed",
    startedAt: "2026-09-07T12:00:00.000Z",
    gates: [gate("server-vitest", 12), gate("worker-python", 5)],
    ...override,
  };
}

function git(overrides: Record<string, string> = {}) {
  const answers: Record<string, string> = {
    "rev-parse HEAD": SHA,
    "status --porcelain=v1": "",
    "show -s --format=%cI HEAD": "2026-09-07T11:00:00.000Z",
    ...overrides,
  };
  return async (argv: string[]) => {
    const key = argv.join(" ");
    if (!(key in answers)) throw new Error(`UNEXPECTED_GIT:${key}`);
    return { stdout: `${answers[key]}\n` };
  };
}

async function chainFor(over: Record<string, unknown> = {}, gitOver: Record<string, string> = {}) {
  return buildReleaseEvidenceChain({
    repository, receipt: receipt(over), manifest, manifestBytes: JSON.stringify(manifest),
    programContracts: { inconsistent: [], outstanding: ["multimodal.derive.v1"] },
    runGit: git(gitOver),
  });
}

test("a complete run at the frozen commit passes the engineering evidence", async () => {
  const chain = await chainFor();
  assert.equal(chain.ok, true);
  assert.equal(chain.problems.length, 0);
  assert.equal(chain.sourceSha, SHA);
  assert.deepEqual(chain.gates.map((g: { gate: string }) => g.gate), ["server-vitest", "worker-python"]);
  assert.match(chain.chainSha256, /^[0-9a-f]{64}$/);
});

test("engineering evidence alone is never admissible for a classroom", async () => {
  const chain = await chainFor();
  assert.equal(chain.ok, true);
  // The three signed human records are exactly what no amount of green test
  // output can supply, so a chain with none of them says so.
  assert.equal(chain.admissible, false);
  assert.deepEqual(chain.humanAuthority.map((r: { held: boolean }) => r.held), [false, false, false]);
});

test("holding all three human records makes the release admissible", () => {
  const held = checkHumanAuthority(HUMAN_AUTHORITY_RECORDS.map((r) => ({ kind: r.kind })));
  assert.equal(held.every((record) => record.held), true);
});

test("a gate the manifest requires and the run never executed fails the chain", async () => {
  const chain = await chainFor({ gates: [gate("server-vitest", 12)] });
  assert.equal(chain.ok, false);
  assert.deepEqual(chain.problems, [{ gate: "worker-python", code: "GATE_NOT_RUN" }]);
});

test("a passing gate that ran a different number of tests is drift, not evidence", () => {
  const { problems } = checkGateCoverage(
    receipt({ gates: [gate("server-vitest", 12, { summary: { total: 11 } }), gate("worker-python", 5)] }),
    manifest,
  );
  assert.deepEqual(problems, [{ gate: "server-vitest", code: "GATE_TEST_COUNT_DRIFT" }]);
});

test("a gate that skipped a test did not run the suite the manifest pinned", () => {
  const { problems } = checkGateCoverage(
    receipt({ gates: [gate("server-vitest", 12, { noSkipCount: 1 }), gate("worker-python", 5)] }),
    manifest,
  );
  assert.deepEqual(problems, [{ gate: "server-vitest", code: "GATE_TESTS_NOT_ALL_RUN" }]);
});

test("a gate present in the run but dropped from the manifest is a disagreement", () => {
  const { problems } = checkGateCoverage(
    receipt({ gates: [gate("server-vitest", 12), gate("worker-python", 5), gate("ghost-vitest", 1)] }),
    manifest,
  );
  assert.deepEqual(problems, [{ gate: "ghost-vitest", code: "GATE_NOT_IN_MANIFEST" }]);
});

test("evidence for a commit that is no longer HEAD is refused", async () => {
  const chain = await chainFor({}, { "rev-parse HEAD": "f".repeat(40) });
  assert.equal(chain.ok, false);
  assert.equal(chain.problems.some((p: { code: string }) => p.code === "EVIDENCE_NOT_AT_HEAD"), true);
});

test("a source commit made after the evidence run invalidates the chain", async () => {
  const chain = await chainFor({}, { "show -s --format=%cI HEAD": "2026-09-07T12:30:00.000Z" });
  assert.equal(chain.ok, false);
  assert.equal(chain.problems.some((p: { code: string }) => p.code === "SOURCE_COMMIT_AFTER_EVIDENCE"), true);
});

test("uncommitted changes mean the evidence describes something else", async () => {
  const chain = await chainFor({}, { "status --porcelain=v1": " M apps/server/src/app.ts" });
  assert.equal(chain.ok, false);
  assert.equal(chain.problems.some((p: { code: string }) => p.code === "WORKTREE_DIRTY"), true);
});

test("a failed pilot run cannot be released even when every gate passed", async () => {
  const chain = await chainFor({ status: "failed" });
  assert.equal(chain.ok, false);
  assert.deepEqual(chain.problems, [{ code: "PILOT_RUN_NOT_PASSED" }]);
});

test("a missing program-contracts report is a gap, not a pass", async () => {
  const chain = await buildReleaseEvidenceChain({
    repository, receipt: receipt(), manifest, manifestBytes: "{}",
    programContracts: undefined, runGit: git(),
  });
  assert.equal(chain.ok, false);
  assert.deepEqual(chain.problems, [{ code: "PROGRAM_CONTRACTS_MISSING" }]);
});

test("the chain pins the manifest it was checked against", async () => {
  const a = await chainFor();
  const b = await buildReleaseEvidenceChain({
    repository, receipt: receipt(), manifest, manifestBytes: `${JSON.stringify(manifest)} `,
    programContracts: { inconsistent: [], outstanding: [] }, runGit: git(),
  });
  assert.notEqual(a.manifestSha256, b.manifestSha256);
  assert.notEqual(a.chainSha256, b.chainSha256);
});

test("receipts are listed newest first and nothing else is listed", async () => {
  const found = await listReceipts(repository, async () => [
    "run-0000000000000001.receipt.json",
    "run-0000000000000002.receipt.json",
    "notes.txt",
    "run-short.receipt.json",
  ]);
  assert.deepEqual(found.map((path: string) => path.split("/").pop()), [
    "run-0000000000000002.receipt.json",
    "run-0000000000000001.receipt.json",
  ]);
});
