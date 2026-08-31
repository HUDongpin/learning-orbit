import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  MINIMUM_FREE_BYTES,
  assertGitSnapshot,
  assertMinimumFreeBytes,
  assertRequiredPortsFree,
  assertRuntimeFingerprints,
  assertInfrastructurePins,
  assertPostgres18,
  assertPythonLockMinor,
  captureLocalPilotPreflight,
} from "../../scripts/local-pilot/preflight.mjs";

const managedChromiumFingerprint = (overrides: Record<string, unknown> = {}) => ({
  playwrightVersion: "1.62.1",
  chromiumRevision: "1234",
  declaredChromiumVersion: "151.0.7922.34",
  executablePath: "/approved/home/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  realExecutablePath: "/approved/home/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  executableIsFile: true,
  executableMode: 0o100755,
  launchedChromiumVersion: "151.0.7922.34",
  closed: true,
  ...overrides,
});

describe("local pilot preflight contracts", () => {
  it("requires the exact pinned runtimes and at least 25 GiB", () => {
    expect(() => assertRuntimeFingerprints({
      node: "v24.19.0",
      pnpm: "11.19.0",
      python: "Python 3.12.13",
    })).not.toThrow();
    expect(() => assertRuntimeFingerprints({
      node: "v24.19.1",
      pnpm: "11.19.0",
      python: "Python 3.12.13",
    })).toThrow("LOCAL_PILOT_NODE_VERSION_MISMATCH");
    expect(() => assertRuntimeFingerprints({
      node: "v24.19.0",
      pnpm: "11.20.0",
      python: "Python 3.12.13",
    })).toThrow("LOCAL_PILOT_PNPM_VERSION_MISMATCH");
    expect(() => assertRuntimeFingerprints({
      node: "v24.19.0",
      pnpm: "11.19.0",
      python: "Python 3.13.0",
    })).toThrow("LOCAL_PILOT_PYTHON_VERSION_MISMATCH");

    expect(MINIMUM_FREE_BYTES).toBe(25 * 1024 ** 3);
    expect(() => assertMinimumFreeBytes(MINIMUM_FREE_BYTES)).not.toThrow();
    expect(() => assertMinimumFreeBytes(MINIMUM_FREE_BYTES - 1)).toThrow(
      "LOCAL_PILOT_DISK_SPACE_INSUFFICIENT",
    );
  });

  it("pins the Python lock minor and both isolated service image digests", () => {
    expect(() => assertPythonLockMinor([
      "# generated with Python 3.12",
      "#    python -m piptools compile --generate-hashes --resolver=backtracking --output-file services/worker/requirements.lock services/worker/pyproject.toml",
    ].join("\n"))).not.toThrow();
    expect(() => assertPythonLockMinor("# generated with Python 3.13\n"))
      .toThrow("LOCAL_PILOT_PYTHON_LOCK_MINOR_MISMATCH");

    const compose = [
      "services:",
      "  postgres:",
      "    image: postgres:18@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280",
      "  mailpit:",
      "    image: axllent/mailpit:v1.31.0@sha256:c96991d9bef73594c246d89ca81411d4e916f03e76a7d2d72fa2ab5dd3c9ce24",
    ].join("\n");
    expect(() => assertInfrastructurePins(compose)).not.toThrow();
    expect(() => assertInfrastructurePins(compose.replace("postgres:18@", "postgres:17@")))
      .toThrow("LOCAL_PILOT_POSTGRES_IMAGE_MISMATCH");
    expect(() => assertInfrastructurePins(compose.replace("mailpit:v1.31.0@", "mailpit:latest@")))
      .toThrow("LOCAL_PILOT_MAILPIT_IMAGE_MISMATCH");
  });

  it("accepts only a live PostgreSQL 18 server version number", () => {
    expect(assertPostgres18("180002\n")).toEqual({ major: 18, versionNumber: 180002 });
    expect(() => assertPostgres18("170009\n")).toThrow("LOCAL_PILOT_POSTGRES_VERSION_MISMATCH");
    expect(() => assertPostgres18("PostgreSQL 18.2\n")).toThrow(
      "LOCAL_PILOT_POSTGRES_VERSION_INVALID",
    );
    expect(() => assertPostgres18("180002\nextra\n")).toThrow(
      "LOCAL_PILOT_POSTGRES_VERSION_INVALID",
    );
  });

  it("accepts only a clean full commit snapshot with stable branch identity", () => {
    const sha = "a".repeat(40);
    expect(assertGitSnapshot({ sha, branch: "codex/login", status: "" })).toEqual({
      sha,
      checkout: "codex/login",
    });
    expect(assertGitSnapshot({ sha, branch: "HEAD", status: "" })).toEqual({
      sha,
      checkout: "detached",
    });
    expect(() => assertGitSnapshot({ sha: "abc", branch: "main", status: "" })).toThrow(
      "LOCAL_PILOT_GIT_SHA_INVALID",
    );
    expect(() => assertGitSnapshot({ sha, branch: "main", status: " M app.ts\n" })).toThrow(
      "LOCAL_PILOT_WORKTREE_DIRTY",
    );
    expect(() => assertGitSnapshot({ sha, branch: "", status: "" })).toThrow(
      "LOCAL_PILOT_GIT_CHECKOUT_INVALID",
    );
  });

  it("fails closed when any fixed local-pilot port is already owned", () => {
    const free = new Map([
      [3000, true],
      [3001, true],
      [55432, true],
      [8025, true],
      [1025, true],
    ]);
    expect(() => assertRequiredPortsFree(free)).not.toThrow();
    free.set(3000, false);
    expect(() => assertRequiredPortsFree(free)).toThrow("LOCAL_PILOT_PORT_IN_USE_3000");
    free.set(3000, true);
    free.delete(1025);
    expect(() => assertRequiredPortsFree(free)).toThrow("LOCAL_PILOT_PORT_CHECK_INCOMPLETE");
  });

  it("captures only bounded command fingerprints using argv arrays", async () => {
    const calls: Array<{ executable: string; argv: string[]; shell: boolean; env: Record<string, string> }> = [];
    const outputs = new Map([
      ["git rev-parse HEAD", `${"a".repeat(40)}\n`],
      ["git rev-parse --abbrev-ref HEAD", "main\n"],
      ["git status --porcelain=v1 -z", ""],
      ["/approved/node --version", "v24.19.0\n"],
      ["/approved/pnpm --version", "11.19.0\n"],
      ["/approved/python --version", "Python 3.12.13\n"],
      ["/opt/homebrew/bin/openssl version", "OpenSSL 3.6.3 9 Jun 2026\n"],
      ["docker compose version --short", "5.1.4\n"],
      ["docker info --format {{.ServerVersion}}", "28.3.3\n"],
    ]);
    const runCommand = async (executable: string, argv: string[], options: { shell: boolean; env: Record<string, string> }) => {
      calls.push({ executable, argv, shell: options.shell, env: options.env });
      const key = `${executable} ${argv.join(" ")}`;
      if (!outputs.has(key)) throw new Error(`unexpected command ${key}`);
      return { stdout: outputs.get(key)! };
    };
    const captureOptions = {
      repository: "/approved/repository",
      nodePath: "/approved/node",
      pnpmPath: "/approved/pnpm",
      pythonPath: "/approved/python",
      baseEnvironment: { PATH: "/approved/bin", HOME: "/approved/home", TMPDIR: "/approved/temp", FORBIDDEN_SECRET_SENTINEL: "must-not-propagate" },
      runCommand,
      statFileSystem: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
      checkPort: async () => true,
      browserProbe: async () => managedChromiumFingerprint(),
    };
    const result = await captureLocalPilotPreflight(captureOptions);
    expect(result).toMatchObject({
      sha: "a".repeat(40),
      checkout: "main",
      availableBytes: 30 * 1024 ** 3,
      tempAvailableBytes: 30 * 1024 ** 3,
      tempRoot: "/approved/temp",
      dockerServer: "28.3.3",
      compose: "5.1.4",
      openssl: "OpenSSL 3.6.3 9 Jun 2026",
      playwright: "1.62.1",
      chromiumRevision: "1234",
      chromiumVersion: "151.0.7922.34",
      chromiumExecutable: "managed",
      chromiumHeadlessLaunch: "passed",
    });
    expect(calls.every(({ shell }) => shell === false)).toBe(true);
    expect(calls.every(({ env }) => !("FORBIDDEN_SECRET_SENTINEL" in env))).toBe(true);
    expect(calls.every(({ env }) => env.PATH === "/approved/bin" && env.HOME === "/approved/home" && env.TMPDIR === "/approved/temp")).toBe(true);
    const verifySource = await readFile(
      new URL("../../scripts/verify-local-pilot.mjs", import.meta.url),
      "utf8",
    );
    expect(verifySource).toContain("playwright: snapshot.playwright");
    expect(verifySource).toContain("chromiumRevision: snapshot.chromiumRevision");
    expect(verifySource).toContain("chromium: snapshot.chromiumVersion");

    await expect(captureLocalPilotPreflight({
      ...captureOptions,
      browserProbe: async () => managedChromiumFingerprint({ chromiumRevision: "1233" }),
    })).rejects.toThrow("LOCAL_PILOT_CHROMIUM_REVISION_MISMATCH");
    await expect(captureLocalPilotPreflight({
      ...captureOptions,
      browserProbe: async () => managedChromiumFingerprint({ playwrightVersion: "1.62.0" }),
    })).rejects.toThrow("LOCAL_PILOT_PLAYWRIGHT_VERSION_MISMATCH");
    await expect(captureLocalPilotPreflight({
      ...captureOptions,
      browserProbe: async () => managedChromiumFingerprint({
        declaredChromiumVersion: "151.0.7922.35",
      }),
    })).rejects.toThrow("LOCAL_PILOT_CHROMIUM_VERSION_MISMATCH");
    await expect(captureLocalPilotPreflight({
      ...captureOptions,
      browserProbe: async () => managedChromiumFingerprint({
        executablePath: "/tmp/chromium-1234/Chromium",
        realExecutablePath: "/tmp/chromium-1234/Chromium",
      }),
    })).rejects.toThrow("LOCAL_PILOT_CHROMIUM_EXECUTABLE_UNMANAGED");
    await expect(captureLocalPilotPreflight({
      ...captureOptions,
      browserProbe: async () => managedChromiumFingerprint({ executableMode: 0o100644 }),
    })).rejects.toThrow("LOCAL_PILOT_CHROMIUM_EXECUTABLE_INVALID");
    await expect(captureLocalPilotPreflight({
      ...captureOptions,
      browserProbe: async () => managedChromiumFingerprint({
        launchedChromiumVersion: "151.0.7922.35",
      }),
    })).rejects.toThrow("LOCAL_PILOT_CHROMIUM_VERSION_MISMATCH");
    await expect(captureLocalPilotPreflight({
      ...captureOptions,
      browserProbe: async () => managedChromiumFingerprint({ closed: false }),
    })).rejects.toThrow("LOCAL_PILOT_CHROMIUM_CLOSE_FAILED");
  });

  it("turns Docker and listener failures into stable content-free codes", async () => {
    const baseOutput = async (executable: string, argv: string[]) => {
      const key = `${executable} ${argv.join(" ")}`;
      const values: Record<string, string> = {
        "git rev-parse HEAD": `${"b".repeat(40)}\n`,
        "git rev-parse --abbrev-ref HEAD": "HEAD\n",
        "git status --porcelain=v1 -z": "",
        "/approved/node --version": "v24.19.0\n",
        "/approved/pnpm --version": "11.19.0\n",
        "/approved/python --version": "Python 3.12.13\n",
        "/opt/homebrew/bin/openssl version": "OpenSSL 3.6.3 9 Jun 2026\n",
        "docker compose version --short": "5.1.4\n",
        "docker info --format {{.ServerVersion}}": "28.3.3\n",
      };
      return { stdout: values[key]! };
    };
    const options = {
      repository: "/approved/repository",
      nodePath: "/approved/node",
      pnpmPath: "/approved/pnpm",
      pythonPath: "/approved/python",
      statFileSystem: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
      checkPort: async () => true,
      browserProbe: async () => managedChromiumFingerprint({
        executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
        realExecutablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      }),
    };
    await expect(captureLocalPilotPreflight({
      ...options,
      runCommand: async (executable: string, argv: string[], commandOptions: { shell: boolean }) => {
        if (executable === "docker" && argv[0] === "info") throw new Error("sensitive daemon path");
        return baseOutput(executable, argv, commandOptions);
      },
    })).rejects.toThrow("LOCAL_PILOT_DOCKER_UNAVAILABLE");
    await expect(captureLocalPilotPreflight({
      ...options,
      runCommand: baseOutput,
      checkPort: async (port: number) => port !== 3000,
    })).rejects.toThrow("LOCAL_PILOT_PORT_IN_USE_3000");
  });
});
