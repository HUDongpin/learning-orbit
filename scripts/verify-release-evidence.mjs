#!/usr/bin/env node
/**
 * Assert the release evidence chain on one frozen commit.
 *
 * This reads evidence; it never produces any.  Run the pilot first
 * (`pnpm verify:local-pilot`), then run this against the receipt it wrote.
 * Keeping the two apart is the point: a verifier that could also generate the
 * thing it verifies would always pass.
 *
 * The three Gate 6 human records are read the same way.  They are supplied,
 * never produced here: `--authority` names records an operator was handed and
 * `--trust` the deployment trust set they must verify against, and each record
 * is checked by the verifier that already owns its kind — signature, key, and
 * the payload contract that kind must satisfy.  Without both options this
 * reports all three as NOT HELD, which is what a release that holds none of
 * them should say.
 *
 * The chain this writes carries what the run was actually shown: the records
 * held, the trust set that admitted them, and every record refused.  An exit
 * code is not carried anywhere, so it is never the only place a refusal is
 * recorded.
 *
 *   pnpm verify:pilot [--receipt <path>] [--out <path>]
 *                     [--trust <file> --authority <dir|file>]
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, exitCode, stderr, stdout } from "node:process";
import { promisify } from "node:util";

import {
  buildReleaseEvidenceChain,
  collectVerifiedAuthority,
  readManifest,
  ReleaseEvidenceError,
  selectReceiptForCommit,
} from "./release-evidence.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function option(name) {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && typeof argv[index + 1] === "string") return argv[index + 1];
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/** HEAD, or undefined when this is not a readable checkout. */
async function currentHead() {
  try {
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], {
      cwd: repository, shell: false, encoding: "utf8", maxBuffer: 1024 * 1024,
    });
    const head = stdout.trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
  } catch { return undefined; }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return undefined; }
}

async function main() {
  // The commit under evaluation picks its own receipt. A machine accumulates a
  // receipt per run, and choosing by file name meant an arbitrary one - a
  // superseded failing run could be read as the evidence for a commit that had
  // since passed.
  const headSha = await currentHead();
  let receiptPath;
  try {
    receiptPath = option("receipt") ?? await selectReceiptForCommit(repository, headSha);
  } catch (error) {
    if (error?.code !== "RELEASE_RECEIPT_AMBIGUOUS_FOR_COMMIT") throw error;
    // Naming them is the whole remedy: the operator deletes the superseded run
    // or passes --receipt. Choosing here would put an arbitrary run behind a
    // release, and the arbitrary run is a failed one half the time.
    stderr.write(`RELEASE_RECEIPT_AMBIGUOUS_FOR_COMMIT ${headSha}\n`);
    for (const path of error.receipts ?? []) stderr.write(`  ${path}\n`);
    stderr.write("  remove the superseded run, or name one with --receipt\n");
    return 1;
  }
  if (!receiptPath) {
    stderr.write(headSha
      ? `RELEASE_RECEIPT_ABSENT_FOR_COMMIT ${headSha}: run \`pnpm verify:local-pilot\` at this commit\n`
      : "RELEASE_RECEIPT_ABSENT: run `pnpm verify:local-pilot` first\n");
    return 1;
  }
  const receipt = await readJson(receiptPath);
  if (!receipt) {
    stderr.write("RELEASE_RECEIPT_UNREADABLE\n");
    return 1;
  }
  const { manifest, manifestBytes } = await readManifest(repository);
  const programContracts = await readJson(join(repository, "test-results", "program-contracts.json"));

  // Both or neither.  A trust set with nothing to check, or records with nothing
  // to check them against, is an operator who meant to verify authority and
  // will otherwise read the resulting NOT HELD lines as a finished answer.
  const trustPath = option("trust");
  const authorityPath = option("authority");
  if ((trustPath === undefined) !== (authorityPath === undefined)) {
    stderr.write("RELEASE_AUTHORITY_OPTIONS_INCOMPLETE: pass --trust <file> and --authority <dir|file> together\n");
    return 2;
  }
  const authority = trustPath !== undefined && authorityPath !== undefined
    ? await collectVerifiedAuthority({ repository, trustPath, authorityPath })
    : { verified: [], refusals: [], trust: null };

  // The refusals and the trust anchor go into the chain, not just onto this
  // process's stdout: the written file is what a reader is handed months later,
  // and an exit code is not carried in it.
  const chain = await buildReleaseEvidenceChain({
    repository, receipt, manifest, manifestBytes, programContracts,
    verifiedRecords: authority.verified,
    refusals: authority.refusals,
    authorityTrust: authority.trust ?? null,
  });

  const out = option("out") ?? join(repository, "test-results", "release-evidence", `${chain.sourceSha}.chain.json`);
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await writeFile(out, `${JSON.stringify(chain, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(out, 0o600);

  for (const gate of chain.gates) stdout.write(`  gate ${gate.gate}: ${gate.tests} tests\n`);
  for (const refusal of authority.refusals) {
    stdout.write(`  refused ${refusal.file}: ${refusal.code}\n`);
  }
  for (const record of chain.humanAuthority) {
    stdout.write(`  ${record.held ? "held" : "NOT HELD"}: ${record.what} (blocks: ${record.blocks})\n`);
  }
  if (!chain.ok) {
    for (const problem of chain.problems) {
      stderr.write(`  problem ${problem.code}${problem.gate ? ` (${problem.gate})` : ""}\n`);
    }
    stderr.write(`verify:pilot: FAIL sha=${chain.sourceSha}\n`);
    return 1;
  }
  // A record that was offered and refused is a different situation from a
  // record nobody has yet signed, and it does not get the softer ending.
  if (authority.refusals.length > 0) {
    stderr.write(`verify:pilot: AUTHORITY REFUSED sha=${chain.sourceSha}\n`);
    return 1;
  }
  stdout.write(`verify:pilot: ${chain.admissible ? "PASS" : "PASS (engineering evidence only)"} sha=${chain.sourceSha} chain=${chain.chainSha256}\n`);
  if (!chain.admissible) {
    stdout.write("  The engineering evidence holds. The release is not admissible for a\n");
    stdout.write("  classroom until the human records above are signed; no test can supply them.\n");
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  stderr.write(`${error instanceof ReleaseEvidenceError ? error.code : "RELEASE_EVIDENCE_FAILED"}\n`);
  process.exitCode = 1;
}
