import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  assertOwnedDirectory,
  assertOwnershipMarker,
  buildRunIdentity,
  removeOwnedDirectory,
  writeOwnershipMarker,
} from "./ownership.mjs";

const execFileAsync = promisify(execFile);
const fail = (code) => {
  throw new Error(code);
};

function assertIdentity(identity) {
  const rebuilt = buildRunIdentity(identity);
  if (rebuilt.composeProject !== identity.composeProject
    || rebuilt.databaseName !== identity.databaseName) {
    fail("LOCAL_PILOT_IDENTITY_INVALID");
  }
}

async function realDirectory(path, code) {
  if (!isAbsolute(path)) fail(code);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(code);
  return realpath(path);
}

async function runGit(sourceRepository, args, commandEvidence) {
  const startedAt = new Date().toISOString();
  try {
    const env = {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
      const value = process.env[name];
      if (typeof value === "string" && value.length > 0 && !value.includes("\u0000")) env[name] = value;
    }
    const argv = [
      "-c", "core.hooksPath=/dev/null", "-C", sourceRepository, ...args,
    ];
    const result = await execFileAsync("git", argv, {
      encoding: "utf8",
      env,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      timeout: 60_000,
      killSignal: "SIGTERM",
    });
    commandEvidence?.recordCommand({
      executable: "git",
      argv,
      exitCode: 0,
      startedAt,
      endedAt: new Date().toISOString(),
      stdout: result.stdout,
      stderr: result.stderr,
    });
    return result;
  } catch (error) {
    commandEvidence?.recordCommand({
      executable: "git",
      argv: ["-c", "core.hooksPath=/dev/null", "-C", sourceRepository, ...args],
      exitCode: Number.isSafeInteger(error?.code) ? error.code : 1,
      startedAt,
      endedAt: new Date().toISOString(),
      stdout: error?.stdout,
      stderr: error?.stderr,
    });
    fail("LOCAL_PILOT_GIT_COMMAND_FAILED");
  }
}

// git-worktree(1) "Porcelain Format": every record opens with `worktree <path>`;
// `HEAD` and `branch` always carry a value; `detached` and `bare` are label-only
// booleans; `locked` and `prunable` appear either as a bare label or with a
// reason. Under -z that reason is emitted raw and may contain spaces and
// newlines, so only NUL separates fields. Keeping the three groups separate
// leaves an attribute Git does not document fatal rather than merely unhandled.
const VALUED_ATTRIBUTES = new Set(["worktree", "HEAD", "branch"]);
const FLAG_ATTRIBUTES = new Set(["detached", "bare"]);
const REASON_ATTRIBUTES = new Set(["locked", "prunable"]);

function completedRecord(record) {
  const path = record.worktree;
  if (typeof path !== "string" || !isAbsolute(path)) {
    fail("LOCAL_PILOT_WORKTREE_LIST_INVALID");
  }
  // Carry locked, prunable and bare onto the record so callers can refuse on
  // them deliberately instead of meeting them later as an unexplained command
  // failure. Only presence is carried: a reason is unbounded operator-supplied
  // text and no check needs it.
  const locked = Object.hasOwn(record, "locked");
  const prunable = Object.hasOwn(record, "prunable");
  const bare = record.bare === true;
  if (bare) {
    // A bare repository has no checkout, so Git emits neither HEAD nor branch
    // nor detached for its record. Anything else alongside bare is a shape this
    // parser does not understand.
    if (Object.hasOwn(record, "HEAD") || Object.hasOwn(record, "branch")
      || Object.hasOwn(record, "detached")) {
      fail("LOCAL_PILOT_WORKTREE_LIST_INVALID");
    }
    return Object.freeze({ path, sha: null, branch: null, detached: false, bare, locked, prunable });
  }
  const sha = record.HEAD;
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) fail("LOCAL_PILOT_WORKTREE_LIST_INVALID");
  const detached = record.detached === true;
  const branch = typeof record.branch === "string" ? record.branch : null;
  if (detached === (branch !== null)) fail("LOCAL_PILOT_WORKTREE_LIST_INVALID");
  return Object.freeze({ path, sha, branch, detached, bare, locked, prunable });
}

