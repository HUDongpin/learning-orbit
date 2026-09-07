#!/usr/bin/env node
/**
 * Assemble the browser suite's environment and run it.
 *
 * `verify:local-pilot` does this inside a disposable checkout on fixed ports.
 * This is the smaller version for a working tree: same pieces, any ports, no
 * worktree. It exists because assembling them by hand produces four failures
 * that all look like product bugs and are not:
 *
 * - A reused API process fails as `PILOT_MAILPIT_MESSAGE_TIMEOUT`, because the
 *   magic-link endpoint is rate limited per process and a few runs exhaust it.
 *   The mail was never sent, not lost. So the API is always started fresh.
 * - Storage left configured on the API, or `LO_STORAGE_BROWSER_ORIGINS` left
 *   set for the web process, makes the fail-closed media assertion fail from
 *   one side or the other. Both are cleared.
 * - Without the Python worker there are no projections, and the analytics
 *   assertions resolve to zero elements.
 *
 * Everything it starts, it stops.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_PORT = Number(process.env.LO_E2E_WEB_PORT ?? "3400");
const API_PORT = Number(process.env.LO_E2E_API_PORT ?? "3401");
const BASE_URL = `https://127.0.0.1:${WEB_PORT}`;

/** Cleared for the API process: the journey asserts the no-provider surface. */
const STORAGE_KEYS = [
  "LO_STORAGE_ENDPOINT", "LO_STORAGE_BUCKET",
  "LO_STORAGE_ACCESS_KEY_ID", "LO_STORAGE_SECRET_ACCESS_KEY", "LO_STORAGE_REGION",
];

function withoutStorage(extra = {}) {
  const environment = { ...process.env, ...extra };
  for (const key of [...STORAGE_KEYS, "LO_STORAGE_BROWSER_ORIGINS", "NEXT_PUBLIC_LO_STORAGE_BROWSER_ORIGINS"]) {
    delete environment[key];
  }
  return environment;
}

const children = [];
function start(label, command, argv, options) {
  // `detached` matters for the web process. Next's dev server hands off to a
  // daemon and its wrapper exits; in the parent's process group that daemon
  // dies with the wrapper, and the suite then fails with a connection refused
  // that looks nothing like the cause. Its own group keeps it alive, and
  // teardown finds it by port rather than by handle.
  const child = spawn(command, argv, { cwd: repository, stdio: ["ignore", "pipe", "pipe"], ...options });
  const lines = [];
  // Guarded: a child with inherited stdio has no pipe to read, and attaching
  // to it throws — which used to tear the whole stack down mid-run and surface
  // as the suite failing to connect.
  child.stdout?.on("data", (chunk) => lines.push(String(chunk)));
  child.stderr?.on("data", (chunk) => lines.push(String(chunk)));
  children.push({ label, child, lines });
  return child;
}

async function writeProcessLog() {
  const logs = join(repository, "test-results", "e2e-processes.log");
  await mkdir(dirname(logs), { recursive: true });
  await writeFile(logs, children
    .filter(({ label }) => label !== "playwright")
    .map(({ label, lines }) => `=== ${label} ===\n${lines.join("")}`)
    .join("\n"), "utf8");
  return logs;
}

