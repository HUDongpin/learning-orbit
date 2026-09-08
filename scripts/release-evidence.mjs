import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
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
    if (run.expectedTests !== gate.expectedTests || run.summary?.expected !== gate.expectedTests) {
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

/**
 * Which existing verifier answers for each Gate 6 record kind.
 *
 * The verifiers own the question of whether a record is genuine; nothing here
 * re-decides it.  A second implementation would give a release two opinions
 * about one signature, and the weaker of the two would eventually be the one
 * that mattered.  A kind absent from this table has no verifier and so can
 * never be held — including the other authority kinds, which are real records
 * about other decisions and are not standing in for these three.
 */
const AUTHORITY_VERIFIERS = Object.freeze({
  external_authorization: "verify-controlled-authority.ts",
  human_shadow_completed: "verify-shadow-record.ts",
  student_visible_promotion: "verify-controlled-authority.ts",
});

/** A verifier reports a refusal as one bounded code; nothing else is echoed. */
const VERIFIER_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

function verifierCode(text, fallback) {
  const first = String(text ?? "").split("\n", 1)[0].trim();
  // A verifier that refused on the record's own contents may say so in a
  // message quoting them.  A release log is not a place to copy the contents
  // of a governance record into, so only a bounded code is repeated.
  return VERIFIER_CODE.test(first) ? first : fallback;
}

async function readJsonFile(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

/** Record files named deliberately: one file, or every `.json` in one directory. */
async function listAuthorityRecordPaths(authorityPath) {
  const target = resolve(authorityPath);
  let info;
  try { info = await stat(target); }
  catch { fail("RELEASE_AUTHORITY_PATH_UNREADABLE"); }
  if (!info.isDirectory()) return [target];
  return (await readdir(target))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(target, name));
}

/**
 * Run one verifier over one record.
 *
 * Paths are resolved to absolute before they reach argv, so a file cannot be
 * named after one of the verifier's own flags and be read as one — a record
 * called `--fixture` would otherwise put the authority checker into the mode
 * that signs its own example.
 */
async function runAuthorityVerifier(repository, script, recordPath, trustPath) {
  const argv = [join(repository, "scripts", script), "--record", recordPath, "--trust", trustPath];
  try {
    const { stdout } = await execFileAsync(join(repository, "node_modules", ".bin", "tsx"), argv, {
      encoding: "utf8", shell: false, maxBuffer: 1024 * 1024, timeout: 120_000, windowsHide: true,
    });
    return { ok: true, stdout };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, code: "AUTHORITY_VERIFIER_UNAVAILABLE" };
    if (error?.killed === true) return { ok: false, code: "AUTHORITY_VERIFIER_TIMEOUT" };
    return { ok: false, code: verifierCode(error?.stderr, "AUTHORITY_VERIFICATION_FAILED") };
  }
}

/** Both verifiers answer on their first line of stdout, and only when they accept. */
function verifierResult(stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout).split("\n", 1)[0]); }
  catch { return undefined; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed.ok === true ? parsed : undefined;
}

/**
 * The payload contract each kind's verifier must report having applied.
 *
 * A signature proves who wrote the bytes and nothing about what they say, and
 * these two payloads carry the separation-of-duties conditions that are the
 * entire reason the promotion is signed apart from the shadow.  The verifier
 * re-parses them through the shared contract and names the contract it used;
 * this is the naming read back, so a verifier that checked nothing — an older
 * build, or a contract that could not be loaded — is refused rather than
 * mistaken for one that found nothing wrong.
 */
const REQUIRED_PAYLOAD_CONTRACT = Object.freeze({
  external_authorization: "external-authorization-record.v1",
  student_visible_promotion: "student-visible-promotion-record.v1",
});

/**
 * Decide what one verifier's answer actually proves.
 *
 * Exiting zero is not the whole answer.  The shadow checker exits zero for a
 * signed record whose verdict is that the system is not ready — the checker
 * working, and admitting nothing.  The authority checker prints whether it used
 * its own fixture key, and which payload contract it held the record to.  Only
 * the part of each answer that carries authority is read back here.
 */
