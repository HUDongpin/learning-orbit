import { buildRunIdentity } from "./ownership.mjs";
import { CleanupStack, runLocalPilotWorkflow } from "./workflow.mjs";

export const POST_PREFLIGHT_STAGE_ORDER = Object.freeze([
  "disposable-worktree",
  "frozen-dependencies",
  "isolated-postgres",
  "repository-foundations",
  "production-builds",
  "required-tests",
  "application-startup",
  "browser-verification",
  "pilot-load",
  "manifest-verification",
]);

function stableCode(error, fallback) {
  const message = error instanceof Error ? error.message : "";
  return /^((?:LOCAL_PILOT|REQUIRED_TEST)_[A-Z0-9_]+)/.exec(message)?.[1] ?? fallback;
}

function validateOperations(operations) {
  if (!operations || typeof operations !== "object" || Array.isArray(operations)) {
    throw new Error("LOCAL_PILOT_STAGE_PLAN_INVALID");
  }
  const keys = Object.keys(operations);
  if (keys.length !== POST_PREFLIGHT_STAGE_ORDER.length
    || POST_PREFLIGHT_STAGE_ORDER.some((id) => typeof operations[id] !== "function")
    || keys.some((id) => !POST_PREFLIGHT_STAGE_ORDER.includes(id))) {
    throw new Error("LOCAL_PILOT_STAGE_PLAN_INVALID");
  }
  return operations;
}

export async function runLocalPilotOrchestrator({
  preflight,
  runId,
  creatorPid,
  operations,
  now = () => new Date(),
}) {
  if (typeof preflight !== "function" || typeof runId !== "function"
    || typeof now !== "function") {
    throw new Error("LOCAL_PILOT_ORCHESTRATOR_CONFIG_INVALID");
  }
  validateOperations(operations);
  let snapshot;
  try {
    snapshot = await preflight();
  } catch (error) {
    throw new Error(stableCode(error, "LOCAL_PILOT_PREFLIGHT_FAILED"));
  }
  let identity;
  try {
    identity = buildRunIdentity({
      runId: runId(),
      sourceSha: snapshot?.sha,
      creatorPid,
    });
  } catch {
    throw new Error("LOCAL_PILOT_IDENTITY_INVALID");
  }
  const cleanup = new CleanupStack();
  const state = Object.create(null);
  const context = Object.freeze({ snapshot, identity, cleanup, state });
  const stages = POST_PREFLIGHT_STAGE_ORDER.map((id) => ({
    id,
    run: () => operations[id](context),
  }));
  return runLocalPilotWorkflow({
    runId: identity.runId,
    sourceSha: identity.sourceSha,
    stages,
    cleanup,
    now,
  });
}