function killByPort(port) {
  return new Promise((done) => {
    const finder = spawn("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { stdio: ["ignore", "pipe", "ignore"] });
    let found = "";
    finder.stdout.on("data", (chunk) => { found += String(chunk); });
    finder.on("close", () => {
      for (const pid of found.split(/\s+/u).filter(Boolean)) {
        try { process.kill(Number(pid), "SIGTERM"); } catch { /* already gone */ }
      }
      done();
    });
  });
}

async function stopAll() {
  for (const { child } of children) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  // The web daemon outlives its wrapper on purpose, so it is stopped by the
  // port it holds. Anything this script started, this script stops.
  await Promise.all([killByPort(WEB_PORT), killByPort(API_PORT)]);
  await new Promise((done) => setTimeout(done, 1_500));
  for (const { child } of children) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  await Promise.all([killByPort(WEB_PORT), killByPort(API_PORT)]);
}

function probe(port, path, { secure }) {
  return new Promise((done) => {
    const options = { host: "127.0.0.1", port, path, method: "GET", timeout: 4_000, rejectUnauthorized: false };
    const send = secure
      ? (async () => (await import("node:https")).request)()
      : Promise.resolve(request);
    void send.then((make) => {
      const call = make(options, (response) => {
        response.resume();
        done(response.statusCode ?? 0);
      });
      call.on("timeout", () => { call.destroy(); done(0); });
      call.on("error", () => done(0));
      call.end();
    });
  });
}

async function waitFor(label, port, path, secure, accept, seconds = 180) {
  for (let attempt = 0; attempt < seconds; attempt += 2) {
    const status = await probe(port, path, { secure });
    if (accept.includes(status)) return;
    await new Promise((done) => setTimeout(done, 2_000));
  }
  throw new Error(`E2E_${label}_NOT_READY`);
}

/** Fetch each route once so dev-mode compilation happens before the clock starts. */
async function warmRoutes() {
  const room = "00000000-0000-4000-8000-000000000001";
  for (const path of [
    "/login", "/login?role=teacher", "/teacher",
    `/session/${room}`, `/session/${room}/teacher`, `/rooms/${room}`,
  ]) {
    // Any answer means the route compiled; the status itself is not the point.
    await probe(WEB_PORT, path, { secure: true });
  }
}

async function tlsMaterial() {
  const directory = join(repository, "test-results", "e2e-tls");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = join(directory, "key.pem");
  const certificate = join(directory, "cert.pem");
  const openssl = spawn("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", certificate, "-days", "2",
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  const code = await new Promise((done) => openssl.on("close", done));
  if (code !== 0) throw new Error("E2E_TLS_MATERIAL_FAILED");
  return { key, certificate };
}

/**
 * Empty the business tables before the run.
 *
 * The harness gets a disposable database; a working tree does not, and a
 * previous run's open rooms, queued auto-close jobs and sessions are exactly
 * the kind of leftover state that makes a journey fail in a way that looks
 * like a product bug. `--keep-data` skips it for anyone inspecting what a
 * failed run left behind.
 */
async function resetDatabase() {
  if (process.argv.includes("--keep-data")) return;
  const { resetBusinessTables } = await import(
    new URL("../apps/server/test/db/reset.ts", import.meta.url).href
  );
  await resetBusinessTables(process.env.TEST_DATABASE_URL);
}

async function main() {
  if (!process.env.TEST_DATABASE_URL) throw new Error("E2E_TEST_DATABASE_URL_REQUIRED");
  await resetDatabase();
  const tls = await tlsMaterial();
  const teacher = `pilot-${randomBytes(8).toString("hex")}@example.invalid`;

  // The API is always a new process: the magic-link rate limit lives in it,
  // and a reused one makes the suite look like it lost its mail.
  start("api", "pnpm", ["--filter", "@learning-orbit/server", "exec", "tsx", "src/main.ts"], {
    env: withoutStorage({
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      PORT: String(API_PORT),
      LO_PUBLIC_BASE_ORIGIN: BASE_URL,
      LO_ALLOWED_ORIGINS: BASE_URL,
    }),
  });
  await waitFor("API", API_PORT, "/v1/auth/session", false, [401]);

  start("web", "pnpm", [
    "--filter", "@learning-orbit/web", "exec", "next", "dev",
    "--hostname", "127.0.0.1", "--port", String(WEB_PORT),
    "--experimental-https",
    "--experimental-https-key", tls.key,
    "--experimental-https-cert", tls.certificate,
  ], {
    env: withoutStorage({ LO_LOCAL_SAME_ORIGIN_PROXY: "1", LO_LOCAL_API_PORT: String(API_PORT) }),
  });
  await waitFor("WEB", WEB_PORT, "/login", true, [200]);

  // Projections only exist once the worker has consumed the events, and the
  // analytics assertions read them.
  start("worker", process.env.LO_E2E_PYTHON ?? join(repository, ".venv/bin/python"),
    ["-m", "learning_orbit_worker.main"], {
      cwd: join(repository, "services", "worker"),
      env: withoutStorage({
        PYTHONPATH: "src",
        LO_INTERNAL_BASE_ORIGIN: `http://127.0.0.1:${API_PORT}`,
      }),
    });

  // Compile every route the suite touches before anything is timed.
  //
  // In dev mode Next compiles a route on its first request. The journey's
  // assertions wait thirty seconds, which is generous for a warm route and
  // marginal for a cold one on a loaded machine — and a first visit that lands
  // inside a timed step reads as the application failing rather than as the
  // compiler working. The harness does not need this because it runs in a
  // checkout of its own; a working tree does.
  await warmRoutes();
  await waitFor("WEB", WEB_PORT, "/login", true, [200], 30);
  const playwright = start("playwright", "pnpm", [
    "exec", "playwright", "test", "--config", "apps/web/playwright.config.ts",
    ...process.argv.slice(2),
  ], {
    env: {
      ...process.env,
      LO_E2E_BASE_URL: BASE_URL,
      LO_PILOT_TEACHER_ADDRESS: teacher,
      DATABASE_URL: process.env.TEST_DATABASE_URL,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const code = await new Promise((done) => playwright.on("close", done));
  return code ?? 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "E2E_FAILED"}\n`);
} finally {
  // Written whether or not the suite ran: when a process fails to come up, its
  // own output is the only thing that says why.
  try { process.stdout.write(`\nprocess output: ${await writeProcessLog()}\n`); }
  catch { /* nothing useful to add if even this fails */ }
  await stopAll();
}
process.exit(exitCode);