function readVerifiedAuthority(kind, file, result) {
  if (kind === "human_shadow_completed") {
    // Both callers here pass `--trust`, and the shadow checker exits non-zero
    // for anything it cannot verify against it, so a zero exit without a signer
    // is not an unsigned draft — it is not the checker this expects.
    if (typeof result.signedBy !== "string") return { code: "AUTHORITY_VERIFIER_OUTPUT_UNREADABLE" };
    // `issuer/keyId`, and a key id never contains a slash, so the last one splits it.
    const split = result.signedBy.lastIndexOf("/");
    if (split <= 0) return { code: "AUTHORITY_VERIFIER_OUTPUT_UNREADABLE" };
    if (result.verdict !== "ready_for_students") return { code: "SHADOW_VERDICT_NOT_READY" };
    // Accepted coupling: the shadow checker reports the shadow's own id and not
    // the envelope's, so the record id is read from a second read of the same
    // file rather than from the verifier's output.  The signature the checker
    // verified covers that field, so the two agree unless the file changed
    // between the two reads; nothing else in the chain rests on it.
    if (typeof file.recordId !== "string") return { code: "AUTHORITY_RECORD_UNREADABLE" };
    return {
      record: {
        kind,
        recordId: file.recordId,
        issuer: result.signedBy.slice(0, split),
        keyId: result.signedBy.slice(split + 1),
      },
    };
  }
  if (result.fixture !== false) return { code: "AUTHORITY_FIXTURE_RESULT_REFUSED" };
  // Read from the verifier's own answer, against the kind this dispatched on:
  // the two agree unless the file changed between the two reads of it.
  if (result.kind !== kind) return { code: "AUTHORITY_RECORD_KIND_MISMATCH" };
  // A kind with no contract named for it is refused rather than waved through,
  // so adding a verifier without adding its contract closes the gate.
  const required = Object.hasOwn(REQUIRED_PAYLOAD_CONTRACT, kind) ? REQUIRED_PAYLOAD_CONTRACT[kind] : undefined;
  if (typeof required !== "string" || result.payloadContract !== required) {
    return { code: "AUTHORITY_PAYLOAD_CONTRACT_NOT_APPLIED" };
  }
  if (typeof result.recordId !== "string" || typeof result.issuer !== "string" || typeof result.keyId !== "string") {
    return { code: "AUTHORITY_VERIFIER_OUTPUT_UNREADABLE" };
  }
  return { record: { kind, recordId: result.recordId, issuer: result.issuer, keyId: result.keyId } };
}

/**
 * Verify the Gate 6 human records an operator was actually handed.
 *
 * An operator names the deployment trust set and the records; each record goes
 * to the verifier that owns its kind, and only one that verifier accepts is
 * returned.  Everything else comes back as a refusal carrying its reason,
 * because a record that quietly vanished from the report would read exactly
 * like a record nobody ever produced — which is the one thing this must never
 * be unable to tell apart.
 *
 * The trust set is digested and returned alongside, so a chain that claims to
 * be admissible names the anchor that admitted it rather than leaving a reader
 * to guess which set of keys was in front of the verifier.
 */
