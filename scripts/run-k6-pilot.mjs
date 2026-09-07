#!/usr/bin/env node
/**
 * Run the k6 read-surface profile from the digest-pinned image.
 *
 * Everything that could turn a load test into a way of reaching something it
 * should not is refused before Docker starts: a mutable tag, a host mount
 * beyond the profile and the output directory, and any environment name
 * outside a short allowlist. A load harness runs with the operator's Docker
 * socket; it is a good place to be strict.
 *
 *   pnpm load:k6 --origin https://localhost:3000
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Only these reach the container, and only with values this file validates. */
const ENV_ALLOWLIST = Object.freeze(["LO_LOAD_ORIGIN"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PROFILE = "k6-read-surface.js";

function fail(code) { throw new Error(code); }

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && typeof process.argv[index + 1] === "string") return process.argv[index + 1];
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/**
 * Resolve the image from the lock, by digest.
 *
 * A tag is a name for whatever was pushed last. Refusing an entry without a
 * digest is the difference between "we reviewed this image" and "we reviewed
 * an image that had this name once".
 */
export function lockedImage(lock, key = "k6") {
  const entry = lock?.images?.[key];
  if (!entry || typeof entry.reference !== "string" || !DIGEST.test(entry.digest ?? "")) {
    fail("K6_IMAGE_NOT_PINNED");
  }
  return `${entry.reference}@${entry.digest}`;
}

/** The origin the profile will hit; loopback or https only, never a bare host. */
export function loadOrigin(value) {
  let parsed;
  try { parsed = new URL(value ?? ""); } catch { fail("K6_ORIGIN_INVALID"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.origin !== value || parsed.username || parsed.password
    || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))) {
    fail("K6_ORIGIN_INVALID");
  }
  return parsed.origin;
}

/**
 * Build the container environment.
 *
 * The host environment is not forwarded. A load run has no business carrying
 * the operator's database URL, storage keys or assertion material into a
 * third-party image, and an allowlist is the only form of that rule that stays
 * true when someone later adds a variable.
 */
export function containerOrigin(origin) {
  // The operator names a loopback origin because that is what the server is
  // actually bound to; inside the container that address is the container.
  const parsed = new URL(origin);
  if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    parsed.hostname = "host.docker.internal";
  }
  return parsed.origin;
}

export function containerEnvironment(origin, allowlist = ENV_ALLOWLIST) {
  const values = { LO_LOAD_ORIGIN: origin };
  const argv = [];
  for (const name of allowlist) {
    if (!(name in values)) fail(`K6_ENV_UNSET:${name}`);
    argv.push("--env", `${name}=${values[name]}`);
  }
  return argv;
}

export function dockerArgv({ image, origin, profileDir, outputDir, network }) {
  return [
    "run", "--rm",
    "--network", network,
    // Read-only profile mount, writable output only. k6 needs neither the
    // repository nor a shell.
    "--volume", `${profileDir}:/profile:ro`,
    "--volume", `${outputDir}:/out`,
    "--add-host", "host.docker.internal:host-gateway",
    ...containerEnvironment(containerOrigin(origin)),
    "--user", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    image,
    "run", "--summary-export", "/out/k6.json", `/profile/${PROFILE}`,
  ];
}

async function main() {
  const origin = loadOrigin(option("origin") ?? process.env.LO_LOAD_ORIGIN);
  const network = option("network") ?? "host";
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(network)) fail("K6_NETWORK_INVALID");

  const lock = JSON.parse(await readFile(join(repository, "infra/images.lock.json"), "utf8"));
  const image = lockedImage(lock);

  const outputDir = join(repository, "test-results", "load");
  await mkdir(outputDir, { recursive: true, mode: 0o700 });

  const argv = dockerArgv({
    image, origin, network,
    profileDir: join(repository, "tests", "load"),
    outputDir,
  });
  process.stdout.write(`load:k6 ${image} -> ${origin}\n`);

  const code = await new Promise((resolveExit) => {
    const child = spawn("docker", argv, { stdio: ["ignore", "inherit", "inherit"], shell: false });
    child.on("error", () => resolveExit(-1));
    child.on("close", (value) => resolveExit(value ?? -1));
  });
  if (code !== 0) fail(`K6_RUN_FAILED:${code}`);

  // k6 exits non-zero when a threshold breaches, so reaching here means the
  // budget held. The summary is still re-read so the file is proven present
  // and parseable before anything downstream trusts it.
  const summaryPath = join(outputDir, "k6.json");
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  if (!summary?.metrics?.http_req_duration) fail("K6_SUMMARY_INVALID");
  await writeFile(join(outputDir, "k6.image"), `${image}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(summaryPath, 0o600);
  // Sub-millisecond percentiles are normal on a loopback run; rounding them
  // to whole milliseconds would print a reassuring 0ms for any latency at all.
  const p95 = Number(summary.metrics.http_req_duration["p(95)"] ?? 0);
  process.stdout.write(`load:k6: PASS p(95)=${p95.toFixed(p95 < 10 ? 3 : 0)}ms over ${summary.metrics.http_reqs?.count ?? 0} requests\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    process.stderr.write(`${message.startsWith("K6_") ? message : "K6_PILOT_FAILED"}\n`);
    process.exitCode = 1;
  }
}
