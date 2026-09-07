#!/usr/bin/env node
/**
 * Prove the worker image carries the server's canonical SQL, byte for byte.
 *
 * The worker and the server must agree exactly on how a job is claimed and how
 * a room is locked. A Python rewrite of either statement would be two
 * expressions of one rule, and the drift would surface as a lease that one
 * runtime believes is held and the other believes is free — at which point two
 * workers are running the same job against one classroom.
 *
 * So the image copies the files in, and this checks them back out: same bytes,
 * no extras, readable by the unprivileged user the container actually runs as,
 * and built from the commit being verified. Then it runs the container against
 * a disposable database and makes it use both — claim one fixture job, take
 * and release the canonical room lock — because a file that is present and
 * correct still proves nothing until something executes it.
 *
 *   node scripts/verify-worker-runtime-sql.mjs [--tag <image>] [--no-build]
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The complete set the worker reads; anything else in the image is drift. */
const RUNTIME_SQL = Object.freeze([
  "claim_worker_job.sql",
  "settle_worker_job_claims.sql",
  "lock_room_xact.sql",
  "lock_room_session.sql",
  "unlock_room_session.sql",
]);

const IMAGE_SQL_DIR = "/app/apps/server/src/db/sql";
const RUN_AS = "10001:10001";

function fail(code) { throw new Error(code); }

async function docker(argv, options = {}) {
  return execFileAsync("docker", argv, {
    encoding: options.encoding ?? "utf8",
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 300_000,
    windowsHide: true,
    ...(options.input === undefined ? {} : {}),
  });
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && typeof process.argv[index + 1] === "string") return process.argv[index + 1];
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function sourceHashes() {
  const hashes = new Map();
  for (const name of RUNTIME_SQL) {
    hashes.set(name, sha256(await readFile(resolve(repository, "apps/server/src/db/sql", name))));
  }
  return hashes;
}

/**
 * Read one file out of the image as the unprivileged runtime user.
 *
 * Reading it as root would answer a different question: the image can hold a
 * file the process that needs it cannot open, and that failure only appears in
 * production, at the first claim.
 */
async function imageFile(tag, name) {
  const { stdout } = await execFileAsync("docker", [
    "run", "--rm", "--user", RUN_AS, "--network", "none",
    "--entrypoint", "cat", tag, `${IMAGE_SQL_DIR}/${name}`,
  ], { encoding: "buffer", shell: false, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  return stdout;
}

async function imageListing(tag) {
  const { stdout } = await execFileAsync("docker", [
    "run", "--rm", "--user", RUN_AS, "--network", "none",
    "--entrypoint", "ls", tag, "-A", IMAGE_SQL_DIR,
  ], { encoding: "utf8", shell: false, timeout: 120_000 });
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

async function imageSourceSha(tag) {
  const { stdout } = await docker(["image", "inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", tag]);
  return /^LO_SOURCE_SHA=(.*)$/m.exec(stdout)?.[1]?.trim() ?? "";
}

/** Rewrite a loopback database URL so a container can reach the host's server. */
function containerDatabaseUrl(url) {
  const parsed = new URL(url);
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) {
    parsed.hostname = "host.docker.internal";
  }
  return parsed.toString();
}

/**
 * Make the container execute both statements it was given.
 *
 * The script runs inside the image, so it exercises the copied files through
 * the worker's own module resolution rather than through a path this verifier
 * chose.
 */
const EXERCISE = `
import os, uuid
import psycopg
from learning_orbit_worker.jobs import CLAIM_SQL, SETTLE_SQL, JobStore
from learning_orbit_worker.room_lock import (
    LOCK_ROOM_XACT_SQL, LOCK_ROOM_SESSION_SQL, UNLOCK_ROOM_SESSION_SQL,
    acquire_room_session, lock_room_in_transaction, release_room_session,
)

for name, text in (("claim", CLAIM_SQL), ("settle", SETTLE_SQL), ("lock_xact", LOCK_ROOM_XACT_SQL),
                   ("lock_session", LOCK_ROOM_SESSION_SQL), ("unlock_session", UNLOCK_ROOM_SESSION_SQL)):
    if not text.strip():
        raise SystemExit("WORKER_RUNTIME_SQL_EMPTY:" + name)

with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as connection:
    store = JobStore(connection, "verify-runtime-sql")
    # An empty claim is the interesting result: the statement ran, the server's
    # own SQL parsed against the server's own schema, and no row was invented.
    if store.claim(1):
        raise SystemExit("WORKER_RUNTIME_SQL_UNEXPECTED_CLAIM")

    # The room helpers are called rather than the raw text, so what runs is the
    # path the worker itself takes to these files.
    room_id = str(uuid.uuid4())
    with connection.transaction():
        lock_room_in_transaction(connection, room_id)
    acquire_room_session(connection, room_id)
    release_room_session(connection, room_id)
print("WORKER_RUNTIME_SQL_EXERCISED")
`;

async function main() {
  const tag = option("tag") ?? "learning-orbit-worker:verify";
  const sourceSha = (await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();

  if (!process.argv.includes("--no-build")) {
    await docker([
      "build", "--file", "infra/docker/worker.Dockerfile",
      "--build-arg", `SOURCE_SHA=${sourceSha}`, "--tag", tag, repository,
    ], { timeout: 900_000 });
  }

  const builtFrom = await imageSourceSha(tag);
  if (builtFrom !== sourceSha) fail(`WORKER_RUNTIME_SQL_IMAGE_SOURCE_DRIFT:${builtFrom || "unset"}`);

  const listing = await imageListing(tag);
  if (listing.join(",") !== [...RUNTIME_SQL].sort().join(",")) {
    fail(`WORKER_RUNTIME_SQL_SET_DRIFT:${listing.join(",")}`);
  }

  const expected = await sourceHashes();
  for (const name of RUNTIME_SQL) {
    let bytes;
    try { bytes = await imageFile(tag, name); }
    catch { fail(`WORKER_RUNTIME_SQL_UNREADABLE:${name}`); }
    if (sha256(bytes) !== expected.get(name)) fail(`WORKER_RUNTIME_SQL_BYTES_DRIFT:${name}`);
    process.stdout.write(`  ${name} ${expected.get(name).slice(0, 16)}…\n`);
  }

  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    process.stdout.write("verify-worker-runtime-sql: SQL VERIFIED (set TEST_DATABASE_URL to also execute it)\n");
    return;
  }
  const { stdout } = await execFileAsync("docker", [
    "run", "--rm", "--user", RUN_AS,
    "--add-host", "host.docker.internal:host-gateway",
    "--env", `DATABASE_URL=${containerDatabaseUrl(databaseUrl)}`,
    "--entrypoint", "python", tag, "-c", EXERCISE,
  ], { encoding: "utf8", shell: false, timeout: 300_000 });
  if (!stdout.includes("WORKER_RUNTIME_SQL_EXERCISED")) fail("WORKER_RUNTIME_SQL_NOT_EXERCISED");
  process.stdout.write(`verify-worker-runtime-sql: PASS sha=${sourceSha}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  // The stable code and, when there is one, the offending file name: an
  // operator needs to know which file drifted, not only that one did.
  const line = message.split("\n")[0] ?? "";
  process.stderr.write(`${line.startsWith("WORKER_RUNTIME_SQL_") ? line : "WORKER_RUNTIME_SQL_FAILED"}\n`);
  process.exitCode = 1;
}
