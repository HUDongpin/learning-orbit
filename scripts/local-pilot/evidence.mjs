import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { REQUIRED_PORTS, checkLoopbackPortFree } from "./preflight.mjs";

const execFileAsync = promisify(execFile);
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_EVIDENCE_FILE_BYTES = 64 * 1024 * 1024;
const FORBIDDEN_RECEIPT_KEY = /(email|token|cookie|password|secret|database[_-]?url|connection|recipient|room[_-]?code|seat[_-]?code|signed[_-]?url|content|prompt|magic[_-]?link)/i;

function fail(code) {
  throw new Error(code);
}

async function realDirectory(path, code) {
  if (!isAbsolute(path)) fail(code);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(code);
  return realpath(path);
}

function assertEvidenceSet(evidenceSet) {
  if (!evidenceSet || typeof evidenceSet !== "object" || Array.isArray(evidenceSet)) {
    fail("LOCAL_PILOT_EVIDENCE_SET_INVALID");
  }
  const entries = Object.entries(evidenceSet);
  if (entries.length === 0 || entries.some(([name, files]) => !/^[a-z][a-zA-Z0-9]{0,63}$/.test(name)
    || !Array.isArray(files) || files.length === 0 || new Set(files).size !== files.length
    || files.some((path) => typeof path !== "string" || path.length === 0 || path.includes("\u0000")
      || isAbsolute(path) || path.split("/").some((segment) => !segment || segment === "." || segment === "..")))) {
    fail("LOCAL_PILOT_EVIDENCE_SET_INVALID");
  }
  return entries;
}

export async function hashEvidenceSet(root, evidenceSet) {
  const canonicalRoot = await realDirectory(root, "LOCAL_PILOT_EVIDENCE_ROOT_INVALID");
  const entries = assertEvidenceSet(evidenceSet);
  const hashes = {};
  for (const [name, files] of entries) {
    const hash = createHash("sha256");
    for (const path of [...files].sort()) {
      const absolute = resolve(canonicalRoot, path);
      if (relative(canonicalRoot, absolute).startsWith("..")) {
        fail("LOCAL_PILOT_EVIDENCE_FILE_INVALID");
      }
      let info;
      let bytes;
      try {
        info = await lstat(absolute);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_EVIDENCE_FILE_BYTES
          || await realpath(absolute) !== absolute) {
          fail("LOCAL_PILOT_EVIDENCE_FILE_INVALID");
        }
        bytes = await readFile(absolute);
      } catch (error) {
        if (error instanceof Error && error.message === "LOCAL_PILOT_EVIDENCE_FILE_INVALID") throw error;
        fail("LOCAL_PILOT_EVIDENCE_FILE_INVALID");
      }
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(bytes.length));
      hash.update(path, "utf8");
      hash.update("\u0000");
      hash.update(length);
      hash.update(bytes);
    }
    hashes[name] = hash.digest("hex");
  }
  return Object.freeze(hashes);
}

async function defaultRunGit(repository, argv) {
  return execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "-C", repository, ...argv], {
    encoding: "utf8",
    shell: false,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    timeout: 30_000,
    killSignal: "SIGTERM",
  });
}

export async function assertFinalRepositoryState({
  repository,
  sourceSha,
  expectedHashes,
  evidenceSet,
  runGit = (argv) => defaultRunGit(repository, argv),
  checkPort = checkLoopbackPortFree,
}) {
  if (!isAbsolute(repository) || !/^[0-9a-f]{40}$/.test(sourceSha)
    || !expectedHashes || typeof expectedHashes !== "object" || Array.isArray(expectedHashes)
    || Object.values(expectedHashes).some((hash) => typeof hash !== "string" || !SHA256.test(hash))
    || typeof runGit !== "function" || typeof checkPort !== "function") {
    fail("LOCAL_PILOT_FINAL_STATE_CONFIG_INVALID");
  }
  let before;
  let status;
  let after;
  try {
    before = (await runGit(["rev-parse", "HEAD"])).stdout;
    status = (await runGit(["status", "--porcelain=v1", "-z"])).stdout;
    after = (await runGit(["rev-parse", "HEAD"])).stdout;
  } catch {
    fail("LOCAL_PILOT_FINAL_GIT_CHECK_FAILED");
  }
  if (before.trim() !== sourceSha || after.trim() !== sourceSha) {
    fail("LOCAL_PILOT_FINAL_SHA_DRIFT");
  }
  if (status !== "") fail("LOCAL_PILOT_FINAL_WORKTREE_DIRTY");
  const actualHashes = await hashEvidenceSet(repository, evidenceSet);
  if (Object.keys(actualHashes).sort().join("\u0000") !== Object.keys(expectedHashes).sort().join("\u0000")
    || Object.entries(expectedHashes).some(([name, hash]) => actualHashes[name] !== hash)) {
    fail("LOCAL_PILOT_EVIDENCE_HASH_DRIFT");
  }
  for (const port of REQUIRED_PORTS) {
    let released;
    try {
      released = await checkPort(port);
    } catch {
      fail(`LOCAL_PILOT_PORT_RELEASE_CHECK_FAILED_${port}`);
    }
    if (released !== true) fail(`LOCAL_PILOT_PORT_NOT_RELEASED_${port}`);
  }
}

