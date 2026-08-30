import { spawn as nodeSpawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

const PROCESS_NAMES = new Set(["fastify", "worker", "next"]);
const fail = (code) => {
  throw new Error(code);
};

function assertPlainEnvironment(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)
    || Object.entries(env).some(([key, value]) => !/^[A-Z][A-Z0-9_]*$/.test(key)
      || typeof value !== "string" || value.includes("\u0000"))) {
    fail("LOCAL_PILOT_CHILD_ENVIRONMENT_INVALID");
  }
}

function assertSpec(spec) {
  if (!spec || !PROCESS_NAMES.has(spec.name) || !isAbsolute(spec.executable)
    || !isAbsolute(spec.cwd) || spec.shell !== false || !Array.isArray(spec.argv)
    || spec.argv.some((argument) => typeof argument !== "string" || argument.includes("\u0000"))) {
    fail("LOCAL_PILOT_CHILD_SPEC_INVALID");
  }
  assertPlainEnvironment(spec.env);
}

export function buildLocalProcessSpecs({ checkout, nodePath, pythonPath, tls, environments }) {
  if (!isAbsolute(checkout) || !isAbsolute(nodePath) || !isAbsolute(pythonPath)
    || !tls || !isAbsolute(tls.privateKeyPath) || !isAbsolute(tls.certificatePath)
    || !environments) {
    fail("LOCAL_PILOT_PROCESS_CONFIG_INVALID");
  }
  const nextCli = resolve(checkout, "apps/web/node_modules/next/dist/bin/next");
  const specs = [
    {
      name: "fastify",
      executable: nodePath,
      argv: [resolve(checkout, "apps/server/dist/src/main.js")],
      cwd: checkout,
      env: environments.server,
      shell: false,
    },
    {
      name: "worker",
      executable: pythonPath,
      argv: ["-m", "learning_orbit_worker.main"],
      cwd: checkout,
      env: environments.worker,
      shell: false,
    },
    {
      name: "next",
      executable: nodePath,
      argv: [
        nextCli,
        "dev", "--hostname", "127.0.0.1", "--port", "3000", "--experimental-https",
        "--experimental-https-key", tls.privateKeyPath,
        "--experimental-https-cert", tls.certificatePath,
      ],
      cwd: checkout,
      env: environments.next,
      shell: false,
    },
  ];
  specs.forEach(assertSpec);
  return Object.freeze(specs.map((spec) => Object.freeze({ ...spec, argv: Object.freeze([...spec.argv]) })));
}

const timeout = (milliseconds) => new Promise((resolvePromise) => {
  setTimeout(() => resolvePromise("timeout"), milliseconds);
});

function waitWithTimeout(promise, milliseconds) {
  let timer;
  const deadline = new Promise((resolvePromise) => {
    timer = setTimeout(() => resolvePromise("timeout"), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export class OwnedProcessSet {
  #spawn;
  #stopTimeoutMs;
  #handles = [];

  failures = [];
  stopOrder = [];

  constructor({ spawn = nodeSpawn, stopTimeoutMs = 10_000 } = {}) {
    if (typeof spawn !== "function" || !Number.isSafeInteger(stopTimeoutMs)
      || stopTimeoutMs < 1 || stopTimeoutMs > 60_000) {
      fail("LOCAL_PILOT_PROCESS_SUPERVISOR_INVALID");
    }
    this.#spawn = spawn;
    this.#stopTimeoutMs = stopTimeoutMs;
  }

  start(spec) {
    assertSpec(spec);
    if (this.#handles.some((handle) => handle.name === spec.name)) {
      fail("LOCAL_PILOT_CHILD_DUPLICATE");
    }
    let child;
    try {
      child = this.#spawn(spec.executable, [...spec.argv], {
        cwd: spec.cwd,
        env: { ...spec.env },
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      fail(`LOCAL_PILOT_CHILD_FAILED_${spec.name}`);
    }
    if (!child || typeof child.on !== "function" || typeof child.kill !== "function") {
      fail(`LOCAL_PILOT_CHILD_FAILED_${spec.name}`);
    }
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      child.on("error", () => undefined);
      fail(`LOCAL_PILOT_CHILD_FAILED_${spec.name}`);
    }
    let resolveTerminal;
    const terminalPromise = new Promise((resolvePromise) => { resolveTerminal = resolvePromise; });
    const handle = {
      name: spec.name,
      pid: child.pid,
      child,
      state: "running",
      stopping: false,
      exitObserved: false,
      terminalObserved: false,
      terminalPromise,
      resolveTerminal,
    };
    const recordFailure = (code) => {
      if (this.failures.some((failure) => failure.name === spec.name)) return;
      handle.state = "failed";
      this.failures.push(Object.freeze({ name: spec.name, code }));
    };
    child.on("error", () => recordFailure("spawn_error"));
    child.on("exit", (code, signal) => {
      if (handle.exitObserved) return;
      handle.exitObserved = true;
      if (handle.state !== "failed") {
        handle.state = "exited";
        if (!handle.stopping) recordFailure("unexpected_exit");
      }
    });
    child.on("close", () => {
      if (handle.terminalObserved) return;
      handle.terminalObserved = true;
      if (!handle.exitObserved && !handle.stopping) recordFailure("unexpected_close");
      if (handle.state !== "failed") handle.state = "exited";
      handle.resolveTerminal("closed");
    });
    this.#handles.push(handle);
    return Object.freeze({ name: spec.name, pid: child.pid, child });
  }

  assertRunning() {
    if (this.failures.length) fail(`LOCAL_PILOT_CHILD_FAILED_${this.failures[0].name}`);
    const stopped = this.#handles.find((handle) => handle.state !== "running");
    if (stopped) fail(`LOCAL_PILOT_CHILD_NOT_RUNNING_${stopped.name}`);
    return true;
  }

  async #stop(handle) {
    if (handle.terminalObserved) return;
    handle.stopping = true;
    this.stopOrder.push(handle.name);
    if (handle.exitObserved) {
      const closed = await waitWithTimeout(handle.terminalPromise, this.#stopTimeoutMs);
      if (closed === "timeout") fail(`LOCAL_PILOT_CHILD_STOP_FAILED_${handle.name}`);
      return;
    }
    try {
      handle.child.kill("SIGTERM");
    } catch {
      fail(`LOCAL_PILOT_CHILD_STOP_FAILED_${handle.name}`);
    }
    const first = await waitWithTimeout(handle.terminalPromise, this.#stopTimeoutMs);
    if (first !== "timeout") return;
    try {
      handle.child.kill("SIGKILL");
    } catch {
      fail(`LOCAL_PILOT_CHILD_STOP_FAILED_${handle.name}`);
    }
    const second = await waitWithTimeout(handle.terminalPromise, this.#stopTimeoutMs);
    if (second === "timeout") fail(`LOCAL_PILOT_CHILD_STOP_FAILED_${handle.name}`);
  }

  async stopAll() {
    const failures = [];
    for (const handle of [...this.#handles].reverse()) {
      try {
        await this.#stop(handle);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  }
}

export async function waitForReadiness({ name, probe, timeoutMs, intervalMs }) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(name)
    || typeof probe !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || timeoutMs > 60_000 || !Number.isSafeInteger(intervalMs) || intervalMs < 1
    || intervalMs > Math.min(timeoutMs, 5_000)) {
    fail("LOCAL_PILOT_READINESS_CONFIG_INVALID");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch {
      // Readiness is an expected bounded retry. Details remain out of logs.
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await timeout(Math.min(intervalMs, remaining));
  }
  fail(`LOCAL_PILOT_READINESS_TIMEOUT_${name}`);
}
