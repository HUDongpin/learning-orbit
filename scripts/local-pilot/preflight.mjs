import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, statfs as nodeStatfs } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

export const MINIMUM_FREE_BYTES = 25 * 1024 ** 3;
export const REQUIRED_PORTS = Object.freeze([3000, 3001, 55432, 8025, 1025]);
export const POSTGRES_IMAGE = "postgres:18@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280";
export const MAILPIT_IMAGE = "axllent/mailpit:v1.31.0@sha256:c96991d9bef73594c246d89ca81411d4e916f03e76a7d2d72fa2ab5dd3c9ce24";
export const PLAYWRIGHT_TEST_VERSION = "1.62.1";
export const PLAYWRIGHT_CHROMIUM_REVISION = "1234";
export const PLAYWRIGHT_CHROMIUM_VERSION = "151.0.7922.34";
export const RUNTIME_EXECUTABLE_NAMES = Object.freeze(["node", "pnpm", "pnpmCli", "python"]);
export const APPROVED_RUNTIME_MANIFEST_URL = new URL(
  "../../infra/local-pilot/approved-runtimes.v1.json",
  import.meta.url,
);

const CHROMIUM_EXECUTABLE_RELATIVE = [
  "chrome-mac-arm64",
  "Google Chrome for Testing.app",
  "Contents",
  "MacOS",
  "Google Chrome for Testing",
].join("/");

const fail = (code) => {
  throw new Error(code);
};

export function assertRuntimeFingerprints({ node, pnpm, python }) {
  if (node.trim() !== "v24.19.0") fail("LOCAL_PILOT_NODE_VERSION_MISMATCH");
  if (pnpm.trim() !== "11.19.0") fail("LOCAL_PILOT_PNPM_VERSION_MISMATCH");
  if (!/^Python 3\.12(?:\.[0-9]+)?$/.test(python.trim())) {
    fail("LOCAL_PILOT_PYTHON_VERSION_MISMATCH");
  }
  return Object.freeze({ node: node.trim(), pnpm: pnpm.trim(), python: python.trim() });
}

async function fileFingerprint(path, { executable, allowRequestedSymlink }) {
  if (!isAbsolute(path)) fail("LOCAL_PILOT_RUNTIME_EXECUTABLE_INVALID");
  let requested;
  let canonical;
  let info;
  try {
    requested = await lstat(path);
    canonical = await realpath(path);
    info = await lstat(canonical);
  } catch {
    fail("LOCAL_PILOT_RUNTIME_EXECUTABLE_INVALID");
  }
  if ((!requested.isFile() && !(allowRequestedSymlink && requested.isSymbolicLink()))
    || !info.isFile() || info.isSymbolicLink()
    || (executable && (info.mode & 0o111) === 0)) {
    fail("LOCAL_PILOT_RUNTIME_EXECUTABLE_INVALID");
  }
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(canonical)) hash.update(chunk);
  } catch {
    fail("LOCAL_PILOT_RUNTIME_EXECUTABLE_INVALID");
  }
  return Object.freeze({ canonical, sha256: hash.digest("hex") });
}

const PNPM_CLI_BASENAMES = Object.freeze(["pnpm.mjs", "pnpm.cjs"]);

function isPnpmPackageCli(path) {
  const segments = path.split("/");
  const basename = segments.at(-1);
  return PNPM_CLI_BASENAMES.includes(basename ?? "")
    && segments.at(-2) === "bin"
    && segments.at(-3) === "pnpm"
    && segments.at(-4) === "node_modules";
}

/**
 * Resolve the pnpm CLI payload the wrapper actually executes.
 *
 * Two installation shapes are approved. A bundled runtime keeps the wrapper
 * beside a private Node tree (`<root>/bin/**\/pnpm` next to `<root>/node`);
 * that shape additionally proves the wrapper runs the pinned Node. A package
 * install canonicalises the wrapper straight onto the CLI module inside
 * `node_modules/pnpm/bin`. Anything else is refused rather than guessed at.
 */