function inspectReceipt(value, seen, depth = 0) {
  if (depth > 16) fail("LOCAL_PILOT_RECEIPT_INVALID");
  if (value === null || typeof value === "boolean"
    || (typeof value === "number" && Number.isSafeInteger(value))) return;
  if (typeof value === "string") {
    if (value.length > 4_096 || value.includes("\u0000")
      || /(?:[?&](?:token|cookie|password|secret)=|postgres(?:ql)?:\/\/|--(?:token|cookie|password|secret)=)/i.test(value)) {
      fail("LOCAL_PILOT_RECEIPT_SENSITIVE");
    }
    try {
      const parsed = new URL(value);
      if (parsed.username || parsed.password) fail("LOCAL_PILOT_RECEIPT_SENSITIVE");
    } catch (error) {
      if (error instanceof Error && error.message === "LOCAL_PILOT_RECEIPT_SENSITIVE") throw error;
    }
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    fail("LOCAL_PILOT_RECEIPT_INVALID");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 10_000) fail("LOCAL_PILOT_RECEIPT_INVALID");
    value.forEach((item) => inspectReceipt(item, seen, depth + 1));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) fail("LOCAL_PILOT_RECEIPT_INVALID");
      if (FORBIDDEN_RECEIPT_KEY.test(key)) fail("LOCAL_PILOT_RECEIPT_SENSITIVE");
      inspectReceipt(item, seen, depth + 1);
    }
  }
  seen.delete(value);
}

export function assertContentFreeReceipt(receipt) {
  inspectReceipt(receipt, new WeakSet());
  if (!receipt || receipt.schemaVersion !== 1 || !/^[0-9a-f]{16}$/.test(receipt.runId ?? "")
    || !/^[0-9a-f]{40}$/.test(receipt.sourceSha ?? "")) {
    fail("LOCAL_PILOT_RECEIPT_INVALID");
  }
  return receipt;
}

async function ownedReceiptDirectory(repository) {
  const root = await realDirectory(repository, "LOCAL_PILOT_RECEIPT_DIRECTORY_INVALID");
  let current = root;
  for (const [index, segment] of ["test-results", "local-pilot"].entries()) {
    const path = join(current, segment);
    try {
      const info = await lstat(path);
      const permissions = info.mode & 0o777;
      const permissionsInvalid = index === 0
        ? (permissions & 0o022) !== 0
        : permissions !== 0o700;
      if (!info.isDirectory() || info.isSymbolicLink() || permissionsInvalid
        || (typeof process.getuid === "function" && info.uid !== process.getuid())
        || await realpath(path) !== path) {
        fail("LOCAL_PILOT_RECEIPT_DIRECTORY_INVALID");
      }
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
      try {
        await mkdir(path, { mode: 0o700, recursive: false });
        await chmod(path, 0o700);
      } catch {
        fail("LOCAL_PILOT_RECEIPT_DIRECTORY_INVALID");
      }
    }
    current = path;
  }
  return current;
}

export async function writeLocalPilotReceipt({ repository, receipt }) {
  assertContentFreeReceipt(receipt);
  const directory = await ownedReceiptDirectory(repository);
  const path = join(directory, `run-${receipt.runId}.receipt.json`);
  try {
    await writeFile(path, `${JSON.stringify(receipt)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(path, 0o600);
    return path;
  } catch (error) {
    if (error?.code === "EEXIST") fail("LOCAL_PILOT_RECEIPT_EXISTS");
    fail("LOCAL_PILOT_RECEIPT_WRITE_FAILED");
  }
}
