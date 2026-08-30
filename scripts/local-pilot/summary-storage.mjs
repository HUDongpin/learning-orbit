import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const SEGMENTS = ["test-results", "local-pilot", "summaries"];
const fail = (code) => {
  throw new Error(code);
};

async function assertDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700
    || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    fail("REQUIRED_TEST_SUMMARY_DIRECTORY_INVALID");
  }
  return realpath(path);
}

export async function ownedSummaryDirectory(root, { create }) {
  if (!isAbsolute(root) || typeof create !== "boolean") {
    fail("REQUIRED_TEST_SUMMARY_DIRECTORY_INVALID");
  }
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const segment of SEGMENTS) {
    const next = join(current, segment);
    try {
      const canonical = await assertDirectory(next);
      if (canonical !== resolve(next)) fail("REQUIRED_TEST_SUMMARY_DIRECTORY_INVALID");
      current = canonical;
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
      if (!create) return undefined;
      try {
        await mkdir(next, { mode: 0o700, recursive: false });
        await chmod(next, 0o700);
      } catch {
        fail("REQUIRED_TEST_SUMMARY_DIRECTORY_INVALID");
      }
      current = await assertDirectory(next);
    }
  }
  return current;
}

export async function assertOwnedSummaryFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600
    || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    fail("REQUIRED_TEST_SUMMARY_READ_FAILED");
  }
}
