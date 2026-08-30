import { describe, expect, it } from "vitest";

import {
  MINIMUM_FREE_BYTES,
  assertGitSnapshot,
  assertMinimumFreeBytes,
  assertRequiredPortsFree,
  assertRuntimeFingerprints,
  captureLocalPilotPreflight,
} from "../../scripts/local-pilot/preflight.mjs";

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
    const result = await captureLocalPilotPreflight({
      repository: "/approved/repository",
      nodePath: "/approved/node",
      pnpmPath: "/approved/pnpm",
      pythonPath: "/approved/python",
      baseEnvironment: { PATH: "/approved/bin", HOME: "/approved/home", TMPDIR: "/approved/temp", FORBIDDEN_SECRET_SENTINEL: "must-not-propagate" },
      runCommand,
      statFileSystem: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
      checkPort: async () => true,
    });
    expect(result).toMatchObject({
      sha: "a".repeat(40),
      checkout: "main",
      availableBytes: 30 * 1024 ** 3,
      tempAvailableBytes: 30 * 1024 ** 3,
      tempRoot: "/approved/temp",
      dockerServer: "28.3.3",
      compose: "5.1.4",
      openssl: "OpenSSL 3.6.3 9 Jun 2026",
    });
    expect(calls.every(({ shell }) => shell === false)).toBe(true);
    expect(calls.every(({ env }) => !("FORBIDDEN_SECRET_SENTINEL" in env))).toBe(true);
    expect(calls.every(({ env }) => env.PATH === "/approved/bin" && env.HOME === "/approved/home" && env.TMPDIR === "/approved/temp")).toBe(true);
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
