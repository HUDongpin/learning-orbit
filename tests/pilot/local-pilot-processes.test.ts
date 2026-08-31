import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  OwnedProcessSet,
  buildLocalProcessSpecs,
  registerAndStartOwnedProcesses,
  waitForReadiness,
} from "../../scripts/local-pilot/processes.mjs";
import { CleanupStack } from "../../scripts/local-pilot/workflow.mjs";

class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => {
      this.emit("exit", null, signal);
      this.emit("close", null, signal);
    });
    return true;
  }
}

const repoRoot = resolve(import.meta.dirname, "../..");

describe("run-owned application process lifecycle", () => {
  it("builds exact direct child commands without a shell", () => {
    const specs = buildLocalProcessSpecs({
      checkout: repoRoot,
      nodePath: "/approved/node",
      pythonPath: "/approved/python",
      tls: { privateKeyPath: "/tmp/key.pem", certificatePath: "/tmp/cert.pem" },
      environments: {
        server: { ROLE: "server" },
        worker: { ROLE: "worker" },
        next: { ROLE: "next" },
      },
    });
    expect(specs.map(({ name }) => name)).toEqual(["fastify", "worker", "next"]);
    expect(specs[0]).toMatchObject({
      executable: "/approved/node",
      argv: [resolve(repoRoot, "apps/server/dist/src/main.js")],
      cwd: repoRoot,
      env: { ROLE: "server" },
    });
    expect(specs[1]).toMatchObject({
      executable: "/approved/python",
      argv: ["-m", "learning_orbit_worker.main"],
      env: { ROLE: "worker" },
    });
    expect(specs[2]?.argv).toEqual([
      resolve(repoRoot, "apps/web/node_modules/next/dist/bin/next"),
      "dev", "--hostname", "127.0.0.1", "--port", "3000", "--experimental-https",
      "--experimental-https-key", "/tmp/key.pem",
      "--experimental-https-cert", "/tmp/cert.pem",
    ]);
    expect(specs.every((spec) => spec.shell === false)).toBe(true);
  });

  it("starts in declared order and stops only its children in reverse order", async () => {
    const children = [new FakeChild(101), new FakeChild(102), new FakeChild(103)];
    const spawn = vi.fn(() => children.shift()!);
    const processes = new OwnedProcessSet({ spawn, stopTimeoutMs: 1_000 });
    const specs = ["fastify", "worker", "next"].map((name) => ({
      name,
      executable: `/approved/${name}`,
      argv: [],
      cwd: repoRoot,
      env: {},
      shell: false as const,
    }));
    const handles = specs.map((spec) => processes.start(spec));
    expect(handles.map(({ pid }) => pid)).toEqual([101, 102, 103]);
    expect(spawn).toHaveBeenCalledTimes(3);
    await processes.stopAll();
    expect(handles.map(({ child }) => (child as FakeChild).signals)).toEqual([
      ["SIGTERM"],
      ["SIGTERM"],
      ["SIGTERM"],
    ]);
    expect(processes.stopOrder).toEqual(["next", "worker", "fastify"]);

    const partialChild = new FakeChild(104);
    const partial = new OwnedProcessSet({
      spawn: vi.fn()
        .mockReturnValueOnce(partialChild)
        .mockImplementationOnce(() => { throw new Error("sensitive spawn failure"); }),
      stopTimeoutMs: 1_000,
    });
    const partialCleanup = new CleanupStack();
    expect(() => registerAndStartOwnedProcesses({
      processes: partial,
      specs: specs.slice(0, 2),
      cleanup: partialCleanup,
    })).toThrow("LOCAL_PILOT_CHILD_FAILED_worker");
    expect(await partialCleanup.run()).toEqual([{ id: "application-processes", status: "passed" }]);
    expect(partialChild.signals).toEqual(["SIGTERM"]);
  });

  it("records an early child error once even if exit follows", () => {
    const child = new FakeChild(201);
    const processes = new OwnedProcessSet({ spawn: vi.fn(() => child), stopTimeoutMs: 1_000 });
    processes.start({
      name: "fastify",
      executable: "/approved/node",
      argv: [],
      cwd: repoRoot,
      env: {},
      shell: false,
    });
    child.emit("error", new Error("sensitive child detail"));
    child.emit("exit", 0, null);
    expect(() => processes.assertRunning()).toThrow("LOCAL_PILOT_CHILD_FAILED_fastify");
    expect(processes.failures).toEqual([{ name: "fastify", code: "spawn_error" }]);
  });

  it("does not mistake a spawn error event for observed process exit during cleanup", async () => {
    const child = new FakeChild(202);
    child.kill = vi.fn((signal: NodeJS.Signals) => {
      child.signals.push(signal);
      return true;
    });
    const processes = new OwnedProcessSet({ spawn: vi.fn(() => child), stopTimeoutMs: 2 });
    processes.start({
      name: "fastify",
      executable: "/approved/node",
      argv: [],
      cwd: repoRoot,
      env: {},
      shell: false,
    });
    child.emit("error", new Error("sensitive child detail"));
    await expect(processes.stopAll()).rejects.toThrow("LOCAL_PILOT_CHILD_STOP_FAILED_fastify");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("treats close without exit as a terminal unexpected child failure", () => {
    const child = new FakeChild(203);
    const processes = new OwnedProcessSet({ spawn: vi.fn(() => child), stopTimeoutMs: 1_000 });
    processes.start({
      name: "worker",
      executable: "/approved/python",
      argv: [],
      cwd: repoRoot,
      env: {},
      shell: false,
    });
    child.emit("close", null, "SIGKILL");
    expect(() => processes.assertRunning()).toThrow("LOCAL_PILOT_CHILD_FAILED_worker");
    expect(processes.failures).toEqual([{ name: "worker", code: "unexpected_close" }]);
  });

  it("waits for close without signalling again after exit was observed", async () => {
    const child = new FakeChild(204);
    const processes = new OwnedProcessSet({ spawn: vi.fn(() => child), stopTimeoutMs: 1_000 });
    processes.start({
      name: "next",
      executable: "/approved/node",
      argv: [],
      cwd: repoRoot,
      env: {},
      shell: false,
    });
    child.emit("exit", 0, null);
    const stopping = processes.stopAll();
    await Promise.resolve();
    expect(child.signals).toEqual([]);
    child.emit("close", 0, null);
    await expect(stopping).resolves.toBeUndefined();
  });

  it("retries bounded readiness probes and fails with a stable code", async () => {
    const successProbe = vi.fn()
      .mockRejectedValueOnce(new Error("sensitive network detail"))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await expect(waitForReadiness({
      name: "next",
      probe: successProbe,
      timeoutMs: 1_000,
      intervalMs: 1,
    })).resolves.toBeUndefined();
    expect(successProbe).toHaveBeenCalledTimes(3);
    await expect(waitForReadiness({
      name: "fastify",
      probe: vi.fn().mockResolvedValue(false),
      timeoutMs: 5,
      intervalMs: 1,
    })).rejects.toThrow("LOCAL_PILOT_READINESS_TIMEOUT_fastify");
  });
});
