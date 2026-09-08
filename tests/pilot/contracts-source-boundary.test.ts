import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

/**
 * The tsx-run operator tools must read the contracts from the workspace
 * source, never through the built package.
 *
 * `packages/contracts` publishes types from `src` and runtime from `dist`, and
 * `dist` is gitignored. A tool that resolves the package name therefore reads
 * whatever was last built - absent on a fresh clone, stale on any checkout
 * older than the newest contract - while its own typecheck stays green against
 * the source. Under tsx these scripts load as CommonJS, so a missing export
 * arrives as `undefined` rather than a link error, and the first symptom is a
 * TypeError that each tool's catch reports as a governance refusal. On the day
 * real signed records arrive that reads as "your record is bad" when the truth
 * is "this checkout was never built".
 *
 * Nothing else can catch a regression here, which is why it is pinned as
 * source text: every gate in this repository runs on a built tree, so the bare
 * specifier works everywhere the suites look and fails only in an operator's
 * hands.
 */
const SOURCE_ONLY_TOOLS = [
  "scripts/verify-controlled-authority.ts",
  "scripts/verify-shadow-record.ts",
  "scripts/import-approved-pilot-policy.ts",
];

const PACKAGE_SPECIFIER = /from\s+["']@learning-orbit\/contracts["']/;

describe("contracts source boundary", () => {
  it("keeps the operator tools off the built package", async () => {
    const offenders: string[] = [];
    for (const tool of SOURCE_ONLY_TOOLS) {
      const source = await readFile(resolve(root, tool), "utf8");
      if (PACKAGE_SPECIFIER.test(source)) offenders.push(tool);
      if (!source.includes('from "./contracts-entrypoint.js"')) offenders.push(`${tool} (no entrypoint import)`);
    }

    expect(offenders).toEqual([]);
  });

  it("reads the shared entrypoint from source, and guards what it re-exports", async () => {
    const entrypoint = await readFile(resolve(root, "scripts/contracts-entrypoint.ts"), "utf8");

    // The seam itself must not resolve the package name either, or every tool
    // behind it inherits the problem it exists to remove.
    expect(PACKAGE_SPECIFIER.test(entrypoint)).toBe(false);
    expect(entrypoint).toContain('from "../packages/contracts/src/index.js"');
    // A bounded refusal, not a TypeError, if the source stops exporting one.
    expect(entrypoint).toContain("CONTRACTS_ENTRYPOINT_INCOMPLETE");
  });
});