async function resolvePnpmCliPath(pnpmCanonical, nodeCanonical) {
  const bundledRoot = resolve(dirname(pnpmCanonical), "../..");
  const bundledNode = resolve(bundledRoot, "node/bin/node");
  let canonicalBundledNode;
  try {
    canonicalBundledNode = await realpath(bundledNode);
  } catch {
    canonicalBundledNode = undefined;
  }
  if (canonicalBundledNode !== undefined) {
    if (canonicalBundledNode !== nodeCanonical) fail("LOCAL_PILOT_PNPM_EXECUTION_CLOSURE_INVALID");
    return Object.freeze({
      path: resolve(bundledRoot, "node/node_modules/pnpm/bin/pnpm.mjs"),
      layout: "bundled-runtime",
    });
  }
  if (isPnpmPackageCli(pnpmCanonical)) {
    return Object.freeze({ path: pnpmCanonical, layout: "package-install" });
  }
  fail("LOCAL_PILOT_PNPM_EXECUTION_CLOSURE_INVALID");
}

export async function probeRuntimeExecutableFingerprints({ nodePath, pnpmPath, pythonPath }) {
  const [node, pnpm, python] = await Promise.all([
    fileFingerprint(nodePath, { executable: true, allowRequestedSymlink: true }),
    fileFingerprint(pnpmPath, { executable: true, allowRequestedSymlink: true }),
    fileFingerprint(pythonPath, { executable: true, allowRequestedSymlink: true }),
  ]);
  const cli = await resolvePnpmCliPath(pnpm.canonical, node.canonical);
  const pnpmCli = cli.path === pnpm.canonical
    ? pnpm
    : await fileFingerprint(cli.path, { executable: false, allowRequestedSymlink: false });
  if (pnpmCli.canonical !== cli.path) fail("LOCAL_PILOT_PNPM_EXECUTION_CLOSURE_INVALID");
  return Object.freeze({
    node: node.sha256,
    pnpm: pnpm.sha256,
    pnpmCli: pnpmCli.sha256,
    python: python.sha256,
  });
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Parse the reviewed set of toolchains a local-pilot run may execute under.
 *
 * The gate refuses byte patterns it has not been shown, but which reviewed
 * machine produced those bytes is a manifest entry rather than a constant
 * welded into this file, so a second approved workstation is a reviewed data
 * change instead of a gate edit.
 */
export function parseApprovedRuntimeManifest(source) {
  if (typeof source !== "string" || source.includes("\u0000")) {
    fail("LOCAL_PILOT_APPROVED_RUNTIME_MANIFEST_INVALID");
  }
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    fail("LOCAL_PILOT_APPROVED_RUNTIME_MANIFEST_INVALID");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)
    || manifest.schemaVersion !== 1 || !Array.isArray(manifest.toolchains)
    || manifest.toolchains.length === 0) {
    fail("LOCAL_PILOT_APPROVED_RUNTIME_MANIFEST_INVALID");
  }
  const seen = new Set();
  const toolchains = manifest.toolchains.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id)
      || seen.has(entry.id)
      || entry.executables === null || typeof entry.executables !== "object"
      || Array.isArray(entry.executables)
      || Object.keys(entry.executables).length !== RUNTIME_EXECUTABLE_NAMES.length
      || RUNTIME_EXECUTABLE_NAMES.some((name) => !isSha256(entry.executables[name]))) {
      fail("LOCAL_PILOT_APPROVED_RUNTIME_MANIFEST_INVALID");
    }
    seen.add(entry.id);
    return Object.freeze({
      id: entry.id,
      executables: Object.freeze({ ...entry.executables }),
    });
  });
  return Object.freeze(toolchains);
}

export async function loadApprovedRuntimeToolchains(manifestUrl = APPROVED_RUNTIME_MANIFEST_URL) {
  let source;
  try {
    source = await readFile(manifestUrl, "utf8");
  } catch {
    fail("LOCAL_PILOT_APPROVED_RUNTIME_MANIFEST_INVALID");
  }
  return parseApprovedRuntimeManifest(source);
}

function mismatchedRuntimeNames(fingerprints, toolchain) {
  return RUNTIME_EXECUTABLE_NAMES.filter(
    (name) => fingerprints[name] !== toolchain.executables[name],
  );
}

