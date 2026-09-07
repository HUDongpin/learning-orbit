#!/usr/bin/env node
/**
 * One-command local development bootstrap.
 *
 *   pnpm bootstrap
 *
 * Brings an empty checkout to the point where `https://localhost:3000/login`
 * renders against a real Fastify server and a real PostgreSQL 18 database.
 * Every step is idempotent: rerunning it never rotates a secret that already
 * exists, never overwrites .env, and never drops a database.
 *
 * This is a developer convenience, not the pilot gate. The reviewed evidence
 * gate remains `pnpm verify:local-pilot`, which owns its own disposable
 * worktree, run-scoped Compose project and run-scoped secrets.
 */
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { argv, env, exit, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const force = argv.includes("--force");
const resetDatabase = argv.includes("--reset-database");

/** Quote a value so both Docker Compose and `set -a; . ./.env` read it identically. */
const envValue = (value) => (/^[A-Za-z0-9_@%+=:,./-]*$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`);

const REQUIRED = Object.freeze({
  node: "v24.19.0",
  pnpm: "11.19.0",
  python: /^Python 3\.12(?:\.\d+)?$/,
});

const step = (message) => stdout.write(`\n→ ${message}\n`);
const done = (message) => stdout.write(`  ${message}\n`);

function abort(message, remedy) {
  stdout.write(`\n✗ ${message}\n`);
  if (remedy) stdout.write(`  ${remedy}\n`);
  exit(1);
}

async function run(executable, args, options = {}) {
  return execFileAsync(executable, args, {
    cwd: repository,
    shell: false,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const secret = () => randomBytes(32).toString("base64url");

// ---------------------------------------------------------------- toolchain

step("Checking the pinned toolchain");
const nodeVersion = process.version;
if (nodeVersion !== REQUIRED.node) {
  abort(
    `Node ${REQUIRED.node} is required; this process is ${nodeVersion}.`,
    "Install it from https://nodejs.org/dist/v24.19.0/ and put its bin directory first on PATH.",
  );
}
done(`node ${nodeVersion}`);

let pnpmVersion;
try {
  pnpmVersion = (await run("pnpm", ["--version"])).stdout.trim();
} catch {
  abort("pnpm is not on PATH.", `Install it with: npm install -g pnpm@${REQUIRED.pnpm}`);
}
if (pnpmVersion !== REQUIRED.pnpm) {
  abort(
    `pnpm ${REQUIRED.pnpm} is required; found ${pnpmVersion}.`,
    `Install it with: npm install -g pnpm@${REQUIRED.pnpm}`,
  );
}
done(`pnpm ${pnpmVersion}`);

try {
  const server = (await run("docker", ["info", "--format", "{{.ServerVersion}}"])).stdout.trim();
  done(`docker engine ${server}`);
} catch {
  abort(
    "The Docker daemon is not answering.",
    "Start Docker Desktop and wait for the whale to settle. If the CLI hangs rather than "
    + "erroring, quit Docker Desktop, kill any surviving com.docker.backend process, and reopen it.",
  );
}

// ------------------------------------------------------------------ secrets

step("Preparing owner-only local secrets");
const secretsDirectory = join(repository, "secrets", "local-dev");
await mkdir(secretsDirectory, { mode: 0o700, recursive: true });
await chmod(secretsDirectory, 0o700);

const trustFilePath = join(secretsDirectory, "service-assertion-trust.json");
const privateKeyPath = join(secretsDirectory, "worker-assertion-private.pem");
const issuer = "learning-orbit-local";
const keyId = "local-worker-key-1";

if (!(await exists(trustFilePath)) || !(await exists(privateKeyPath))) {
  const pair = generateKeyPairSync("ed25519");
  await writeFile(
    privateKeyPath,
    pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    { mode: 0o600 },
  );
  await writeFile(
    trustFilePath,
    `${JSON.stringify({
      version: 1,
      keys: [{
        issuer,
        keyId,
        publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }],
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  done("generated a fresh Ed25519 worker assertion pair");
} else {
  done("reusing the existing Ed25519 worker assertion pair");
}

const certificatePath = join(secretsDirectory, "dev-cert.pem");
const certificateKeyPath = join(secretsDirectory, "dev-key.pem");
if (force || !(await exists(certificatePath)) || !(await exists(certificateKeyPath))) {
  try {
    await run("/opt/homebrew/bin/openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "365",
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-addext", "basicConstraints=critical,CA:FALSE",
      "-addext", "keyUsage=critical,digitalSignature,keyEncipherment",
      "-addext", "extendedKeyUsage=serverAuth",
      "-keyout", certificateKeyPath,
      "-out", certificatePath,
    ]);
    await chmod(certificateKeyPath, 0o600);
    await chmod(certificatePath, 0o600);
    done("issued a localhost development certificate (365 days)");
  } catch {
    abort(
      "Could not issue a development certificate with /opt/homebrew/bin/openssl.",
      "Install it with: brew install openssl@3",
    );
  }
} else {
  done("reusing the existing localhost development certificate");
}

// ---------------------------------------------------------------------- env

step("Writing .env");
const envPath = join(repository, ".env");
if ((await exists(envPath)) && !force) {
  done(".env already exists and was left untouched (pass --force to reissue it)");
} else {
  const postgresPassword = secret();
  await writeFile(envPath, [
    "# Generated by scripts/bootstrap-local-dev.mjs. Local development only.",
    "# Every value here is disposable: delete this file and rerun `pnpm bootstrap`.",
    `LO_POSTGRES_PASSWORD=${postgresPassword}`,
    "",
    `DATABASE_URL=postgres://learning_orbit:${postgresPassword}@127.0.0.1:55432/learning_orbit`,
    `TEST_DATABASE_URL=postgres://learning_orbit:${postgresPassword}@127.0.0.1:55432/learning_orbit_test`,
    "",
    "LO_PUBLIC_BASE_ORIGIN=https://localhost:3000",
    "LO_ALLOWED_ORIGINS=https://localhost:3000,https://127.0.0.1:3000",
    "LO_TRUSTED_PROXY_CIDRS=",
    "",
    "# Private object store. The browser only ever sees a short-lived presigned",
    "# URL; these credentials stay on the server.",
    "LO_STORAGE_BROWSER_ORIGINS=http://127.0.0.1:59000",
    "LO_STORAGE_ENDPOINT=http://127.0.0.1:59000",
    "LO_STORAGE_BUCKET=learning-orbit-media",
    "LO_STORAGE_REGION=us-east-1",
    "LO_STORAGE_ACCESS_KEY_ID=learning-orbit-local",
    `LO_STORAGE_SECRET_ACCESS_KEY=${secret()}`,
    "",
    "LO_SMTP_HOST=127.0.0.1",
    "LO_SMTP_PORT=1025",
    "LO_SMTP_FROM=no-reply@learning-orbit.local",
    "",
    "LO_WORKER_ID=local-worker-1",
    `LO_SERVICE_ASSERTION_ISSUER=${issuer}`,
    `LO_SERVICE_ASSERTION_KEY_ID=${keyId}`,
    "LO_INTERNAL_BASE_ORIGIN=http://127.0.0.1:3001",
    `LO_SERVICE_ASSERTION_TRUST_FILE=${envValue(trustFilePath)}`,
    `LO_WORKER_ASSERTION_PRIVATE_KEY_FILE=${envValue(privateKeyPath)}`,
    "",
    `LO_ANALYTICS_PSEUDONYM_KEY=${secret()}`,
    `LO_AUDIT_SALT=${secret()}`,
    "ROOM_CODE_PEPPER_CURRENT_VERSION=1",
    `ROOM_CODE_PEPPER_V1=${secret()}`,
    "",
    `LO_DEV_TLS_CERT=${envValue(certificatePath)}`,
    `LO_DEV_TLS_KEY=${envValue(certificateKeyPath)}`,
    "",
  ].join("\n"), { mode: 0o600 });
  done("wrote .env with fresh disposable secrets");
}

const environment = { ...env };
for (const line of (await readFile(envPath, "utf8")).split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (!match) continue;
  const raw = match[2];
  environment[match[1]] = /^".*"$/.test(raw)
    ? raw.slice(1, -1).replace(/\\(["\\$`])/g, "$1")
    : raw;
}

// ------------------------------------------------------------- dependencies

step("Installing workspace dependencies");
await run("pnpm", ["install", "--frozen-lockfile"], { env: environment });
done("pnpm workspace is up to date");

step("Preparing the Python 3.12 worker environment");
const venvPython = join(repository, ".venv", "bin", "python");
if (!(await exists(venvPython))) {
  let interpreter;
  for (const candidate of [
    "python3.12",
    join(env.HOME ?? "", ".local/share/uv/python/cpython-3.12.13-macos-aarch64-none/bin/python3.12"),
    "/opt/homebrew/opt/python@3.12/bin/python3.12",
  ]) {
    try {
      const { stdout: version } = await run(candidate, ["--version"]);
      if (REQUIRED.python.test(version.trim())) {
        interpreter = candidate;
        break;
      }
    } catch { /* try the next candidate */ }
  }
  if (!interpreter) {
    abort(
      "No CPython 3.12 interpreter was found.",
      "Install one with: brew install python@3.12   (or: uv python install 3.12)",
    );
  }
  await run(interpreter, ["-m", "venv", ".venv"]);
  done("created .venv");
}
await run(venvPython, ["-m", "pip", "install", "--quiet", "--require-hashes",
  "-r", "services/worker/requirements.lock"]);
await run(venvPython, ["-m", "pip", "install", "--quiet", "--no-deps", "-e", "services/worker"]);
done(`${(await run(venvPython, ["--version"])).stdout.trim()} with the locked worker dependencies`);

// ---------------------------------------------------------------- database

step("Starting PostgreSQL 18 and Mailpit");
await run("docker", ["compose", "--env-file", ".env", "-f", "infra/docker-compose.yml", "up", "-d"],
  { env: environment });

const composePs = async () => JSON.parse(`[${(await run("docker", [
  "compose", "--env-file", ".env", "-f", "infra/docker-compose.yml", "ps", "--format", "json",
], { env: environment })).stdout.trim().split("\n").filter(Boolean).join(",")}]`);

let healthy = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  const services = await composePs();
  healthy = services.length > 0 && services.every(({ Health }) => Health === "healthy");
  if (healthy) break;
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 1_000); });
}
if (!healthy) abort("PostgreSQL or Mailpit did not become healthy within 60 seconds.");
done("postgres, mailpit and minio are healthy on 127.0.0.1:55432, :1025, :8025 and :59000");

/**
 * POSTGRES_PASSWORD only takes effect the first time the data volume is
 * initialised. A volume left over from an earlier bootstrap therefore keeps
 * its original password and rejects the one in the .env just written. Say so
 * plainly; discarding a developer's local database is their call, not ours.
 */
async function credentialsAccepted() {
  // Probe through the published port from the host. The postgres image trusts
  // in-container loopback, so `docker exec psql` would pass whatever the
  // password is and prove nothing.
  const probe = [
    "const { Client } = require('pg');",
    "const client = new Client({ connectionString: process.env.LO_PROBE_URL });",
    "client.connect().then(() => client.end()).catch(() => process.exit(1));",
  ].join("");
  try {
    await run("pnpm", ["--filter", "@learning-orbit/server", "exec", "node", "-e", probe], {
      env: {
        ...environment,
        LO_PROBE_URL:
          `postgres://learning_orbit:${encodeURIComponent(environment.LO_POSTGRES_PASSWORD)}`
          + "@127.0.0.1:55432/postgres",
      },
    });
    return true;
  } catch {
    return false;
  }
}

if (!(await credentialsAccepted())) {
  if (!resetDatabase) {
    abort(
      "The learning_orbit_postgres_data volume was initialised with a different password, "
      + "so the credentials in .env are refused.",
      "Rerun as `pnpm bootstrap --reset-database` to discard that local volume and start "
      + "clean. Everything in the local development database is lost when you do.",
    );
  }
  step("Discarding the stale database volume (--reset-database)");
  await run("docker", ["compose", "--env-file", ".env", "-f", "infra/docker-compose.yml",
    "down", "-v"], { env: environment });
  await run("docker", ["compose", "--env-file", ".env", "-f", "infra/docker-compose.yml",
    "up", "-d"], { env: environment });
  healthy = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const services = await composePs();
    healthy = services.length > 0 && services.every(({ Health }) => Health === "healthy");
    if (healthy) break;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 1_000); });
  }
  if (!healthy || !(await credentialsAccepted())) {
    abort("PostgreSQL did not come back with the new credentials after the reset.");
  }
  done("recreated an empty PostgreSQL 18 volume");
}

