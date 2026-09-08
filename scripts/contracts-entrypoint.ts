/**
 * The shared contracts, as the tsx-run operator tools read them.
 *
 * These tools are TypeScript that tsx runs straight from the working tree.
 * They are never compiled and never shipped, so they read the contracts from
 * the same source tree TypeScript checks, by relative path — the way
 * `assert-program-contracts.ts` already reads `coverage.js` and `routes.js`.
 * The package specifier is deliberately not used here. Its `import` condition
 * resolves to `packages/contracts/dist`, which is gitignored: on a fresh clone
 * it is absent, and after a contract lands it is stale until someone remembers
 * to build. Neither is a state an operator holding a real signed record should
 * have to know about, and nothing about a governance record depends on it.
 *
 * Staleness was silent rather than loud for one specific reason. The
 * repository root declares no `"type"`, so tsx loads these scripts as
 * CommonJS, and CommonJS interop turns a named import the loaded module does
 * not provide into `undefined` instead of the link-time error ESM raises. The
 * first thing anyone saw was `.parse` on `undefined` — a TypeError the tools
 * caught and reported as `AUTHORITY_VERIFICATION_FAILED`, a code that blames
 * the record for a fault in the toolchain.
 *
 * Reading source removes that. The check below is what stands behind it:
 * nothing type-checks `scripts/` — no tsconfig includes it — so if the
 * entrypoint ever stops providing a parser these tools apply, this is the only
 * thing that would notice. A tool that cannot load the contract it is supposed
 * to apply has nothing to say about a record, so it refuses before reading
 * one, with a bounded code on the first line of stderr where callers look.
 */
import { exit, stderr } from "node:process";

import {
  externalAuthorizationRecordContract,
  humanShadowRecordContract,
  pilotRetentionPolicyContract,
  studentVisiblePromotionRecordContract,
} from "../packages/contracts/src/index.js";

/** Every parser the three operator tools apply to a governance payload. */
const REQUIRED_PARSERS: ReadonlyArray<{ parse?: unknown } | undefined> = [
  externalAuthorizationRecordContract,
  humanShadowRecordContract,
  pilotRetentionPolicyContract,
  studentVisiblePromotionRecordContract,
];

// Which one is missing is not printed. A refusal is one bounded code, and the
// detail belongs to whoever runs the remedy, not to a release log.
if (REQUIRED_PARSERS.some((contract) => typeof contract?.parse !== "function")) {
  stderr.write("CONTRACTS_ENTRYPOINT_INCOMPLETE\n");
  // No build is offered as a remedy: this module reads the workspace source,
  // so a stale dist cannot cause this and rebuilding one cannot cure it. The
  // entrypoint itself has stopped exporting a parser these tools apply.
  stderr.write("  no parser for a record these tools must check:"
    + " repair packages/contracts/src/index.ts\n");
  exit(1);
}

export {
  externalAuthorizationRecordContract,
  humanShadowRecordContract,
  pilotRetentionPolicyContract,
  studentVisiblePromotionRecordContract,
};
export type { PilotRetentionPolicyRecord } from "../packages/contracts/src/index.js";
