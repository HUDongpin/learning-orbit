import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The three human records Gate 6 requires.  They are listed here so a release
 * that has none still says so explicitly: a chain that simply omitted them
 * would read like a chain that satisfied them.
 */
export const HUMAN_AUTHORITY_RECORDS = Object.freeze([
  Object.freeze({
    kind: "external_authorization",
    what: "School and research ethics authorization",
    blocks: "Any session with real students",
  }),
  Object.freeze({
    kind: "human_shadow_completed",
    what: "Non-student teacher shadow, conducted as a controlled human session",
    blocks: "Gate 6 admission",
  }),
  Object.freeze({
    kind: "student_visible_promotion",
    what: "Student visibility promotion, signed separately from the shadow",
    blocks: "Any student-visible ECHO or TRACE",
  }),
]);

export class ReleaseEvidenceError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function fail(code) { throw new ReleaseEvidenceError(code); }

/** Newest-first list of pilot receipts, so a release names one deliberately. */
export async function listReceipts(repository, readDirectory = readdir) {
  const directory = join(repository, "test-results", "local-pilot");
  let names;
  try { names = await readDirectory(directory); }
  catch { return []; }
  return names
    .filter((name) => /^run-[0-9a-f]{16}\.receipt\.json$/.test(name))
    .sort()
    .reverse()
    .map((name) => join(directory, name));
}

/**
 * Check one pilot receipt against the manifest it claims to have satisfied.
 *
 * The manifest is the authority on which gates must run and how many tests
 * each must contain, so a receipt is only evidence to the extent it matches
 * the manifest at the same commit.  A gate the manifest requires and the
 * receipt never ran is the failure this exists to catch; the reverse — a gate
 * in the receipt that the manifest dropped — is reported too, because it means
 * the two files disagree about what the release was tested against.
 */
export function checkGateCoverage(receipt, manifest) {
  const required = new Map(manifest.gates.map((gate) => [gate.id, gate]));
  const observed = new Map((receipt.gates ?? []).map((gate) => [gate.id, gate]));
  const links = [];
  const problems = [];
  for (const [id, gate] of required) {
    const run = observed.get(id);
    if (!run) { problems.push({ gate: id, code: "GATE_NOT_RUN" }); continue; }
    if (run.status !== "passed") { problems.push({ gate: id, code: "GATE_NOT_PASSED" }); continue; }
    if (run.expectedTests !== gate.expectedTests || run.summary?.total !== gate.expectedTests) {
      problems.push({ gate: id, code: "GATE_TEST_COUNT_DRIFT" });
      continue;
    }
    // A gate that skipped, deferred or focused a test did not run the suite the
    // manifest pinned, even though every test it did run passed.
    if (run.noSkipCount !== 0) { problems.push({ gate: id, code: "GATE_TESTS_NOT_ALL_RUN" }); continue; }
    if (!SHA256.test(run.reportSha256 ?? "")) { problems.push({ gate: id, code: "GATE_REPORT_UNHASHED" }); continue; }
    links.push({ gate: id, tests: gate.expectedTests, reportSha256: run.reportSha256 });
  }
  for (const id of observed.keys()) {
    if (!required.has(id)) problems.push({ gate: id, code: "GATE_NOT_IN_MANIFEST" });
  }
  return { links, problems };
}

async function git(repository, argv, runGit) {
  const run = runGit ?? ((args) => execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "-C", repository, ...args], {
    encoding: "utf8", shell: false, maxBuffer: 1024 * 1024, timeout: 30_000, windowsHide: true,
  }));
  return (await run(argv)).stdout.trim();
}

/**
 * Prove the evidence describes the commit being released, and that nothing was
 * committed after the evidence was produced.
 *
 * "Frozen" is not a property of the receipt — a receipt records the commit it
 * ran against and can be perfectly valid for a commit that has since been
 * superseded.  It is a property of the repository right now, which is why HEAD
 * and the working tree are read here rather than trusted from the receipt.
 */
