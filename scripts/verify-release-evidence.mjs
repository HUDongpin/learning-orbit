#!/usr/bin/env node
/**
 * Assert the release evidence chain on one frozen commit.
 *
 * This reads evidence; it never produces any.  Run the pilot first
 * (`pnpm verify:local-pilot`), then run this against the receipt it wrote.
 * Keeping the two apart is the point: a verifier that could also generate the
 * thing it verifies would always pass.
 *
 *   pnpm verify:pilot [--receipt <path>] [--out <path>]
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, exitCode, stderr, stdout } from "node:process";

import {
  buildReleaseEvidenceChain,
  listReceipts,
  readManifest,
  ReleaseEvidenceError,
} from "./release-evidence.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function option(name) {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && typeof argv[index + 1] === "string") return argv[index + 1];
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return undefined; }
}

async function main() {
  const receiptPath = option("receipt") ?? (await listReceipts(repository))[0];
  if (!receiptPath) {
    stderr.write("RELEASE_RECEIPT_ABSENT: run `pnpm verify:local-pilot` first\n");
    return 1;
  }
  const receipt = await readJson(receiptPath);
  if (!receipt) {
    stderr.write("RELEASE_RECEIPT_UNREADABLE\n");
    return 1;
  }
  const { manifest, manifestBytes } = await readManifest(repository);
  const programContracts = await readJson(join(repository, "test-results", "program-contracts.json"));

  const chain = await buildReleaseEvidenceChain({
    repository, receipt, manifest, manifestBytes, programContracts,
  });

  const out = option("out") ?? join(repository, "test-results", "release-evidence", `${chain.sourceSha}.chain.json`);
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await writeFile(out, `${JSON.stringify(chain, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(out, 0o600);

  for (const gate of chain.gates) stdout.write(`  gate ${gate.gate}: ${gate.tests} tests\n`);
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