export function parseWorktreePorcelain(text) {
  if (typeof text !== "string" || !text.endsWith("\u0000")) {
    fail("LOCAL_PILOT_WORKTREE_LIST_INVALID");
  }
  const records = [];
  let current = null;
  for (const field of text.split("\u0000")) {
    if (field === "") {
      if (current !== null) {
        records.push(completedRecord(current));
        current = null;
      }
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? true : field.slice(separator + 1);
    if (key === "worktree") {
      // worktree opens a record and never repeats inside one.
      if (current !== null) fail("LOCAL_PILOT_WORKTREE_LIST_INVALID");
      current = {};
    } else if (current === null) {
      // An attribute outside any record means the stream was regrouped or
      // truncated; absorbing it would reassign it to a different worktree.
      fail("LOCAL_PILOT_WORKTREE_LIST_INVALID");
    }
    const valued = VALUED_ATTRIBUTES.has(key);
    const flag = FLAG_ATTRIBUTES.has(key);
    if ((!valued && !flag && !REASON_ATTRIBUTES.has(key))
      || Object.hasOwn(current, key) || value === ""
      || (valued && value === true) || (flag && value !== true)) {
      fail("LOCAL_PILOT_WORKTREE_LIST_INVALID");
    }
    current[key] = value;
  }
  if (current !== null || records.length === 0) {
    fail("LOCAL_PILOT_WORKTREE_LIST_INVALID");
  }
  return records;
}

// A harness failure carries its own bounded code in its message. Recover it so a
// failed cleanup can report the cause alongside itself instead of overwriting
// it, and fall back to a bounded code when the failure came from elsewhere.
function setupFailureCode(error) {
  const message = error instanceof Error ? error.message : "";
  return /^(LOCAL_PILOT_[A-Z0-9_]+)/.exec(message)?.[1] ?? "LOCAL_PILOT_WORKTREE_SETUP_FAILED";
}

// The run's own checkout must stay deletable by this harness. A locked entry
// refuses worktree remove, so finding one is a refusal rather than a shrug, and
// a bare entry is not a checkout at all. Each carries its own code so the cause
// is named instead of surfacing as a generic mismatch or a Git command failure.
function assertOwnRegistrationRemovable(record) {
  if (record.bare) fail("LOCAL_PILOT_WORKTREE_REGISTRATION_BARE");
  if (record.locked) fail("LOCAL_PILOT_WORKTREE_REGISTRATION_LOCKED");
}

async function registeredWorktrees(sourceRepository, runCommand = runGit) {
  const { stdout } = await runCommand(sourceRepository, ["worktree", "list", "--porcelain", "-z"]);
  return parseWorktreePorcelain(stdout);
}

async function assertSourceSnapshot(sourceRepository, identity, runCommand = runGit) {
  const { stdout: headBefore } = await runCommand(sourceRepository, ["rev-parse", "HEAD"]);
  const { stdout: status } = await runCommand(sourceRepository, ["status", "--porcelain=v1", "-z"]);
  const { stdout: headAfter } = await runCommand(sourceRepository, ["rev-parse", "HEAD"]);
  if (headBefore.trim() !== identity.sourceSha || headAfter.trim() !== identity.sourceSha) {
    fail("LOCAL_PILOT_SOURCE_SHA_MISMATCH");
  }
  if (status !== "") fail("LOCAL_PILOT_SOURCE_WORKTREE_DIRTY");
}

export async function createDetachedPilotWorktree({
  sourceRepository,
  targetParent,
  identity,
  runCommand,
  commandEvidence,
}) {
  assertIdentity(identity);
  if ((runCommand !== undefined && typeof runCommand !== "function")
    || (commandEvidence !== undefined && typeof commandEvidence?.recordCommand !== "function")) {
    fail("LOCAL_PILOT_WORKTREE_RUNNER_INVALID");
  }
  const runner = runCommand ?? ((source, args) => runGit(source, args, commandEvidence));
  const source = await realDirectory(sourceRepository, "LOCAL_PILOT_SOURCE_REPOSITORY_INVALID");
  const parent = await realDirectory(targetParent, "LOCAL_PILOT_TARGET_PARENT_INVALID");
  await assertSourceSnapshot(source, identity, runner);
  const runDirectory = join(parent, `lo-pilot-run-${identity.runId}`);
  const worktreePath = join(runDirectory, "checkout");
  const markerPath = await writeOwnershipMarker(runDirectory, identity);
  try {
    await runner(source, ["worktree", "add", "--detach", worktreePath, identity.sourceSha]);
    const [{ stdout: checkoutHead }, { stdout: checkoutBranch }, records] = await Promise.all([
      runner(worktreePath, ["rev-parse", "HEAD"]),
      runner(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]),
      registeredWorktrees(source, runner),
    ]);
    const registered = records.filter((record) => resolve(record.path) === resolve(worktreePath));
    if (registered.length !== 1) fail("LOCAL_PILOT_WORKTREE_REGISTRATION_MISMATCH");
    assertOwnRegistrationRemovable(registered[0]);
    // A prunable entry means Git already considers this registration's metadata
    // lost, so the checkout it names is not the one just created. Refuse under
    // its own code before comparing the SHA that entry claims.
    if (registered[0].prunable) fail("LOCAL_PILOT_WORKTREE_REGISTRATION_PRUNABLE");
    if (checkoutHead.trim() !== identity.sourceSha || checkoutBranch.trim() !== "HEAD"
      || registered[0].sha !== identity.sourceSha
      || registered[0].detached !== true) {
      fail("LOCAL_PILOT_WORKTREE_REGISTRATION_MISMATCH");
    }
    return Object.freeze({ runDirectory, worktreePath, markerPath });
  } catch (error) {
    try {
      const records = await registeredWorktrees(source, runner);
      const registered = records.filter((record) => resolve(record.path) === resolve(worktreePath));
      if (registered.length > 1) fail("LOCAL_PILOT_WORKTREE_SETUP_CLEANUP_FAILED");
      if (registered.length === 1) {
        await runner(source, ["worktree", "remove", "--force", worktreePath]);
        const remaining = await registeredWorktrees(source, runner);
        if (remaining.some((record) => resolve(record.path) === resolve(worktreePath))) {
          fail("LOCAL_PILOT_WORKTREE_SETUP_CLEANUP_FAILED");
        }
      }
      await removeOwnedDirectory({ directory: runDirectory, expectedParent: parent, identity });
    } catch {
      // Preserve the exact owner-marked directory when registration cannot be
      // proven absent. Removing bytes while leaving unknown Git metadata would
      // lose the only safe recovery handle.
      //
      // Lead with the setup failure's own code. Cleanup re-reads the same
      // registration listing that setup did, so a fault in that read resurfaces
      // here; reporting only the cleanup code hid the cause and left the reason
      // for the failure to be recovered by reproduction. The cleanup code stays
      // appended so the run is still reported as having left this directory,
      // and possibly Git metadata, behind for manual recovery.
      throw new Error(
        `${setupFailureCode(error)} LOCAL_PILOT_WORKTREE_SETUP_CLEANUP_FAILED`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function removeDetachedPilotWorktree({
  sourceRepository,
  targetParent,
  owned,
  identity,
  runCommand,
  commandEvidence,
}) {
  assertIdentity(identity);
  if ((runCommand !== undefined && typeof runCommand !== "function")
    || (commandEvidence !== undefined && typeof commandEvidence?.recordCommand !== "function")) {
    fail("LOCAL_PILOT_WORKTREE_RUNNER_INVALID");
  }
  const runner = runCommand ?? ((sourcePath, args) => runGit(sourcePath, args, commandEvidence));
  const source = await realDirectory(sourceRepository, "LOCAL_PILOT_SOURCE_REPOSITORY_INVALID");
  const parent = await realDirectory(targetParent, "LOCAL_PILOT_TARGET_PARENT_INVALID");
  if (!owned || resolve(owned.runDirectory) !== resolve(join(parent, `lo-pilot-run-${identity.runId}`))
    || resolve(owned.worktreePath) !== resolve(join(owned.runDirectory, "checkout"))
    || resolve(owned.markerPath) !== resolve(join(owned.runDirectory, "ownership.json"))) {
    fail("LOCAL_PILOT_WORKTREE_DELETE_SCOPE_INVALID");
  }
  const markerInfo = await lstat(owned.markerPath);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
    fail("LOCAL_PILOT_OWNERSHIP_MARKER_INVALID");
  }
  assertOwnershipMarker(JSON.parse(await readFile(owned.markerPath, "utf8")), identity);
  await assertOwnedDirectory({
    directory: owned.runDirectory,
    expectedParent: parent,
    identity,
  });
  const records = await registeredWorktrees(source, runner);
  const registered = records.filter((record) => resolve(record.path) === resolve(owned.worktreePath));
  if (registered.length !== 1) fail("LOCAL_PILOT_WORKTREE_REGISTRATION_MISMATCH");
  // A locked or bare entry cannot be force-removed below, so name that cause
  // rather than letting it surface as a generic Git command failure. A prunable
  // entry is deliberately not refused here: removing it is exactly the cleanup
  // this function exists to perform.
  assertOwnRegistrationRemovable(registered[0]);
  if (registered[0].sha !== identity.sourceSha || registered[0].detached !== true) {
    fail("LOCAL_PILOT_WORKTREE_REGISTRATION_MISMATCH");
  }
  let finalStateFailure;
  try {
    const { stdout: headBefore } = await runner(owned.worktreePath, ["rev-parse", "HEAD"]);
    const { stdout: status } = await runner(
      owned.worktreePath,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    );
    const { stdout: headAfter } = await runner(owned.worktreePath, ["rev-parse", "HEAD"]);
    if (headBefore.trim() !== identity.sourceSha || headAfter.trim() !== identity.sourceSha) {
      finalStateFailure = "LOCAL_PILOT_WORKTREE_FINAL_SHA_DRIFT";
    } else if (status !== "") {
      finalStateFailure = "LOCAL_PILOT_WORKTREE_FINAL_DIRTY";
    }
  } catch {
    finalStateFailure = "LOCAL_PILOT_WORKTREE_FINAL_CHECK_FAILED";
  }
  // The exact registration, detached SHA and owner marker above are the
  // deletion capability. Even when final-state evidence fails, remove only
  // this proven run-owned checkout, then surface the failure to the workflow.
  await runner(source, ["worktree", "remove", "--force", owned.worktreePath]);
  const remaining = await registeredWorktrees(source, runner);
  if (remaining.some((record) => resolve(record.path) === resolve(owned.worktreePath))) {
    fail("LOCAL_PILOT_WORKTREE_REMOVE_FAILED");
  }
  await removeOwnedDirectory({ directory: owned.runDirectory, expectedParent: parent, identity });
  if (finalStateFailure) fail(finalStateFailure);
}