export async function checkFrozenCommit({ repository, receipt, runGit }) {
  const head = await git(repository, ["rev-parse", "HEAD"], runGit);
  const status = await git(repository, ["status", "--porcelain=v1"], runGit);
  const committedAt = await git(repository, ["show", "-s", "--format=%cI", "HEAD"], runGit);
  const problems = [];
  if (!SHA1.test(receipt.sourceSha ?? "")) problems.push({ code: "RECEIPT_SHA_INVALID" });
  else if (head !== receipt.sourceSha) problems.push({ code: "EVIDENCE_NOT_AT_HEAD" });
  if (status !== "") problems.push({ code: "WORKTREE_DIRTY" });
  const startedAt = Date.parse(receipt.startedAt ?? "");
  const commitTime = Date.parse(committedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(commitTime)) problems.push({ code: "EVIDENCE_TIME_UNREADABLE" });
  else if (commitTime > startedAt) problems.push({ code: "SOURCE_COMMIT_AFTER_EVIDENCE" });
  return { head, committedAt, problems };
}

/** The Gate 6 human records, and which of them this release actually holds. */
export function checkHumanAuthority(verifiedRecords) {
  const held = new Set(verifiedRecords.map((record) => record.kind));
  return HUMAN_AUTHORITY_RECORDS.map((record) => ({ ...record, held: held.has(record.kind) }));
}

export function chainDigest(chain) {
  return createHash("sha256").update(JSON.stringify(chain)).digest("hex");
}

/**
 * Build the release evidence chain.  `verifiedRecords` are authority records a
 * caller has already checked against the trust set; this function never
 * verifies a signature itself, so a chain cannot be talked into accepting one.
 */
export async function buildReleaseEvidenceChain({
  repository, receipt, manifest, manifestBytes, programContracts, verifiedRecords = [], runGit,
}) {
  if (!isAbsolute(repository)) fail("RELEASE_REPOSITORY_INVALID");
  if (receipt?.schemaVersion !== 1) fail("RELEASE_RECEIPT_INVALID");
  const problems = [];
  if (receipt.status !== "passed") problems.push({ code: "PILOT_RUN_NOT_PASSED" });
  const coverage = checkGateCoverage(receipt, manifest);
  problems.push(...coverage.problems);
  const frozen = await checkFrozenCommit({ repository, receipt, runGit });
  problems.push(...frozen.problems);
  if (programContracts) {
    if (programContracts.inconsistent?.length) problems.push({ code: "PROGRAM_CONTRACTS_INCONSISTENT" });
  } else {
    problems.push({ code: "PROGRAM_CONTRACTS_MISSING" });
  }
  const humanAuthority = checkHumanAuthority(verifiedRecords);
  const chain = {
    schemaVersion: 1,
    sourceSha: frozen.head,
    committedAt: frozen.committedAt,
    runId: receipt.runId,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    gates: coverage.links,
    programContracts: programContracts
      ? { inconsistent: programContracts.inconsistent?.length ?? 0, outstanding: programContracts.outstanding?.length ?? 0 }
      : null,
    authority: verifiedRecords.map(({ kind, recordId, issuer, keyId }) => ({ kind, recordId, issuer, keyId })),
    humanAuthority,
    // A release can be internally consistent and still be inadmissible for a
    // classroom: `ok` is about the engineering evidence, `admissible` adds the
    // human records that engineering cannot issue for itself.
    ok: problems.length === 0,
    admissible: problems.length === 0 && humanAuthority.every((record) => record.held),
    problems,
  };
  return { ...chain, chainSha256: chainDigest(chain) };
}

export async function readManifest(repository) {
  const path = join(repository, "tests", "pilot", "required-test-manifest.v1.json");
  const bytes = await readFile(path, "utf8");
  const manifest = JSON.parse(bytes);
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.gates) || manifest.gates.length === 0) {
    fail("RELEASE_MANIFEST_INVALID");
  }
  return { manifest, manifestBytes: bytes };
}