export function assertRuntimeExecutableFingerprints(fingerprints, toolchains) {
  if (!fingerprints || typeof fingerprints !== "object" || Array.isArray(fingerprints)
    || RUNTIME_EXECUTABLE_NAMES.some((name) => !isSha256(fingerprints[name]))) {
    fail("LOCAL_PILOT_RUNTIME_EXECUTABLE_INVALID");
  }
  if (!Array.isArray(toolchains) || toolchains.length === 0) {
    fail("LOCAL_PILOT_APPROVED_RUNTIME_MANIFEST_INVALID");
  }
  let closest;
  for (const toolchain of toolchains) {
    const mismatched = mismatchedRuntimeNames(fingerprints, toolchain);
    if (mismatched.length === 0) {
      return Object.freeze({
        approvedRuntimeId: toolchain.id,
        nodeBinarySha256: fingerprints.node,
        pnpmBinarySha256: fingerprints.pnpm,
        pnpmCliSha256: fingerprints.pnpmCli,
        pythonBinarySha256: fingerprints.python,
      });
    }
    if (closest === undefined || mismatched.length < closest.length) closest = mismatched;
  }
  const name = closest[0];
  const label = name === "pnpmCli" ? "PNPM_CLI" : name.toUpperCase();
  fail(`LOCAL_PILOT_${label}_EXECUTABLE_MISMATCH`);
}

function assertManagedChromiumInstall(fingerprint, homeDirectory) {
  if (!fingerprint || typeof fingerprint !== "object" || Array.isArray(fingerprint)) {
    fail("LOCAL_PILOT_CHROMIUM_FINGERPRINT_INVALID");
  }
  if (fingerprint.playwrightVersion !== PLAYWRIGHT_TEST_VERSION) {
    fail("LOCAL_PILOT_PLAYWRIGHT_VERSION_MISMATCH");
  }
  if (fingerprint.chromiumRevision !== PLAYWRIGHT_CHROMIUM_REVISION) {
    fail("LOCAL_PILOT_CHROMIUM_REVISION_MISMATCH");
  }
  if (fingerprint.declaredChromiumVersion !== PLAYWRIGHT_CHROMIUM_VERSION) {
    fail("LOCAL_PILOT_CHROMIUM_VERSION_MISMATCH");
  }
  if (typeof homeDirectory !== "string" || !isAbsolute(homeDirectory)
    || typeof fingerprint.executablePath !== "string"
    || typeof fingerprint.realExecutablePath !== "string"
    || !isAbsolute(fingerprint.executablePath)
    || fingerprint.executablePath !== fingerprint.realExecutablePath) {
    fail("LOCAL_PILOT_CHROMIUM_EXECUTABLE_INVALID");
  }
  const managedRevisionRoot = resolve(
    homeDirectory,
    "Library",
    "Caches",
    "ms-playwright",
    `chromium-${PLAYWRIGHT_CHROMIUM_REVISION}`,
  );
  const relativeExecutable = relative(managedRevisionRoot, fingerprint.executablePath);
  if (relativeExecutable !== CHROMIUM_EXECUTABLE_RELATIVE
    || relativeExecutable.startsWith("..") || isAbsolute(relativeExecutable)) {
    fail("LOCAL_PILOT_CHROMIUM_EXECUTABLE_UNMANAGED");
  }
  if (fingerprint.executableIsFile !== true
    || !Number.isSafeInteger(fingerprint.executableMode)
    || (fingerprint.executableMode & 0o111) === 0) {
    fail("LOCAL_PILOT_CHROMIUM_EXECUTABLE_INVALID");
  }
}

export function assertPlaywrightChromiumFingerprint(fingerprint, homeDirectory) {
  assertManagedChromiumInstall(fingerprint, homeDirectory);
  if (fingerprint.launchedChromiumVersion !== PLAYWRIGHT_CHROMIUM_VERSION) {
    fail("LOCAL_PILOT_CHROMIUM_VERSION_MISMATCH");
  }
  if (fingerprint.closed !== true) fail("LOCAL_PILOT_CHROMIUM_CLOSE_FAILED");
  return Object.freeze({
    playwright: PLAYWRIGHT_TEST_VERSION,
    chromiumRevision: PLAYWRIGHT_CHROMIUM_REVISION,
    chromiumVersion: PLAYWRIGHT_CHROMIUM_VERSION,
    chromiumExecutable: "managed",
    chromiumHeadlessLaunch: "passed",
  });
}

