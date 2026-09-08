import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, it as test } from "vitest";

import {
  authoritySigningInput,
  type AuthorityRecordKind,
} from "../../apps/server/src/modules/authorization/controlled-authority-verifier.js";
import {
  buildReleaseEvidenceChain,
  checkGateCoverage,
  checkHumanAuthority,
  collectVerifiedAuthority,
  HUMAN_AUTHORITY_RECORDS,
  listReceipts,
  selectReceiptForCommit,
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

/**
 * The seven-key summary the runner actually freezes onto a receipt
 * (scripts/local-pilot/required-test-runner.mjs). A fixture that invents its own
 * shape would let a coverage check pass here and fail on every real receipt.
 */
function summary(expected: number, over: Record<string, number> = {}) {
  return {
    expected, executed: expected, passed: expected,
    failed: 0, skipped: 0, pending: 0, focused: 0,
    ...over,
  };
}

function gate(id: string, expectedTests: number, override: Record<string, unknown> = {}) {
  return {
    id, status: "passed", expectedTests, noSkipCount: 0,
    reportSha256: REPORT, summary: summary(expectedTests),
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

async function chainFor(
  over: Record<string, unknown> = {},
  gitOver: Record<string, string> = {},
  verifiedRecords: Array<Record<string, unknown>> = [],
  authority: {
    refusals?: Array<{ file: string; code: string }>;
    trust?: { sha256: string } | null;
  } = {},
) {
  return buildReleaseEvidenceChain({
    repository, receipt: receipt(over), manifest, manifestBytes: JSON.stringify(manifest),
    programContracts: { inconsistent: [], outstanding: ["multimodal.derive.v1"] },
    runGit: git(gitOver), verifiedRecords,
    refusals: authority.refusals ?? [],
    authorityTrust: authority.trust ?? null,
  });
}

// Signing material for these tests only: an ephemeral key that exists for the
// life of the process, under the issuer this repository reserves for fixtures,
// written to a temporary directory and never into the tree. No deployment
// trust set names it, so nothing signed here could be presented as real.
const AUTHORITY_ISSUER = "learning-orbit-test-only";
const AUTHORITY_KEY_ID = "test-only-key-1";
const signer = generateKeyPairSync("ed25519");
const publicKeyPem = signer.publicKey.export({ format: "pem", type: "spki" }).toString();

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

/**
 * The salted digests these records carry stand in for people and documents.
 * Nothing here is derived from anyone: each is one repeated hex digit, chosen
 * so that refs the contracts require to differ visibly differ.
 */
const ref = (digit: string) => digit.repeat(64);

/**
 * An authorization that a body outside the operating team actually decided:
 * reviewed before it decided, decided before the sessions start, consent held
 * before that, a cohort and a window with both ends closed, and one provider
 * mode named without the other mode's fields.  Every one of those is a
 * condition the contract refuses on, which is the point of signing it.
 */
const externalBody = (over: Record<string, unknown> = {}) => ({
  recordKind: "external_authorization",
  authorizationId: "00000000-0000-4000-8000-000000000101",
  synthetic: false,
  authorizingBody: {
    bodyKind: "school_and_research_ethics_board",
    bodyRef: ref("a"),
    approvalReference: "REB-2026-014",
    decidedAt: "2026-01-05T00:00:00.000Z",
  },
  scope: {
    schoolRef: ref("b"),
    classRef: ref("c"),
    roomIds: ["00000000-0000-4000-8000-000000000102"],
    maxStudentsPerRoom: 24,
    maxStudentsTotal: 96,
    sessionsFrom: "2026-02-01T00:00:00.000Z",
    sessionsUntil: "2026-05-01T00:00:00.000Z",
  },
  supervisingTeacherRef: ref("d"),
  rollbackOwnerRef: ref("e"),
  incidentContactRefs: [ref("f")],
  participantInformation: {
    informationSheetSha256: ref("1"),
    consentPath: "guardian_written_opt_in",
    consentObtainedBy: "2026-01-20T00:00:00.000Z",
  },
  reviewedDocuments: [
    { documentKind: "threat_model", documentSha256: ref("2"), reviewedAt: "2026-01-02T00:00:00.000Z" },
    { documentKind: "data_inventory", documentSha256: ref("3"), reviewedAt: "2026-01-03T00:00:00.000Z" },
    { documentKind: "retention_policy", documentSha256: ref("4"), reviewedAt: "2026-01-04T00:00:00.000Z" },
  ],
  retentionPolicyId: "00000000-0000-4000-8000-000000000103",
  providerScope: {
    providerId: "example-provider",
    providerManifestSha256: ref("5"),
    region: "eu-central-1",
    purpose: "classroom-pilot",
    remoteCopyMode: "delete_and_probe",
    capabilitySchemaVersion: "1.0.0",
    portSchemaVersion: "1.0.0",
  },
  featureAllowlist: ["room_chat", "agent_nova"],
  usedForGradesOrDiscipline: false,
  authorizedSignerRefs: [ref("6")],
  ...over,
});

/**
 * A promotion decided by someone other than the teacher who ran the shadow,
 * inside the window the authorization granted, with a revocation path that can
 * act before the visibility it withdraws expires.
 */
const promotionBody = (over: Record<string, unknown> = {}) => ({
  recordKind: "student_visible_promotion",
  promotionId: "00000000-0000-4000-8000-000000000201",
  roomId: "00000000-0000-4000-8000-000000000102",
  synthetic: false,
  externalAuthorizationRecordSha256: ref("7"),
  authorizedFrom: "2026-02-01T00:00:00.000Z",
  authorizedUntil: "2026-05-01T00:00:00.000Z",
  shadowRecordSha256: ref("8"),
  shadowTeacherRef: ref("9"),
  shadowVerdict: "ready_for_students",
  derivedFromShadowRecord: false,
  decidedBy: {
    deciderRef: ref("0"),
    deciderRole: "school_authority",
    decidedAt: "2026-01-25T00:00:00.000Z",
  },
  studentProjectionKeys: ["echo.student_approved"],
  startsAt: "2026-02-01T00:00:00.000Z",
  expiresAt: "2026-05-01T00:00:00.000Z",
  revocation: { contactRef: ref("b"), method: "operator_revoke_command", maxLatencyMinutes: 60 },
  usedForGradesOrDiscipline: false,
  ...over,
});

const AGENT_RUN = "00000000-0000-4000-8000-000000000003";
/** A shadow that happened, ran long enough to see something, and cleared. */
const shadowBody = (verdict: string) => ({
  recordKind: "human_shadow_completed",
  shadowId: "00000000-0000-4000-8000-000000000001",
  roomId: "00000000-0000-4000-8000-000000000002",
  teacherRef: "0".repeat(64),
  rehearsal: false,
  studentsPresent: false,
  startedAt: "2026-09-07T09:00:00.000Z",
  endedAt: "2026-09-07T09:45:00.000Z",
  agentRunsObserved: [AGENT_RUN],
  observations: [{ agentRunId: AGENT_RUN, outcome: "appropriate", note: "Asked for evidence, supplied none." }],
  verdict,
  conditions: [],
});

function signedRecord(
  kind: AuthorityRecordKind,
  payload: Record<string, unknown>,
  over: { signedAt?: string; expiresAt?: string } = {},
) {
  const unsigned = {
    kind,
    recordId: randomUUID(),
    issuer: AUTHORITY_ISSUER,
    keyId: AUTHORITY_KEY_ID,
    signedAt: over.signedAt ?? ago(DAY),
    expiresAt: over.expiresAt ?? ahead(DAY),
    payload,
  };
  return {
    ...unsigned,
    signature: sign(null, authoritySigningInput(unsigned), signer.privateKey).toString("base64url"),
  };
}

const trustKey = (over: Record<string, unknown> = {}) => ({
  keyId: AUTHORITY_KEY_ID, issuer: AUTHORITY_ISSUER, publicKeyPem,
  notBefore: ago(30 * DAY), notAfter: ahead(30 * DAY), ...over,
});

const temporary: string[] = [];
afterAll(async () => {
  for (const root of temporary) await rm(root, { recursive: true, force: true });
});

/** Lay out one deployment's worth of trust set and record files on disk. */
async function collect(
  records: Record<string, unknown>,
  keys: Array<Record<string, unknown>> = [trustKey()],
) {
  const root = await mkdtemp(join(tmpdir(), "release-authority-"));
  temporary.push(root);
  const trustPath = join(root, "authority-trust.json");
  await writeFile(trustPath, JSON.stringify({ version: 1, keys }), { encoding: "utf8", mode: 0o600 });
  const authorityPath = join(root, "records");
  await mkdir(authorityPath, { mode: 0o700 });
  for (const [name, body] of Object.entries(records)) {
    await writeFile(join(authorityPath, name), JSON.stringify(body), { encoding: "utf8", mode: 0o600 });
  }
  return collectVerifiedAuthority({ repository, trustPath, authorityPath });
}

const codes = (authority: { refusals: Array<{ code: string }> }) =>
  authority.refusals.map((refusal) => refusal.code).sort();

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
    receipt({ gates: [gate("server-vitest", 12, { summary: summary(11) }), gate("worker-python", 5)] }),
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

test("being pointed at no records is a misconfiguration, not a release without them", async () => {
  const authority = await collect({});
  assert.deepEqual(authority.verified, []);
  assert.deepEqual(codes(authority), ["AUTHORITY_RECORDS_ABSENT"]);
  const chain = await chainFor({}, {}, authority.verified);
  assert.equal(chain.admissible, false);
  assert.deepEqual(chain.humanAuthority.map((r: { held: boolean }) => r.held), [false, false, false]);
});

test("one verified record is one record, not the set Gate 6 asks for", async () => {
  const authority = await collect({
    "external.json": signedRecord("external_authorization", externalBody()),
  });
  assert.deepEqual(authority.refusals, []);
  assert.deepEqual(authority.verified.map((r: { kind: string }) => r.kind), ["external_authorization"]);
  const chain = await chainFor({}, {}, authority.verified, { trust: authority.trust });
  assert.deepEqual(chain.humanAuthority.map((r: { held: boolean }) => r.held), [true, false, false]);
  assert.equal(chain.admissible, false);
});

test("a record that fails verification is refused with the verifier's own reason", async () => {
  const genuine = signedRecord("external_authorization", externalBody());
  const tampered = await collect({
    // The signature covers the payload, so a cohort widened after signing is a
    // different record wearing a real signature.
    "external.json": {
      ...genuine,
      payload: externalBody({
        scope: { ...externalBody().scope, maxStudentsPerRoom: 40, maxStudentsTotal: 400 },
      }),
    },
  });
  assert.deepEqual(tampered.verified, []);
  assert.deepEqual(codes(tampered), ["AUTHORITY_SIGNATURE_INVALID"]);

  const lapsed = await collect({
    "promotion.json": signedRecord("student_visible_promotion", promotionBody(), {
      signedAt: ago(10 * DAY), expiresAt: ago(DAY),
    }),
  });
  assert.deepEqual(lapsed.verified, []);
  assert.deepEqual(codes(lapsed), ["AUTHORITY_RECORD_EXPIRED"]);
});

test("a key the trust set itself disowns cannot sign a release into a classroom", async () => {
  const record = { "external.json": signedRecord("external_authorization", externalBody()) };

  const revoked = await collect(record, [trustKey({ revokedAt: ago(2 * DAY) })]);
  assert.deepEqual(revoked.verified, []);
  assert.deepEqual(codes(revoked), ["AUTHORITY_KEY_REVOKED"]);

  // The authority checker signs its own example under `--fixture`. A trust set
  // that admits a fixture key is the same offer by another route, and the only
  // caller that may take it is the one that generated the key.
  const fixture = await collect(record, [trustKey({ fixture: true })]);
  assert.deepEqual(fixture.verified, []);
  assert.deepEqual(codes(fixture), ["AUTHORITY_FIXTURE_KEY_FORBIDDEN"]);
});

test("a signed shadow that did not clear the system for students is not authority", async () => {
  const authority = await collect({
    "shadow.json": signedRecord("human_shadow_completed", shadowBody("not_ready")),
  });
  assert.deepEqual(authority.verified, []);
  assert.deepEqual(codes(authority), ["SHADOW_VERDICT_NOT_READY"]);
});

test("documents that are not signed Gate 6 records are refused rather than skipped", async () => {
  const authority = await collect({
    // A coherent shadow nobody signed: a draft, and Gate 6 does not admit drafts.
    "draft.json": shadowBody("ready_for_students"),
    // A real authority record about a different decision entirely.
    "retention.json": signedRecord("pilot_retention_policy", { policyVersion: "approved-2026" }),
    "notes.json": { note: "what we still owe the school" },
  });
  assert.deepEqual(authority.verified, []);
  assert.deepEqual(codes(authority), [
    "AUTHORITY_RECORD_KIND_UNRECOGNISED",
    "AUTHORITY_RECORD_KIND_UNRECOGNISED",
    "AUTHORITY_RECORD_KIND_UNRECOGNISED",
  ]);
});

test("two records claiming one kind leave that kind unheld", async () => {
  const authority = await collect({
    "external-a.json": signedRecord("external_authorization", externalBody()),
    "external-b.json": signedRecord("external_authorization", externalBody({
      authorizationId: "00000000-0000-4000-8000-000000000104",
    })),
  });
  assert.deepEqual(authority.verified, []);
  assert.deepEqual(codes(authority), ["AUTHORITY_RECORD_KIND_DUPLICATED", "AUTHORITY_RECORD_KIND_DUPLICATED"]);
});

/**
 * The signature says who wrote the bytes. It says nothing about what the bytes
 * say, and these records say, in their own fields, that they are not the
 * decision Gate 6 asks for. Each of these is signed by a trusted, non-fixture,
 * in-window key, and each is refused on its payload alone.
 */
test("a validly signed authorization that declares itself synthetic is not an authorization", async () => {
  const authority = await collect({
    "external.json": signedRecord("external_authorization", externalBody({ synthetic: true })),
  });
  assert.deepEqual(authority.verified, []);
  assert.deepEqual(codes(authority), ["AUTHORIZATION_WAS_SYNTHETIC"]);
});

test("a validly signed promotion that declares itself synthetic is not a promotion", async () => {
  const authority = await collect({
    "promotion.json": signedRecord("student_visible_promotion", promotionBody({ synthetic: true })),
  });
  assert.deepEqual(authority.verified, []);
  assert.deepEqual(codes(authority), ["PROMOTION_WAS_SYNTHETIC"]);
});

test("a promotion showing students more than the authorization granted is refused", async () => {
  // Visibility running a month past the window the school authorized is a
  // wider decision than the one that was taken, however it was signed.
  const authority = await collect({
    "promotion.json": signedRecord("student_visible_promotion", promotionBody({
      expiresAt: "2026-06-01T00:00:00.000Z",
    })),
  });
  assert.deepEqual(authority.verified, []);
  assert.deepEqual(codes(authority), ["PROMOTION_SCOPE_EXCEEDS_AUTHORIZATION"]);
});

test("a real signature over a payload that says nothing admits nothing", async () => {
  const authority = await collect({
    "external.json": signedRecord("external_authorization", {}),
    "promotion.json": signedRecord("student_visible_promotion", {}),
  });
  assert.deepEqual(authority.verified, []);
  assert.deepEqual(codes(authority), [
    "INVALID_EXTERNAL_AUTHORIZATION_RECORD",
    "INVALID_STUDENT_VISIBLE_PROMOTION_RECORD",
  ]);
});

test("three independently verified records are what makes a release admissible", async () => {
  const authority = await collect({
    "external.json": signedRecord("external_authorization", externalBody()),
    "promotion.json": signedRecord("student_visible_promotion", promotionBody()),
    "shadow.json": signedRecord("human_shadow_completed", shadowBody("ready_for_students")),
  });
  assert.deepEqual(authority.refusals, []);
  assert.deepEqual(authority.verified.map((r: { kind: string }) => r.kind).sort(), [
    "external_authorization", "human_shadow_completed", "student_visible_promotion",
  ]);
  const chain = await chainFor({}, {}, authority.verified, { trust: authority.trust });
  assert.equal(chain.ok, true);
  assert.equal(chain.admissible, true);
  assert.deepEqual(chain.humanAuthority.map((r: { held: boolean }) => r.held), [true, true, true]);
  // The chain names which records it was shown, so a later reader can go and
  // ask the issuers rather than take this file's word for it.
  assert.deepEqual(chain.authority.map((r: { issuer: string }) => r.issuer), [
    AUTHORITY_ISSUER, AUTHORITY_ISSUER, AUTHORITY_ISSUER,
  ]);
  // ...and which trust set admitted them. A chain that named the records but
  // not the anchor would not say whose keys were being trusted.
  assert.match(chain.authorityTrust.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(chain.authorityRefusals, []);
});

test("the written chain carries the refusals, and never claims admissibility over one", async () => {
  const authority = await collect({
    "external.json": signedRecord("external_authorization", externalBody()),
    "promotion.json": signedRecord("student_visible_promotion", promotionBody()),
    "shadow.json": signedRecord("human_shadow_completed", shadowBody("ready_for_students")),
    // One stray document alongside three good records. The exit code says so
    // and is thrown away; the chain file is what anybody reads later.
    "notes.json": { note: "what we still owe the school" },
  });
  assert.deepEqual(codes(authority), ["AUTHORITY_RECORD_KIND_UNRECOGNISED"]);
  const chain = await chainFor({}, {}, authority.verified, {
    refusals: authority.refusals, trust: authority.trust,
  });
  assert.equal(chain.ok, true);
  assert.deepEqual(chain.humanAuthority.map((r: { held: boolean }) => r.held), [true, true, true]);
  assert.equal(chain.admissible, false);
  assert.deepEqual(chain.authorityRefusals, [
    { file: "notes.json", code: "AUTHORITY_RECORD_KIND_UNRECOGNISED" },
  ]);
  // The refusal and the anchor are inside the digest, so a chain cannot be
  // stripped of either and still present the same identity.
  const clean = await chainFor({}, {}, authority.verified, { trust: authority.trust });
  assert.equal(clean.admissible, true);
  assert.notEqual(chain.chainSha256, clean.chainSha256);
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/** A directory of receipts, and a reader that answers for each. */
function receiptDirectory(bySha: Record<string, string>) {
  const readDirectory = async () => Object.keys(bySha);
  const readReceipt = async (path: string) => {
    const sourceSha = bySha[path.split("/").pop() as string];
    return sourceSha ? { sourceSha } : undefined;
  };
  return { readDirectory, readReceipt };
}

test("the commit under evaluation picks its own receipt, not the highest run id", async () => {
  // The failing run sorts above the passing one, which is exactly the case
  // that made the old file-name ordering read superseded evidence.
  const readers = receiptDirectory({
    "run-ffffffffffffffff.receipt.json": SHA_B,
    "run-0000000000000001.receipt.json": SHA_A,
  });
  assert.equal(
    (await selectReceiptForCommit(repository, SHA_A, readers))?.split("/").pop(),
    "run-0000000000000001.receipt.json",
  );
  assert.equal(
    (await selectReceiptForCommit(repository, SHA_B, readers))?.split("/").pop(),
    "run-ffffffffffffffff.receipt.json",
  );
});

test("two receipts for one commit are refused, not silently resolved", async () => {
  // The ordinary sequence produces this: the gate fails, it is run again, and
  // the second run passes at the same commit. Ordering picked one of them, and
  // it was the failed run the first time this happened for real.
  const readers = receiptDirectory({
    "run-ffffffffffffffff.receipt.json": SHA_A,
    "run-0000000000000001.receipt.json": SHA_A,
  });
  await assert.rejects(
    () => selectReceiptForCommit(repository, SHA_A, readers),
    (error: { code?: string; receipts?: string[] }) => {
      assert.equal(error.code, "RELEASE_RECEIPT_AMBIGUOUS_FOR_COMMIT");
      // Both are named, because naming them is the whole remedy.
      assert.deepEqual(
        (error.receipts ?? []).map((path) => path.split("/").pop()).sort(),
        ["run-0000000000000001.receipt.json", "run-ffffffffffffffff.receipt.json"],
      );
      return true;
    },
  );
});

test("a second receipt for a different commit is not a tie", async () => {
  const readers = receiptDirectory({
    "run-ffffffffffffffff.receipt.json": SHA_B,
    "run-0000000000000001.receipt.json": SHA_A,
  });
  assert.equal(
    (await selectReceiptForCommit(repository, SHA_A, readers))?.split("/").pop(),
    "run-0000000000000001.receipt.json",
  );
});

test("a commit with no receipt of its own selects nothing at all", async () => {
  const readers = receiptDirectory({ "run-ffffffffffffffff.receipt.json": SHA_B });
  assert.equal(await selectReceiptForCommit(repository, SHA_A, readers), undefined);
});

test("an unreadable head falls back to the listing rather than guessing a commit", async () => {
  const readers = receiptDirectory({
    "run-ffffffffffffffff.receipt.json": SHA_B,
    "run-0000000000000001.receipt.json": SHA_A,
  });
  assert.equal(
    (await selectReceiptForCommit(repository, undefined, readers))?.split("/").pop(),
    "run-ffffffffffffffff.receipt.json",
  );
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
