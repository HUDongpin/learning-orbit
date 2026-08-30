import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_ERROR = "LO_LOCAL_SAME_ORIGIN_PROXY_FORBIDDEN";

const requireFromHere = createRequire(import.meta.url);
const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];

export function assertProductionStartPolicy(environment) {
  if (environment.LO_LOCAL_SAME_ORIGIN_PROXY === "1") {
    throw new Error(FORBIDDEN_ERROR);
  }
}

export function superviseChild(child, host = process) {
  let settled = false;
  const signalHandlers = new Map();
  let onError;
  let onExit;

  const cleanup = () => {
    for (const [signal, handler] of signalHandlers) {
      host.off(signal, handler);
    }
    signalHandlers.clear();
    child.off("error", onError);
    child.off("exit", onExit);
  };

  const settle = (effect) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    effect();
  };

  for (const signal of forwardedSignals) {
    const forward = () => {
      if (!settled && child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    };
    signalHandlers.set(signal, forward);
    host.on(signal, forward);
  }

  onError = (error) => {
    settle(() => {
      host.stderr.write(`${error.message}\n`);
      host.exitCode = 1;
    });
  };
  onExit = (code, signal) => {
    settle(() => {
      if (signal) {
        host.kill(host.pid, signal);
        return;
      }
      host.exitCode = code ?? 1;
    });
  };

  child.once("error", onError);
  child.once("exit", onExit);
}

export function startProductionServer(argv = process.argv.slice(2)) {
  assertProductionStartPolicy(process.env);

  const nextCli = requireFromHere.resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [nextCli, "start", ...argv], {
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  superviseChild(child, process);

  return child;
}

function isDirectRun() {
  const invokedPath = process.argv[1];
  if (!invokedPath) {
    return false;
  }

  try {
    return realpathSync(path.resolve(invokedPath)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  try {
    startProductionServer();
  } catch (error) {
    if (error instanceof Error && error.message === FORBIDDEN_ERROR) {
      process.stderr.write(`${FORBIDDEN_ERROR}\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
