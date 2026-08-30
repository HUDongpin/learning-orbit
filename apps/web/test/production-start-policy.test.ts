import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

const FORBIDDEN_ERROR = "LO_LOCAL_SAME_ORIGIN_PROXY_FORBIDDEN";
const webRoot = process.cwd();
const startPath = path.join(webRoot, "scripts/start.mjs");

type StartModule = {
  assertProductionStartPolicy?: (
    environment: Record<string, string | undefined>,
  ) => void;
  superviseChild?: (child: EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill(signal: NodeJS.Signals): boolean;
  }, host: EventEmitter & {
    exitCode: number | undefined;
    pid: number;
    kill(pid: number, signal: NodeJS.Signals): void;
    stderr: { write(value: string): void };
  }) => void;
};

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((_signal: NodeJS.Signals) => true);
}

class FakeHost extends EventEmitter {
  exitCode: number | undefined;
  readonly pid = 4242;
  readonly kill = vi.fn((_pid: number, _signal: NodeJS.Signals) => undefined);
  readonly stderr = { write: vi.fn((_value: string) => undefined) };
}

async function loadStartModule(): Promise<StartModule> {
  const module = await import(/* @vite-ignore */ pathToFileURL(startPath).href)
    .catch(() => undefined);

  expect(module, "canonical production start module is missing").toBeDefined();
  return module as StartModule;
}

describe("canonical web production start policy", () => {
  it("rejects the local proxy before Next can emit output or start a listener", () => {
    const result = spawnSync(process.execPath, [startPath, "--help"], {
      encoding: "utf8",
      env: {
        NODE_ENV: "production",
        LO_LOCAL_SAME_ORIGIN_PROXY: "1",
      },
      timeout: 15_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${FORBIDDEN_ERROR}\n`);
  });

  it("delegates allowed argv to Next without starting a long-lived server", () => {
    const result = spawnSync(process.execPath, [startPath, "--help"], {
      encoding: "utf8",
      env: {
        NODE_ENV: "production",
        LO_LOCAL_SAME_ORIGIN_PROXY: "0",
      },
      timeout: 15_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("Usage: next start");
  });

  it.each([undefined, "", "0", "true", " 1", "1 "])(
    "allows the pure startup policy when the flag is %s",
    async (flag) => {
      const module = await loadStartModule();
      expect(module.assertProductionStartPolicy).toBeTypeOf("function");

      expect(() => module.assertProductionStartPolicy?.({
        LO_LOCAL_SAME_ORIGIN_PROXY: flag,
      })).not.toThrow();
    },
  );

  it("rejects exact flag 1 through the pure startup policy", async () => {
    const module = await loadStartModule();
    expect(module.assertProductionStartPolicy).toBeTypeOf("function");

    expect(() => module.assertProductionStartPolicy?.({
      LO_LOCAL_SAME_ORIGIN_PROXY: "1",
    })).toThrow(FORBIDDEN_ERROR);
  });

  it("owns the exact package start entry", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(webRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(manifest.scripts?.start).toBe("node scripts/start.mjs");
  });

  it("settles spawn error once even if exit follows", async () => {
    const module = await loadStartModule();
    expect(module.superviseChild).toBeTypeOf("function");
    const child = new FakeChild();
    const host = new FakeHost();

    module.superviseChild?.(child, host);
    child.emit("error", new Error("SPAWN_FAILED"));
    child.emit("exit", 0, null);

    expect(host.exitCode).toBe(1);
    expect(host.stderr.write).toHaveBeenCalledTimes(1);
    expect(host.stderr.write).toHaveBeenCalledWith("SPAWN_FAILED\n");
    expect(host.kill).not.toHaveBeenCalled();
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it.each([0, 7])("preserves normal child exit code %s", async (code) => {
    const module = await loadStartModule();
    const child = new FakeChild();
    const host = new FakeHost();

    module.superviseChild?.(child, host);
    child.emit("exit", code, null);

    expect(host.exitCode).toBe(code);
    expect(host.kill).not.toHaveBeenCalled();
  });

  it("forwards child signal exit exactly once", async () => {
    const module = await loadStartModule();
    const child = new FakeChild();
    const host = new FakeHost();

    module.superviseChild?.(child, host);
    child.emit("exit", null, "SIGTERM");
    child.emit("exit", 0, null);

    expect(host.kill).toHaveBeenCalledTimes(1);
    expect(host.kill).toHaveBeenCalledWith(host.pid, "SIGTERM");
    expect(host.stderr.write).not.toHaveBeenCalled();
  });

  it("forwards host signals only before settlement and cleans handlers", async () => {
    const module = await loadStartModule();
    const child = new FakeChild();
    const host = new FakeHost();

    module.superviseChild?.(child, host);
    host.emit("SIGINT");
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    child.emit("exit", 0, null);
    host.emit("SIGTERM");

    expect(child.kill).toHaveBeenCalledTimes(1);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      expect(host.listenerCount(signal)).toBe(0);
    }
  });
});
