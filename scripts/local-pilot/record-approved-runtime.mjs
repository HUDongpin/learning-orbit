#!/usr/bin/env node
/**
 * Print the approved-runtime manifest entry for the toolchain running this
 * command.  It writes nothing: an operator reviews the emitted entry and adds
 * it to infra/local-pilot/approved-runtimes.v1.json themselves, so a new
 * machine becomes admissible through a reviewed data change rather than a
 * silent gate edit.
 *
 *   node scripts/local-pilot/record-approved-runtime.mjs --id my-workstation
 */
import { argv, env, execPath, exit, stderr, stdout } from "node:process";
import { resolve } from "node:path";

import {
  probeRuntimeExecutableFingerprints,
  loadApprovedRuntimeToolchains,
} from "./preflight.mjs";

function optionValue(name) {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && typeof argv[index + 1] === "string") return argv[index + 1];
  const inline = argv.find((argument) => argument.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

const id = optionValue("id");
if (typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
  stderr.write("usage: record-approved-runtime --id <kebab-case-id> [--pnpm <path>] [--python <path>]\n");
  exit(2);
}

const pnpmPath = resolve(optionValue("pnpm") ?? `${env.HOME}/.npm-global/bin/pnpm`);
const pythonPath = resolve(optionValue("python") ?? ".venv/bin/python");

let fingerprints;
try {
  fingerprints = await probeRuntimeExecutableFingerprints({
    nodePath: execPath,
    pnpmPath,
    pythonPath,
  });
} catch (error) {
  stderr.write(`${error instanceof Error ? error.message : "LOCAL_PILOT_RUNTIME_EXECUTABLE_INVALID"}\n`);
  exit(1);
}

const existing = await loadApprovedRuntimeToolchains();
const already = existing.find(
  (toolchain) => Object.entries(fingerprints).every(([name, sha]) => toolchain.executables[name] === sha),
);
if (already) {
  stdout.write(`already approved as "${already.id}"\n`);
  exit(0);
}

stdout.write(`${JSON.stringify({ id, note: "", executables: fingerprints }, null, 2)}\n`);
