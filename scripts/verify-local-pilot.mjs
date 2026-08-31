#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveExecutableFromPath } from "./local-pilot/cli.mjs";
import {
  assertComposeProjectAbsent,
  buildComposeArgv,
  buildComposeEnvironment,
  inspectComposeCleanupOwnership,
  inspectComposeOwnership,
} from "./local-pilot/compose.mjs";
import {
  assertFinalRepositoryState,
  hashEvidenceSet,
  writeLocalPilotReceipt,
} from "./local-pilot/evidence.mjs";
import { MailpitClient } from "./local-pilot/mailpit.mjs";
import {
  buildChildEnvironments,
  createRuntimeMaterial,
  removeRuntimeMaterial,
} from "./local-pilot/material.mjs";
import { runLocalPilotOrchestrator } from "./local-pilot/orchestrator.mjs";
import {
  assertInfrastructurePins,
  assertPostgres18,
  assertPythonLockMinor,
  captureLocalPilotPreflight,
} from "./local-pilot/preflight.mjs";
import {
  OwnedProcessSet,
  buildLocalProcessSpecs,
  waitForReadiness,
} from "./local-pilot/processes.mjs";
import {
  assertRequiredGateOrder,
  assertRequiredGateEntrypoints,
  executeRequiredGateSet,
} from "./local-pilot/required-test-runner.mjs";
import { createLocalPilotEvidenceRecorder } from "./local-pilot/stage-evidence.mjs";
import { createLocalTlsMaterial, removeLocalTlsMaterial } from "./local-pilot/tls.mjs";
import {
  createDetachedPilotWorktree,
  removeDetachedPilotWorktree,
} from "./local-pilot/worktree.mjs";

const execFileAsync = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeRelative = "infra/docker-compose.pilot.yml";
const manifestRelative = "tests/pilot/required-test-manifest.v1.json";
const workerLockRelative = "services/worker/requirements.lock";
const MAX_COMMAND_OUTPUT = 64 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15 * 60 * 1_000;

function stableCode(error, fallback) {
  const message = error instanceof Error ? error.message : "";
  return /^((?:LOCAL_PILOT|REQUIRED_TEST|MAILPIT)_[A-Z0-9_]+)/.exec(message)?.[1] ?? fallback;
}

function closedBaseEnvironment(base, nodePath, pnpmPath) {
  const environment = {};
  for (const name of [
    "HOME", "TMPDIR", "LANG", "LC_ALL", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
  ]) {
    const value = base[name];
    if (typeof value === "string" && value.length > 0 && !value.includes("\u0000")) {
      environment[name] = value;
    }
  }
  const inheritedPath = typeof base.PATH === "string" ? base.PATH : "";
  environment.PATH = [dirname(nodePath), dirname(pnpmPath), inheritedPath].filter(Boolean).join(":");
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.NPM_CONFIG_USERCONFIG = "/dev/null";
  environment.PIP_CONFIG_FILE = "/dev/null";
  environment.PIP_DISABLE_PIP_VERSION_CHECK = "1";
  environment.PIP_NO_INPUT = "1";
  return environment;
}