export async function collectVerifiedAuthority({ repository, trustPath, authorityPath }) {
  if (!isAbsolute(repository)) fail("RELEASE_REPOSITORY_INVALID");
  if (typeof trustPath !== "string" || typeof authorityPath !== "string") fail("RELEASE_AUTHORITY_OPTIONS_INVALID");
  const trust = resolve(trustPath);
  let trustInfo;
  try { trustInfo = await stat(trust); }
  catch { fail("RELEASE_AUTHORITY_TRUST_UNREADABLE"); }
  if (!trustInfo.isFile()) fail("RELEASE_AUTHORITY_TRUST_UNREADABLE");
  let trustBytes;
  try { trustBytes = await readFile(trust); }
  catch { fail("RELEASE_AUTHORITY_TRUST_UNREADABLE"); }
  const trustDigest = { sha256: createHash("sha256").update(trustBytes).digest("hex") };

  const paths = await listAuthorityRecordPaths(authorityPath);
  const refusals = [];
  const accepted = [];
  // Being pointed at somewhere with no records in it is a misconfiguration, not
  // a release that happens to hold none.
  if (paths.length === 0) refusals.push({ file: basename(resolve(authorityPath)), code: "AUTHORITY_RECORDS_ABSENT" });
  for (const path of paths) {
    const file = await readJsonFile(path);
    if (!file) { refusals.push({ file: basename(path), code: "AUTHORITY_RECORD_UNREADABLE" }); continue; }
    const kind = typeof file.kind === "string" ? file.kind : "";
    if (!Object.hasOwn(AUTHORITY_VERIFIERS, kind)) {
      refusals.push({ file: basename(path), code: "AUTHORITY_RECORD_KIND_UNRECOGNISED" });
      continue;
    }
    const run = await runAuthorityVerifier(repository, AUTHORITY_VERIFIERS[kind], path, trust);
    if (!run.ok) { refusals.push({ file: basename(path), code: run.code }); continue; }
    const result = verifierResult(run.stdout);
    if (!result) { refusals.push({ file: basename(path), code: "AUTHORITY_VERIFIER_OUTPUT_UNREADABLE" }); continue; }
    const read = readVerifiedAuthority(kind, file, result);
    if (!read.record) { refusals.push({ file: basename(path), code: read.code }); continue; }
    accepted.push({ file: basename(path), record: read.record });
  }

  // Two records claiming one kind are not twice the authority.  They are a
  // question about which of them the release was granted under, and nothing
  // here is in a position to answer it, so neither is held.
  const perKind = new Map();
  for (const entry of accepted) perKind.set(entry.record.kind, (perKind.get(entry.record.kind) ?? 0) + 1);
  const verified = [];
  for (const entry of accepted) {
    if (perKind.get(entry.record.kind) > 1) refusals.push({ file: entry.file, code: "AUTHORITY_RECORD_KIND_DUPLICATED" });
    else verified.push(entry.record);
  }
  return { verified, refusals, trust: trustDigest };
}

export function chainDigest(chain) {
  return createHash("sha256").update(JSON.stringify(chain)).digest("hex");
}

/**
 * Build the release evidence chain.  `verifiedRecords` are authority records a
 * caller has already checked against the trust set; this function never
 * verifies a signature itself, so a chain cannot be talked into accepting one.
 *
 * `refusals` and `authorityTrust` are that same check's other two outputs, and
 * they belong in the chain rather than only in the process that wrote it.  The
 * file is the evidence; an exit code is not carried anywhere.  A chain that
 * said `admissible` while a record offered alongside it was refused, or that
 * did not name the trust anchor it was admitted under, would be a worse record
 * of the release than no file at all.
 */
export async function buildReleaseEvidenceChain({
  repository, receipt, manifest, manifestBytes, programContracts,
  verifiedRecords = [], refusals = [], authorityTrust = null, runGit,
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
    // Which trust set admitted the records above, by digest.  `null` is a run
    // that was shown no trust set and so holds nothing.
    authorityTrust,
    humanAuthority,
    // Records that were offered and turned away, by the file they arrived in
    // and the bounded reason.  A refusal nobody recorded reads, later, exactly
    // like a record nobody ever offered.
    authorityRefusals: refusals.map(({ file, code }) => ({ file, code })),
    // A release can be internally consistent and still be inadmissible for a
    // classroom: `ok` is about the engineering evidence, `admissible` adds the
    // human records that engineering cannot issue for itself — and subtracts
    // any record that was offered and refused, because a release holding a
    // refusal is not a release holding an answer.
    ok: problems.length === 0,
    admissible: problems.length === 0
      && refusals.length === 0
      && humanAuthority.every((record) => record.held),
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