export async function probeManagedPlaywrightChromium({ homeDirectory = process.env.HOME } = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64"
    || typeof homeDirectory !== "string" || !isAbsolute(homeDirectory)) {
    fail("LOCAL_PILOT_CHROMIUM_PLATFORM_MISMATCH");
  }
  let playwrightVersion;
  let chromiumRevision;
  let declaredChromiumVersion;
  let chromium;
  try {
    const testPackagePath = requireFromHere.resolve("@playwright/test/package.json");
    const testRequire = createRequire(testPackagePath);
    const corePackagePath = testRequire.resolve("playwright-core/package.json");
    const [testPackage, browserRegistry] = await Promise.all([
      readFile(testPackagePath, "utf8").then(JSON.parse),
      readFile(resolve(dirname(corePackagePath), "browsers.json"), "utf8").then(JSON.parse),
    ]);
    const chromiumDescriptor = browserRegistry?.browsers?.find(
      ({ name }) => name === "chromium",
    );
    playwrightVersion = testPackage?.version;
    chromiumRevision = chromiumDescriptor?.revision;
    declaredChromiumVersion = chromiumDescriptor?.browserVersion;
    chromium = requireFromHere("@playwright/test").chromium;
  } catch {
    fail("LOCAL_PILOT_PLAYWRIGHT_PACKAGE_UNAVAILABLE");
  }

  let executablePath;
  let executableInfo;
  let realExecutablePath;
  try {
    executablePath = chromium.executablePath();
    [executableInfo, realExecutablePath] = await Promise.all([
      lstat(executablePath),
      realpath(executablePath),
    ]);
  } catch {
    fail("LOCAL_PILOT_CHROMIUM_EXECUTABLE_INVALID");
  }
  const installFingerprint = {
    playwrightVersion,
    chromiumRevision,
    declaredChromiumVersion,
    executablePath,
    realExecutablePath,
    executableIsFile: executableInfo.isFile() && !executableInfo.isSymbolicLink(),
    executableMode: executableInfo.mode,
  };
  assertManagedChromiumInstall(installFingerprint, homeDirectory);

  let browser;
  let launchedChromiumVersion;
  try {
    browser = await chromium.launch({ headless: true, executablePath });
    launchedChromiumVersion = browser.version();
  } catch {
    if (browser) {
      try { await browser.close(); } catch { /* stable launch failure below */ }
    }
    fail("LOCAL_PILOT_CHROMIUM_LAUNCH_FAILED");
  }
  try {
    await browser.close();
  } catch {
    fail("LOCAL_PILOT_CHROMIUM_CLOSE_FAILED");
  }
  return Object.freeze({
    ...installFingerprint,
    launchedChromiumVersion,
    closed: true,
  });
}

export function assertPythonLockMinor(source) {
  if (typeof source !== "string" || source.includes("\u0000")) {
    fail("LOCAL_PILOT_PYTHON_LOCK_INVALID");
  }
  const versions = [...source.matchAll(/with Python ([0-9]+)\.([0-9]+)/g)];
  if (versions.length !== 1 || versions[0][1] !== "3" || versions[0][2] !== "12") {
    fail("LOCAL_PILOT_PYTHON_LOCK_MINOR_MISMATCH");
  }
  return Object.freeze({ major: 3, minor: 12 });
}

