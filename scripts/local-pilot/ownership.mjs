import { chmod, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

const MARKER_NAME = "ownership.json";
const MARKER_KEYS = Object.freeze([
  "runId",
  "sourceSha",
  "creatorPid",
  "composeProject",
  "databaseName",
]);

const fail = (code) => {
  throw new Error(code);
};

function assertRunId(runId) {
  if (typeof runId !== "string" || !/^[0-9a-f]{16}$/.test(runId)) {
    fail("LOCAL_PILOT_RUN_ID_INVALID");
  }
}

export function buildRunIdentity({ runId, sourceSha, creatorPid }) {
  assertRunId(runId);
  if (typeof sourceSha !== "string" || !/^[0-9a-f]{40}$/.test(sourceSha)) {
    fail("LOCAL_PILOT_SOURCE_SHA_INVALID");
  }
  if (!Number.isSafeInteger(creatorPid) || creatorPid < 1) {
    fail("LOCAL_PILOT_CREATOR_PID_INVALID");
  }
  return Object.freeze({
    runId,
    sourceSha,
    creatorPid,
    composeProject: `lo-pilot-${runId}`,
    databaseName: `lo_pilot_${runId}_test`,
  });
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function assertOwnershipMarker(marker, identity) {
  if (!isPlainObject(marker)
    || Object.keys(marker).sort().join("\u0000") !== [...MARKER_KEYS].sort().join("\u0000")) {
    fail("LOCAL_PILOT_OWNERSHIP_MARKER_INVALID");
  }
  for (const key of MARKER_KEYS) {
    if (marker[key] !== identity[key]) fail("LOCAL_PILOT_OWNERSHIP_MISMATCH");
  }
  return Object.freeze({ ...marker });
}

async function assertRealDirectory(directory) {
  if (!isAbsolute(directory)) fail("LOCAL_PILOT_DIRECTORY_INVALID");
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("LOCAL_PILOT_DIRECTORY_INVALID");
  return realpath(directory);
}

export async function writeOwnershipMarker(directory, identity) {
  buildRunIdentity(identity);
  if (!isAbsolute(directory)) fail("LOCAL_PILOT_DIRECTORY_INVALID");
  const parent = dirname(directory);
  const actualParent = await assertRealDirectory(parent);
  const actualDirectory = join(actualParent, basename(directory));
  try {
    await mkdir(actualDirectory, { mode: 0o700, recursive: false });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      fail("LOCAL_PILOT_TARGET_ALREADY_EXISTS");
    }
    fail("LOCAL_PILOT_DIRECTORY_CREATE_FAILED");
  }
  await chmod(actualDirectory, 0o700);
  await assertRealDirectory(actualDirectory);
  const markerPath = join(actualDirectory, MARKER_NAME);
  let handle;
  try {
    handle = await open(markerPath, "wx", 0o600);
    const marker = Object.fromEntries(MARKER_KEYS.map((key) => [key, identity[key]]));
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.close();
    await chmod(markerPath, 0o600);
  } catch {
    await handle?.close().catch(() => undefined);
    await rm(actualDirectory, { recursive: true, force: true });
    fail("LOCAL_PILOT_OWNERSHIP_MARKER_WRITE_FAILED");
  }
  return markerPath;
}

export async function assertOwnedDirectory({ directory, expectedParent, identity }) {
  buildRunIdentity(identity);
  if (!isAbsolute(directory) || !isAbsolute(expectedParent)
    || basename(directory) !== `lo-pilot-run-${identity.runId}`) {
    fail("LOCAL_PILOT_DELETE_SCOPE_INVALID");
  }
  const [actualDirectory, actualParent] = await Promise.all([
    assertRealDirectory(directory),
    assertRealDirectory(expectedParent),
  ]);
  if (dirname(actualDirectory) !== actualParent) fail("LOCAL_PILOT_DELETE_SCOPE_INVALID");
  const directoryInfo = await lstat(actualDirectory);
  if ((directoryInfo.mode & 0o777) !== 0o700
    || (typeof process.getuid === "function" && directoryInfo.uid !== process.getuid())) {
    fail("LOCAL_PILOT_DELETE_SCOPE_INVALID");
  }
  const markerPath = join(actualDirectory, MARKER_NAME);
  const markerInfo = await lstat(markerPath);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || (markerInfo.mode & 0o777) !== 0o600
    || (typeof process.getuid === "function" && markerInfo.uid !== process.getuid())) {
    fail("LOCAL_PILOT_OWNERSHIP_MARKER_INVALID");
  }
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  assertOwnershipMarker(marker, identity);
  return Object.freeze({ directory: actualDirectory, markerPath });
}

export async function removeOwnedDirectory({ directory, expectedParent, identity }) {
  const owned = await assertOwnedDirectory({ directory, expectedParent, identity });
  await rm(owned.directory, { recursive: true });
}