step("Creating the private media bucket");
await run("pnpm", ["storage:init"], { env: environment });
done(`${environment.LO_STORAGE_BUCKET} is private on ${environment.LO_STORAGE_ENDPOINT}`);

step("Applying migrations");
await run("pnpm", ["db:migrate"], { env: environment });
await run("pnpm", ["db:migrate:test"], { env: environment });
done("development and test databases are migrated");

// ------------------------------------------------------------------ teacher

step("Provisioning the local teacher account");
const teacherEmail = "teacher@learning-orbit.local";
const { stdout: provisioned } = await run(
  "pnpm",
  ["teacher:provision", "--", "--email", teacherEmail],
  { env: environment },
);
done(`${teacherEmail} (${provisioned.trim().split("\n").at(-1)})`);

stdout.write(`
Bootstrap complete. Two commands run the app:

  pnpm --filter @learning-orbit/server dev
  LO_LOCAL_SAME_ORIGIN_PROXY=1 pnpm --filter @learning-orbit/web exec next dev \\
    --hostname localhost --port 3000 \\
    --experimental-https --experimental-https-key secrets/local-dev/dev-key.pem \\
    --experimental-https-cert secrets/local-dev/dev-cert.pem

Then open https://localhost:3000/login and accept the self-signed certificate.
Teacher sign-in mail is delivered to Mailpit at http://localhost:8025.

Full walkthrough, including the traps that cost real time: docs/runbooks/local-dev.md
`);