function imageLines(source, repository) {
  return source.split(/\r?\n/)
    .map((line) => /^\s*image:\s*([^\s#]+)\s*(?:#.*)?$/.exec(line)?.[1])
    .filter((image) => typeof image === "string" && image.startsWith(`${repository}:`));
}

export function assertInfrastructurePins(source) {
  if (typeof source !== "string" || source.includes("\u0000")) {
    fail("LOCAL_PILOT_INFRASTRUCTURE_INVALID");
  }
  const postgres = imageLines(source, "postgres");
  if (postgres.length !== 1 || postgres[0] !== POSTGRES_IMAGE) {
    fail("LOCAL_PILOT_POSTGRES_IMAGE_MISMATCH");
  }
  const mailpit = imageLines(source, "axllent/mailpit");
  if (mailpit.length !== 1 || mailpit[0] !== MAILPIT_IMAGE) {
    fail("LOCAL_PILOT_MAILPIT_IMAGE_MISMATCH");
  }
  return Object.freeze({ postgres: POSTGRES_IMAGE, mailpit: MAILPIT_IMAGE });
}

export function assertPostgres18(output) {
  if (typeof output !== "string" || !/^[1-9][0-9]{4,5}\n?$/.test(output)) {
    fail("LOCAL_PILOT_POSTGRES_VERSION_INVALID");
  }
  const versionNumber = Number(output.trim());
  if (!Number.isSafeInteger(versionNumber)) fail("LOCAL_PILOT_POSTGRES_VERSION_INVALID");
  const major = Math.floor(versionNumber / 10_000);
  if (major !== 18) fail("LOCAL_PILOT_POSTGRES_VERSION_MISMATCH");
  return Object.freeze({ major, versionNumber });
}

export function assertMinimumFreeBytes(availableBytes) {
  if (!Number.isSafeInteger(availableBytes) || availableBytes < MINIMUM_FREE_BYTES) {
    fail("LOCAL_PILOT_DISK_SPACE_INSUFFICIENT");
  }
  return availableBytes;
}

export function assertGitSnapshot({ sha, branch, status }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) fail("LOCAL_PILOT_GIT_SHA_INVALID");
  if (status !== "") fail("LOCAL_PILOT_WORKTREE_DIRTY");
  if (branch === "HEAD") return Object.freeze({ sha, checkout: "detached" });
  if (typeof branch !== "string" || branch.length === 0 || branch.length > 255
    || /[\u0000-\u0020~^:?*\\\[]/.test(branch) || branch.startsWith("-")
    || branch.endsWith("/") || branch.includes("..") || branch.includes("//")) {
    fail("LOCAL_PILOT_GIT_CHECKOUT_INVALID");
  }
  return Object.freeze({ sha, checkout: branch });
}

export function assertRequiredPortsFree(portSnapshot) {
  if (!(portSnapshot instanceof Map)
    || portSnapshot.size !== REQUIRED_PORTS.length
    || REQUIRED_PORTS.some((port) => !portSnapshot.has(port))) {
    fail("LOCAL_PILOT_PORT_CHECK_INCOMPLETE");
  }
  for (const port of REQUIRED_PORTS) {
    if (portSnapshot.get(port) !== true) fail(`LOCAL_PILOT_PORT_IN_USE_${port}`);
  }
  return true;
}

async function defaultRunCommand(executable, argv, options) {
  return execFileAsync(executable, argv, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    timeout: 30_000,
    killSignal: "SIGTERM",
  });
}

export function checkLoopbackPortFree(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return Promise.reject(new Error("LOCAL_PILOT_PORT_CHECK_INVALID"));
  }
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      if (error && typeof error === "object" && error.code === "EADDRINUSE") {
        resolvePromise(false);
      } else {
        reject(new Error("LOCAL_PILOT_PORT_CHECK_FAILED"));
      }
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => {
        if (error) reject(new Error("LOCAL_PILOT_PORT_CHECK_FAILED"));
        else resolvePromise(true);
      });
    });
  });
}