async function execute(executable, argv, {
  cwd,
  env,
  code,
  signal,
  capture = false,
  timeoutMs = COMMAND_TIMEOUT_MS,
  evidence,
}) {
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await execFileAsync(executable, argv, {
      cwd,
      env,
      shell: false,
      encoding: "utf8",
      maxBuffer: MAX_COMMAND_OUTPUT,
      windowsHide: true,
      signal,
      timeout: timeoutMs,
      killSignal: "SIGTERM",
    });
  } catch (error) {
    evidence?.recordCommand({
      executable,
      argv,
      startedAt,
      endedAt: new Date().toISOString(),
      exitCode: Number.isSafeInteger(error?.code) ? error.code : 1,
      stdout: error?.stdout,
      stderr: error?.stderr,
    });
    if (signal?.aborted) throw new Error("LOCAL_PILOT_INTERRUPTED");
    throw new Error(code);
  }
  evidence?.recordCommand({
    executable,
    argv,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: 0,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  return capture ? result : undefined;
}

async function evidenceSet(root) {
  const list = async (directory, suffix) => (await readdir(resolve(root, directory), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => `${directory}/${entry.name}`)
    .sort();
  const [migrations, schemas, contractGenerated, workerGenerated, prototype, pilotScripts] = await Promise.all([
    list("infra/postgres/migrations", ".sql"),
    list("packages/contracts/schemas", ".json"),
    list("packages/contracts/src/generated", ".ts"),
    list("services/worker/src/learning_orbit_worker/generated", ".py"),
    list("packages/test-fixtures/prototype", ".html"),
    list("scripts/local-pilot", ".mjs"),
  ]);
  return Object.freeze({
    dependencyLocks: Object.freeze(["pnpm-lock.yaml", "services/worker/requirements.lock"]),
    runtimePins: Object.freeze(["package.json", "services/worker/pyproject.toml", "infra/docker-compose.pilot.yml"]),
    generatedContracts: Object.freeze([
      ...contractGenerated,
      "packages/contracts/src/generated/manifest.json",
      ...workerGenerated,
      "services/worker/src/learning_orbit_worker/generated/manifest.json",
    ]),
    contractSchemas: Object.freeze(schemas),
    migrations: Object.freeze(migrations),
    browserAndGate: Object.freeze([
      "apps/web/playwright.config.ts",
      manifestRelative,
      ...pilotScripts,
      "scripts/verify-local-pilot.mjs",
    ]),
    prototypeBaseline: Object.freeze(["packages/test-fixtures/prototype/baseline.json", ...prototype]),
  });
}

function databaseUrl(identity, material) {
  return `postgres://learning_orbit:${encodeURIComponent(material.postgresPassword)}@127.0.0.1:55432/${identity.databaseName}`;
}

function probe({ protocol, path, certificate }) {
  return new Promise((resolvePromise) => {
    const request = (protocol === "https:" ? httpsRequest : httpRequest)({
      protocol,
      hostname: "127.0.0.1",
      port: protocol === "https:" ? 3000 : 3001,
      path,
      method: "GET",
      headers: { accept: "text/html,application/json" },
      timeout: 3_000,
      ...(protocol === "https:" ? { ca: certificate, rejectUnauthorized: true } : {}),
    }, (response) => {
      const ready = Number.isSafeInteger(response.statusCode)
        && response.statusCode >= 200 && response.statusCode < 500;
      response.resume();
      resolvePromise(ready);
    });
    request.once("timeout", () => { request.destroy(); resolvePromise(false); });
    request.once("error", () => resolvePromise(false));
    request.end();
  });
}

function makeReceipt(workflow, snapshot, state) {
  const cleanupStatus = workflow.cleanup.every(({ status }) => status === "passed") ? "passed" : "failed";
  const runtimes = Object.freeze({
    node: snapshot.node,
    nodeBinarySha256: snapshot.nodeBinarySha256,
    pnpm: snapshot.pnpm,
    pnpmBinarySha256: snapshot.pnpmBinarySha256,
    pnpmCliSha256: snapshot.pnpmCliSha256,
    python: snapshot.python,
    pythonBinarySha256: snapshot.pythonBinarySha256,
    openssl: snapshot.openssl,
    compose: snapshot.compose,
    docker: snapshot.dockerServer,
    playwright: snapshot.playwright,
    chromiumRevision: snapshot.chromiumRevision,
    chromium: snapshot.chromiumVersion,
    postgresMajor: state.postgres?.major ?? null,
  });
  const gates = (state.gates ?? []).map((gate) => Object.freeze({
    ...gate,
    sourceSha: snapshot.sha,
    runtimes,
    hashes: state.hashes,
    cleanupStatus,
  }));
  const cleanup = workflow.cleanup.map((entry) => Object.freeze({
    ...entry,
    ...(state.cleanupEvidence?.[entry.id]?.snapshot() ?? { checks: [], commands: [] }),
  }));
  return Object.freeze({
    schemaVersion: 1,
    runId: workflow.runId,
    sourceSha: workflow.sourceSha,
    checkout: snapshot.checkout,
    status: workflow.status,
    failureCode: workflow.failureCode,
    startedAt: workflow.startedAt,
    endedAt: workflow.endedAt,
    runtimes,
    hashes: state.hashes,
    stages: workflow.stages.map((stage) => Object.freeze({
      ...stage,
      ...(state.stageEvidence?.[stage.id]?.snapshot() ?? { checks: [], commands: [] }),
    })),
    gates,
    cleanup,
    noSkipCount: gates.every((gate) => Number.isSafeInteger(gate.noSkipCount))
      ? gates.reduce((sum, gate) => sum + gate.noSkipCount, 0)
      : null,
  });
}

async function main() {
  const baseEnvironment = process.env;
  const nodePath = process.execPath;
  const pnpmPath = await resolveExecutableFromPath("pnpm", baseEnvironment.PATH ?? "");
  const sourcePythonPath = resolve(repository, ".venv/bin/python");
  const dockerPath = await resolveExecutableFromPath("docker", baseEnvironment.PATH ?? "");
  const commandEnvironment = closedBaseEnvironment(baseEnvironment, nodePath, pnpmPath);
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const state = {
    gates: [],
    stageEvidence: Object.create(null),
    cleanupEvidence: Object.create(null),
  };
  const registerCleanup = (cleanup, id, work) => {
    const evidence = createLocalPilotEvidenceRecorder({ id });
    state.cleanupEvidence[id] = evidence;
    cleanup.register(id, () => work(evidence));
  };
  let snapshot;
  let workflow;
  try {
    const operationImplementations = {
      "disposable-worktree": async ({ identity, cleanup, evidence }) => {
        state.identity = identity;
        registerCleanup(cleanup, "final-state", async (cleanupEvidence) => {
          const runDocker = (argv) => execute(dockerPath, argv, {
            cwd: repository,
            env: commandEnvironment,
            code: "LOCAL_PILOT_COMPOSE_RESIDUE_CHECK_FAILED",
            capture: true,
            evidence: cleanupEvidence,
          });
          await cleanupEvidence.runCheck("compose-residue-absent", () => (
            assertComposeProjectAbsent({ identity, runDocker })
          ));
          await cleanupEvidence.runCheck("temporary-material-absent", async () => {
            for (const path of [
              state.worktree?.runDirectory,
              state.material?.directory,
              state.tls?.directory,
            ].filter(Boolean)) {
              try {
                await lstat(path);
                throw new Error("LOCAL_PILOT_TEMP_RESIDUE");
              } catch (error) {
                if (error?.code !== "ENOENT") throw error;
              }
            }
          });
          await cleanupEvidence.runCheck("repository-final-state", () => (
            assertFinalRepositoryState({
              repository,
              sourceSha: identity.sourceSha,
              expectedHashes: state.hashes,
              evidenceSet: state.evidenceSet,
              runGit: (argv) => execute("git", [
                "-c", "core.hooksPath=/dev/null", "-C", repository, ...argv,
              ], {
                cwd: repository,
                env: commandEnvironment,
                code: "LOCAL_PILOT_FINAL_GIT_CHECK_FAILED",
                capture: true,
                evidence: cleanupEvidence,
              }),
            })
          ));
        });
        const tls = await evidence.runCheck("tls-material", () => createLocalTlsMaterial({
          parentDirectory: snapshot.tempRoot,
          runId: identity.runId,
          commandEvidence: evidence,
        }));
        state.tls = tls;
        registerCleanup(cleanup, "tls-material", (cleanupEvidence) => (
          cleanupEvidence.runCheck("remove-tls-material", () => (
            removeLocalTlsMaterial(tls, snapshot.tempRoot)
          ))
        ));
        const material = await evidence.runCheck("runtime-material", () => (
          createRuntimeMaterial({ parentDirectory: snapshot.tempRoot, identity })
        ));
        state.material = material;
        registerCleanup(cleanup, "runtime-material", (cleanupEvidence) => (
          cleanupEvidence.runCheck("remove-runtime-material", () => removeRuntimeMaterial({
            material,
            parentDirectory: snapshot.tempRoot,
            identity,
          }))
        ));
        const worktree = await evidence.runCheck("detached-worktree", () => (
          createDetachedPilotWorktree({
            sourceRepository: repository,
            targetParent: snapshot.tempRoot,
            identity,
            commandEvidence: evidence,
          })
        ));
        state.worktree = worktree;
        registerCleanup(cleanup, "disposable-worktree", (cleanupEvidence) => (
          cleanupEvidence.runCheck("remove-detached-worktree", () => removeDetachedPilotWorktree({
            sourceRepository: repository,
            targetParent: snapshot.tempRoot,
            owned: worktree,
            identity,
            commandEvidence: cleanupEvidence,
          }))
        ));
      },
      "frozen-dependencies": async ({ evidence }) => {
        const checkout = state.worktree.worktreePath;
        await evidence.runCheck("pnpm-frozen-lock", () => execute(pnpmPath, ["install", "--frozen-lockfile"], {
          cwd: checkout,
          env: commandEnvironment,
          code: "LOCAL_PILOT_PNPM_INSTALL_FAILED",
          signal: abort.signal,
          evidence,
        }));
        await evidence.runCheck("python-venv", () => execute(
          sourcePythonPath,
          ["-m", "venv", resolve(checkout, ".venv")],
          {
            cwd: checkout,
            env: commandEnvironment,
            code: "LOCAL_PILOT_PYTHON_VENV_FAILED",
            signal: abort.signal,
            evidence,
          },
        ));
        const python = resolve(checkout, ".venv/bin/python");
        await evidence.runCheck("python-hash-lock", () => execute(python, [
          "-m", "pip", "install", "--disable-pip-version-check", "--no-input",
          "--require-hashes", "-r", workerLockRelative,
        ], {
          cwd: checkout,
          env: commandEnvironment,
          code: "LOCAL_PILOT_PYTHON_INSTALL_FAILED",
          signal: abort.signal,
          evidence,
        }));
        state.python = python;
      },
      "isolated-postgres": async ({ identity, cleanup, evidence }) => {
        const checkout = state.worktree.worktreePath;
        const composeFile = resolve(checkout, composeRelative);
        const composeEnvironment = buildComposeEnvironment({
          identity,
          password: state.material.postgresPassword,
          inheritedEnv: commandEnvironment,
        });
        const runDocker = (argv) => execute(dockerPath, argv, {
          cwd: checkout,
          env: composeEnvironment,
          code: "LOCAL_PILOT_DOCKER_COMMAND_FAILED",
          signal: abort.signal,
          capture: true,
          evidence,
        });
        await evidence.runCheck("compose-project-absent", () => (
          assertComposeProjectAbsent({ identity, runDocker })
        ));
        await evidence.runCheck("compose-config", () => execute(
          dockerPath,
          [...buildComposeArgv({ identity, composeFile, operation: "config" }), "--quiet"],
          {
            cwd: checkout,
            env: composeEnvironment,
            code: "LOCAL_PILOT_COMPOSE_CONFIG_FAILED",
            signal: abort.signal,
            evidence,
          },
        ));
        const marker = JSON.parse(await readFile(state.worktree.markerPath, "utf8"));
        // Register cleanup before `up`: Docker Compose may create a network,
        // volume, or one healthy container and then return a non-zero status.
        // Teardown re-discovers the exact random project and derives its down
        // capability only when every discovered resource still carries this
        // run's labels and marker tuple.
        registerCleanup(cleanup, "compose-project", async (cleanupEvidence) => {
          const cleanupRunDocker = (argv) => execute(dockerPath, argv, {
            cwd: checkout,
            env: composeEnvironment,
            code: "LOCAL_PILOT_COMPOSE_CLEANUP_FAILED",
            capture: true,
            evidence: cleanupEvidence,
          });
          const currentMarker = JSON.parse(await readFile(state.worktree.markerPath, "utf8"));
          const cleanupOwnership = await cleanupEvidence.runCheck(
            "compose-cleanup-ownership",
            () => inspectComposeCleanupOwnership({
              identity,
              marker: currentMarker,
              composeFile,
              runDocker: cleanupRunDocker,
            }),
          );
          if (cleanupOwnership) {
            await cleanupEvidence.runCheck("compose-down", () => execute(
              dockerPath,
              buildComposeArgv({
                identity,
                composeFile,
                operation: "down",
                ownership: cleanupOwnership,
              }),
              {
                cwd: checkout,
                env: composeEnvironment,
                code: "LOCAL_PILOT_COMPOSE_CLEANUP_FAILED",
                timeoutMs: 60_000,
                evidence: cleanupEvidence,
              },
            ));
          }
          await cleanupEvidence.runCheck("compose-project-absent", () => (
            assertComposeProjectAbsent({ identity, runDocker: cleanupRunDocker })
          ));
        });
        await evidence.runCheck("compose-up", () => execute(
          dockerPath,
          buildComposeArgv({ identity, composeFile, operation: "up" }),
          {
            cwd: checkout,
            env: composeEnvironment,
            code: "LOCAL_PILOT_COMPOSE_UP_FAILED",
            signal: abort.signal,
            evidence,
          },
        ));
        const ownership = await evidence.runCheck("compose-ownership", () => (
          inspectComposeOwnership({ identity, marker, composeFile, runDocker })
        ));
        state.compose = { composeFile, composeEnvironment, marker, ownership };
        const postgresVersion = await evidence.runCheck("postgres-18", () => execute(dockerPath, [
          "compose", "--project-name", identity.composeProject, "--file", composeFile,
          "exec", "--no-TTY", "postgres", "psql", "-U", "learning_orbit", "-d",
          identity.databaseName, "-Atqc", "SHOW server_version_num",
        ], {
          cwd: checkout,
          env: composeEnvironment,
          code: "LOCAL_PILOT_POSTGRES_VERSION_CHECK_FAILED",
          signal: abort.signal,
          capture: true,
          evidence,
        }));
        state.postgres = assertPostgres18(postgresVersion.stdout);
        state.databaseUrl = databaseUrl(identity, state.material);
        state.mailpit = new MailpitClient();
        await evidence.runCheck("mailpit-ready", () => state.mailpit.assertReady());
      },
      "repository-foundations": async ({ evidence }) => {
        const checkout = state.worktree.worktreePath;
        const common = {
          ...commandEnvironment,
          PYTHONPATH: resolve(checkout, "services/worker/src"),
        };
        for (const [checkId, executable, argv, code] of [
          ["layout", nodePath, ["scripts/verify-layout.mjs"], "LOCAL_PILOT_LAYOUT_FAILED"],
          ["root-scripts", nodePath, ["scripts/assert-root-scripts.mjs"], "LOCAL_PILOT_ROOT_SCRIPTS_FAILED"],
          ["python-lock", nodePath, ["scripts/verify-python-lock.mjs"], "LOCAL_PILOT_PYTHON_LOCK_FAILED"],
          ["demo-baseline", nodePath, ["scripts/assert-baseline.mjs"], "LOCAL_PILOT_DEMO_BASELINE_FAILED"],
          ["contract-generation", pnpmPath, ["contracts:generate"], "LOCAL_PILOT_CONTRACT_GENERATION_FAILED"],
        ]) {
          await evidence.runCheck(checkId, () => execute(executable, argv, {
            cwd: checkout,
            env: common,
            code,
            signal: abort.signal,
            evidence,
          }));
        }
        await evidence.runCheck("generated-drift", async () => {
          const generatedDiff = await execute("git", [
            "-c", "core.hooksPath=/dev/null", "-C", checkout, "status", "--porcelain=v1", "-z",
            "--untracked-files=all",
          ], {
            cwd: checkout,
            env: common,
            code: "LOCAL_PILOT_GENERATED_DIFF_CHECK_FAILED",
            signal: abort.signal,
            capture: true,
            evidence,
          });
          if (generatedDiff.stdout !== "") throw new Error("LOCAL_PILOT_GENERATED_DRIFT");
        });
      },
      "production-builds": async ({ evidence }) => {
        const checkout = state.worktree.worktreePath;
        const environment = {
          ...commandEnvironment,
          PYTHONPATH: resolve(checkout, "services/worker/src"),
        };
        await evidence.runCheck("typescript", () => execute(pnpmPath, ["typecheck"], {
          cwd: checkout,
          env: environment,
          code: "LOCAL_PILOT_TYPECHECK_FAILED",
          signal: abort.signal,
          evidence,
        }));
        await evidence.runCheck("production-build", () => execute(pnpmPath, ["build"], {
          cwd: checkout,
          env: environment,
          code: "LOCAL_PILOT_BUILD_FAILED",
          signal: abort.signal,
          evidence,
        }));
        await evidence.runCheck("worker-compile", () => execute(
          state.python,
          ["-m", "compileall", "-q", "services/worker/src"],
          {
            cwd: checkout,
            env: environment,
            code: "LOCAL_PILOT_WORKER_BUILD_FAILED",
            signal: abort.signal,
            evidence,
          },
        ));
        await evidence.runCheck("worker-import", () => execute(
          state.python,
          ["-c", "import learning_orbit_worker.main"],
          {
            cwd: checkout,
            env: environment,
            code: "LOCAL_PILOT_WORKER_IMPORT_FAILED",
            signal: abort.signal,
            evidence,
          },
        ));
      },
      "required-tests": async ({ evidence }) => {
        const checkout = state.worktree.worktreePath;
        const common = {
          ...commandEnvironment,
          DATABASE_URL: state.databaseUrl,
          TEST_DATABASE_URL: state.databaseUrl,
          LO_MIGRATION_ENV: "test",
          PYTHONPATH: resolve(checkout, "services/worker/src"),
        };
        // Migration is the only necessary dependency before the PostgreSQL
        // integration suites.  Typecheck and every production build have
        // already passed at this exact SHA before any test result is accepted.
        await evidence.runCheck("migration", () => execute(pnpmPath, ["db:migrate:test"], {
          cwd: checkout,
          env: common,
          code: "LOCAL_PILOT_MIGRATION_FAILED",
          signal: abort.signal,
          evidence,
        }));
        await evidence.runCheck("required-gate-set", async () => {
          await executeRequiredGateSet({
            manifest: state.manifest,
            gateIds: [
              "contracts-vitest", "server-vitest", "web-vitest", "pilot-harness-vitest",
            ],
            checkout,
            pnpmPath,
            pythonPath: state.python,
            environment: common,
            recordReceipt: async (receipt) => { state.gates.push(receipt); },
            signal: abort.signal,
          });
          await executeRequiredGateSet({
            manifest: state.manifest,
            gateIds: ["worker-python"],
            checkout,
            pnpmPath,
            pythonPath: state.python,
            environment: {
              ...common,
              LO_ANALYTICS_PSEUDONYM_KEY: state.material.analyticsPseudonymKey,
            },
            recordReceipt: async (receipt) => { state.gates.push(receipt); },
            signal: abort.signal,
          });
        });
      },
      "application-startup": async ({ identity, cleanup, evidence }) => {
        const checkout = state.worktree.worktreePath;
        const recipient = `pilot-${identity.runId}@example.invalid`;
        state.recipient = recipient;
        registerCleanup(cleanup, "mailpit-residual", async (cleanupEvidence) => {
          await cleanupEvidence.runCheck("delete-recipient-messages", () => (
            state.mailpit.deleteRecipientMessages(recipient)
          ));
          await cleanupEvidence.runCheck("recipient-empty", () => (
            state.mailpit.assertRecipientEmpty(recipient)
          ));
        });
        const childEnvironments = buildChildEnvironments({
          material: state.material,
          databaseUrl: state.databaseUrl,
          baseEnvironment: commandEnvironment,
        });
        const environments = {
          server: childEnvironments.server,
          worker: {
            ...childEnvironments.worker,
            PYTHONPATH: resolve(checkout, "services/worker/src"),
          },
          next: childEnvironments.next,
        };
        const processes = new OwnedProcessSet({ commandEvidence: evidence });
        state.processes = processes;
        const specs = buildLocalProcessSpecs({
          checkout,
          nodePath,
          pythonPath: state.python,
          tls: state.tls,
          environments,
        });
        await evidence.runCheck("application-processes", async () => {
          registerCleanup(cleanup, "application-processes", (cleanupEvidence) => (
            cleanupEvidence.runCheck("stop-processes", () => processes.stopAll())
          ));
          specs.forEach((spec) => processes.start(spec));
        });
        const certificate = await readFile(state.tls.certificatePath);
        await evidence.runCheck("fastify-ready", () => waitForReadiness({
          name: "fastify",
          timeoutMs: 60_000,
          intervalMs: 250,
          probe: async () => {
            processes.assertRunning();
            return probe({ protocol: "http:", path: "/v1/auth/session" });
          },
        }));
        await evidence.runCheck("next-https-ready", () => waitForReadiness({
          name: "next",
          timeoutMs: 60_000,
          intervalMs: 250,
          probe: async () => {
            processes.assertRunning();
            return probe({ protocol: "https:", path: "/login", certificate });
          },
        }));
        processes.assertRunning();
        await evidence.runCheck("mailpit-ready", () => state.mailpit.assertReady());
      },
      "browser-verification": async ({ evidence }) => {
        state.processes.assertRunning();
        const checkout = state.worktree.worktreePath;
        await evidence.runCheck("playwright-required-gate", () => executeRequiredGateSet({
          manifest: state.manifest,
          gateIds: ["browser-playwright"],
          checkout,
          pnpmPath,
          pythonPath: state.python,
          environment: {
            ...commandEnvironment,
            DATABASE_URL: state.databaseUrl,
            TEST_DATABASE_URL: state.databaseUrl,
            LO_PUBLIC_BASE_ORIGIN: "https://127.0.0.1:3000",
            LO_PILOT_TEACHER_ADDRESS: state.recipient,
            PYTHONPATH: resolve(checkout, "services/worker/src"),
          },
          recordReceipt: async (receipt) => { state.gates.push(receipt); },
          signal: abort.signal,
        }));
      },
      "pilot-load": async ({ evidence }) => {
        state.processes.assertRunning();
        const checkout = state.worktree.worktreePath;
        await evidence.runCheck("controlled-10x5-load", () => executeRequiredGateSet({
          manifest: state.manifest,
          gateIds: ["pilot-load"],
          checkout,
          pnpmPath,
          pythonPath: state.python,
          environment: {
            ...commandEnvironment,
            DATABASE_URL: state.databaseUrl,
            TEST_DATABASE_URL: state.databaseUrl,
            LO_PUBLIC_BASE_ORIGIN: "https://127.0.0.1:3000",
            LO_PILOT_TLS_CA_FILE: state.tls.certificatePath,
          },
          recordReceipt: async (receipt) => { state.gates.push(receipt); },
          signal: abort.signal,
        }));
      },
      "manifest-verification": async ({ evidence }) => {
        const checkout = state.worktree.worktreePath;
        await evidence.runCheck("closed-summary-set", () => execute(nodePath, [
          "scripts/local-pilot/verify-required-test-summaries.mjs",
          "--manifest", manifestRelative,
        ], {
          cwd: checkout,
          env: commandEnvironment,
          code: "REQUIRED_TEST_VERIFICATION_FAILED",
          signal: abort.signal,
          evidence,
        }));
      },
    };
    const operations = Object.fromEntries(Object.entries(operationImplementations).map(
      ([stageId, operation]) => [stageId, async (context) => {
        const evidence = createLocalPilotEvidenceRecorder({ id: stageId });
        state.stageEvidence[stageId] = evidence;
        return operation(Object.freeze({ ...context, evidence }));
      }],
    ));

    workflow = await runLocalPilotOrchestrator({
      preflight: async () => {
        snapshot = await captureLocalPilotPreflight({
          repository,
          nodePath,
          pnpmPath,
          pythonPath: sourcePythonPath,
          dockerPath,
          baseEnvironment,
        });
        const [workerLock, composeSource, manifestSource, packageSource] = await Promise.all([
          readFile(resolve(repository, workerLockRelative), "utf8"),
          readFile(resolve(repository, composeRelative), "utf8"),
          readFile(resolve(repository, manifestRelative), "utf8"),
          readFile(resolve(repository, "package.json"), "utf8"),
        ]);
        assertPythonLockMinor(workerLock);
        assertInfrastructurePins(composeSource);
        try {
          state.manifest = assertRequiredGateOrder(JSON.parse(manifestSource));
          assertRequiredGateEntrypoints(state.manifest, JSON.parse(packageSource));
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("REQUIRED_TEST_")) throw error;
          throw new Error("REQUIRED_TEST_MANIFEST_READ_FAILED");
        }
        state.evidenceSet = await evidenceSet(repository);
        state.hashes = await hashEvidenceSet(repository, state.evidenceSet);
        return snapshot;
      },
      runId: () => randomBytes(8).toString("hex"),
      creatorPid: process.pid,
      operations,
    });
  } catch (error) {
    workflow = error?.receipt;
    if (!workflow || !snapshot || !state.hashes) {
      throw new Error(stableCode(error, "LOCAL_PILOT_FAILED"));
    }
    const receipt = makeReceipt(workflow, snapshot, state);
    await writeLocalPilotReceipt({ repository, receipt });
    throw new Error(stableCode(error, "LOCAL_PILOT_FAILED"));
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  const receipt = makeReceipt(workflow, snapshot, state);
  await writeLocalPilotReceipt({ repository, receipt });
  process.stdout.write(`verify:local-pilot: PASS sha=${snapshot.sha}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${stableCode(error, "LOCAL_PILOT_FAILED")}\n`);
  process.exitCode = 1;
}
