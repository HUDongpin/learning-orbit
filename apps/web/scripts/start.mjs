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

export function startProductionServer(argv = process.argv.slice(2)) {
  assertProductionStartPolicy(process.env);

  const nextCli = requireFromHere.resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [nextCli, "start", ...argv], {
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  const signalHandlers = new Map();

  for (const signal of forwardedSignals) {
    const forward = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    };
    signalHandlers.set(signal, forward);
    process.on(signal, forward);
  }

  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  };

  child.once("error", (error) => {
    removeSignalHandlers();
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    removeSignalHandlers();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });

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