export async function captureLocalPilotPreflight({
  repository,
  nodePath,
  pnpmPath,
  pythonPath,
  opensslPath = "/opt/homebrew/bin/openssl",
  dockerPath = "docker",
  runCommand = defaultRunCommand,
  statFileSystem = nodeStatfs,
  checkPort = checkLoopbackPortFree,
  browserProbe = probeManagedPlaywrightChromium,
  runtimeExecutableProbe = probeRuntimeExecutableFingerprints,
  approvedRuntimeToolchains,
  baseEnvironment = process.env,
}) {
  if (!isAbsolute(repository) || !isAbsolute(nodePath) || !isAbsolute(pnpmPath)
    || !isAbsolute(pythonPath) || opensslPath !== "/opt/homebrew/bin/openssl"
    || typeof dockerPath !== "string" || dockerPath.length === 0
    || typeof runCommand !== "function" || typeof statFileSystem !== "function"
    || typeof checkPort !== "function" || typeof browserProbe !== "function"
    || typeof runtimeExecutableProbe !== "function") {
    fail("LOCAL_PILOT_PREFLIGHT_CONFIG_INVALID");
  }
  const tempRoot = baseEnvironment?.TMPDIR;
  if (typeof tempRoot !== "string" || !isAbsolute(tempRoot)) {
    fail("LOCAL_PILOT_TEMP_ROOT_INVALID");
  }
  const commandEnvironment = {};
  for (const name of [
    "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "DOCKER_HOST", "DOCKER_CONTEXT",
    "DOCKER_CONFIG", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ]) {
    const value = baseEnvironment?.[name];
    if (typeof value === "string" && value.length > 0 && !value.includes("\u0000")) {
      commandEnvironment[name] = value;
    }
  }
  if (!commandEnvironment.PATH || !isAbsolute(commandEnvironment.HOME ?? "")) {
    fail("LOCAL_PILOT_PREFLIGHT_ENVIRONMENT_INVALID");
  }
  const run = async (executable, argv) => runCommand(executable, argv, {
    cwd: repository,
    env: commandEnvironment,
    shell: false,
  });
  let git;
  try {
    const headBefore = await run("git", ["rev-parse", "HEAD"]);
    const status = await run("git", ["status", "--porcelain=v1", "-z"]);
    const headAfter = await run("git", ["rev-parse", "HEAD"]);
    const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (headBefore.stdout.trim() !== headAfter.stdout.trim()) {
      fail("LOCAL_PILOT_GIT_SHA_DRIFT");
    }
    git = assertGitSnapshot({
      sha: headBefore.stdout.trim(),
      branch: branch.stdout.trim(),
      status: status.stdout,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("LOCAL_PILOT_")) throw error;
    fail("LOCAL_PILOT_GIT_PREFLIGHT_FAILED");
  }

  let runtime;
  let runtimeExecutables;
  let openssl;
  let compose;
  let dockerServer;
  try {
    const [node, pnpm, python, opensslResult, composeResult] = await Promise.all([
      run(nodePath, ["--version"]),
      run(pnpmPath, ["--version"]),
      run(pythonPath, ["--version"]),
      run(opensslPath, ["version"]),
      run(dockerPath, ["compose", "version", "--short"]),
    ]);
    runtime = assertRuntimeFingerprints({
      node: node.stdout,
      pnpm: pnpm.stdout,
      python: python.stdout,
    });
    runtimeExecutables = assertRuntimeExecutableFingerprints(
      await runtimeExecutableProbe({ nodePath, pnpmPath, pythonPath }),
      approvedRuntimeToolchains ?? await loadApprovedRuntimeToolchains(),
    );
    openssl = opensslResult.stdout.trim();
    compose = composeResult.stdout.trim();
    if (!/^OpenSSL 3\.[0-9]+\.[0-9]+\b/.test(openssl)
      || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(compose)) {
      fail("LOCAL_PILOT_TOOL_FINGERPRINT_INVALID");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("LOCAL_PILOT_")) throw error;
    fail("LOCAL_PILOT_TOOLCHAIN_UNAVAILABLE");
  }
  let availableBytes;
  let tempAvailableBytes;
  try {
    const [repositoryFileSystem, tempFileSystem] = await Promise.all([
      statFileSystem(repository),
      statFileSystem(tempRoot),
    ]);
    availableBytes = Number(repositoryFileSystem.bavail) * Number(repositoryFileSystem.bsize);
    tempAvailableBytes = Number(tempFileSystem.bavail) * Number(tempFileSystem.bsize);
    assertMinimumFreeBytes(availableBytes);
    if (!Number.isSafeInteger(tempAvailableBytes) || tempAvailableBytes < MINIMUM_FREE_BYTES) {
      fail("LOCAL_PILOT_TEMP_SPACE_INSUFFICIENT");
    }
  } catch (error) {
    if (error instanceof Error && [
      "LOCAL_PILOT_DISK_SPACE_INSUFFICIENT", "LOCAL_PILOT_TEMP_SPACE_INSUFFICIENT",
    ].includes(error.message)) throw error;
    fail("LOCAL_PILOT_DISK_CHECK_FAILED");
  }
  try {
    dockerServer = (await run(dockerPath, ["info", "--format", "{{.ServerVersion}}"])).stdout.trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?$/.test(dockerServer)) {
      fail("LOCAL_PILOT_DOCKER_UNAVAILABLE");
    }
  } catch {
    fail("LOCAL_PILOT_DOCKER_UNAVAILABLE");
  }
  const ports = new Map();
  try {
    const checks = await Promise.all(REQUIRED_PORTS.map(async (port) => [port, await checkPort(port)]));
    for (const [port, free] of checks) ports.set(port, free);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("LOCAL_PILOT_")) throw error;
    fail("LOCAL_PILOT_PORT_CHECK_FAILED");
  }
  assertRequiredPortsFree(ports);
  let browser;
  try {
    const fingerprint = await browserProbe({ homeDirectory: commandEnvironment.HOME });
    browser = assertPlaywrightChromiumFingerprint(fingerprint, commandEnvironment.HOME);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("LOCAL_PILOT_")) throw error;
    fail("LOCAL_PILOT_CHROMIUM_PREFLIGHT_FAILED");
  }
  return Object.freeze({
    ...git,
    ...runtime,
    ...runtimeExecutables,
    availableBytes,
    tempAvailableBytes,
    tempRoot,
    openssl,
    compose,
    dockerServer,
    ...browser,
  });
}
