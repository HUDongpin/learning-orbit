#!/usr/bin/env -S pnpm tsx
/**
 * Check a completed teacher shadow record.
 *
 * Two questions, deliberately kept apart. Is the document a coherent account
 * of a session that happened — and is it signed by someone with standing to
 * say so? A record can be perfectly well-formed and carry no authority, and a
 * validly signed record can still describe a rehearsal. Both have to hold.
 *
 * Engineering wrote this checker and cannot supply what it checks. The record
 * comes from a teacher who ran the session.
 *
 *   pnpm tsx scripts/verify-shadow-record.ts --record <file> [--trust <file>]
 *   pnpm tsx scripts/verify-shadow-record.ts --example
 */
import { readFile } from "node:fs/promises";
import { argv, exit, stderr, stdout } from "node:process";

import { humanShadowRecordContract } from "@learning-orbit/contracts";

import {
  ControlledAuthorityError,
  parseAuthorityTrustSet,
  parseSignedAuthorityRecord,
  verifyControlledAuthority,
} from "../apps/server/src/modules/authorization/controlled-authority-verifier.js";

function option(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && typeof argv[index + 1] === "string") return argv[index + 1];
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/** The shape a teacher fills in, so the template and the checker cannot drift. */
const EXAMPLE = {
  recordKind: "human_shadow_completed",
  shadowId: "00000000-0000-4000-8000-000000000001",
  roomId: "00000000-0000-4000-8000-000000000002",
  teacherRef: "0".repeat(64),
  rehearsal: false,
  studentsPresent: false,
  startedAt: "2026-09-07T09:00:00.000Z",
  endedAt: "2026-09-07T09:45:00.000Z",
  agentRunsObserved: ["00000000-0000-4000-8000-000000000003"],
  observations: [{
    agentRunId: "00000000-0000-4000-8000-000000000003",
    outcome: "appropriate",
    note: "What the agent did, and why it was or was not appropriate.",
  }],
  verdict: "not_ready",
  conditions: ["Anything that must be true before students are admitted."],
};

async function main(): Promise<void> {
  if (argv.includes("--example")) {
    stdout.write(`${JSON.stringify(EXAMPLE, null, 2)}\n`);
    return;
  }
  const recordPath = option("record");
  if (!recordPath) {
    stderr.write("usage: verify-shadow-record --record <file> [--trust <file>] | --example\n");
    exit(2);
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(recordPath, "utf8"));
  } catch {
    stderr.write("SHADOW_RECORD_UNREADABLE\n");
    exit(1);
    return;
  }

  // A signed envelope carries the record in `payload`; an unsigned draft is
  // the record itself. Both are checked for coherence; only the first can
  // carry authority.
  const envelope = raw as { payload?: unknown; signature?: unknown };
  const body = envelope?.signature ? envelope.payload : raw;

  let parsed;
  try {
    parsed = humanShadowRecordContract.parse(body);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : "INVALID_HUMAN_SHADOW_RECORD"}\n`);
    exit(1);
    return;
  }

  const trustPath = option("trust");
  let signedBy: string | undefined;
  if (trustPath) {
    try {
      const signed = parseSignedAuthorityRecord(JSON.stringify(raw));
      const trust = parseAuthorityTrustSet(await readFile(trustPath, "utf8"));
      const verified = verifyControlledAuthority(signed, trust);
      if (verified.kind !== "human_shadow_completed") {
        stderr.write("SHADOW_RECORD_KIND_MISMATCH\n");
        exit(1);
        return;
      }
      signedBy = `${verified.issuer}/${verified.keyId}`;
    } catch (error) {
      stderr.write(`${error instanceof ControlledAuthorityError ? error.code : "SHADOW_SIGNATURE_INVALID"}\n`);
      exit(1);
      return;
    }
  }

  const minutes = Math.round(
    (Date.parse(parsed.endedAt) - Date.parse(parsed.startedAt)) / 60_000,
  );
  stdout.write(`${JSON.stringify({
    ok: true,
    shadowId: parsed.shadowId,
    minutes,
    runsObserved: parsed.agentRunsObserved.length,
    verdict: parsed.verdict,
    signedBy: signedBy ?? null,
  })}\n`);
  if (!signedBy) {
    // Saying so is the point. A coherent unsigned record is a draft, and Gate
    // 6 does not admit drafts.
    stdout.write("  coherent, but unsigned: pass --trust to check authority\n");
  }
  if (parsed.verdict !== "ready_for_students") {
    stdout.write("  the shadow did not clear the system for students\n");
  }
}

void main();
