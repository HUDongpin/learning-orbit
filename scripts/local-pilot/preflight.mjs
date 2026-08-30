import { execFile } from "node:child_process";
import { statfs as nodeStatfs } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MINIMUM_FREE_BYTES = 25 * 1024 ** 3;
export const REQUIRED_PORTS = Object.freeze([3000, 3001, 55432, 8025, 1025]);

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
  baseEnvironment = process.env,
}) {
  if (!isAbsolute(repository) || !isAbsolute(nodePath) || !isAbsolute(pnpmPath)
    || !isAbsolute(pythonPath) || opensslPath !== "/opt/homebrew/bin/openssl"
    || typeof dockerPath !== "string" || dockerPath.length === 0
    || typeof runCommand !== "function" || typeof statFileSystem !== "function"
    || typeof checkPort !== "function") {
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
  if (!commandEnvironment.PATH) fail("LOCAL_PILOT_PREFLIGHT_ENVIRONMENT_INVALID");
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
  return Object.freeze({
    ...git,
    ...runtime,
    availableBytes,
    tempAvailableBytes,
    tempRoot,
    openssl,
    compose,
    dockerServer,
  });
}
