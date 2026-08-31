const ID = /^[a-z][a-z0-9-]{0,63}$/;
const RUN_ID = /^[0-9a-f]{16}$/;
const SHA = /^[0-9a-f]{40}$/;

function stableCode(error, fallback) {
  const message = error instanceof Error ? error.message : "";
  const match = /^((?:LOCAL_PILOT|REQUIRED_TEST|MAILPIT)_[A-Z0-9_]+)/.exec(message);
  return match?.[1] ?? fallback;
}

export class LocalPilotFailure extends Error {
  constructor(code, receipt) {
    super(code);
    this.name = "LocalPilotFailure";
    this.code = code;
    this.receipt = receipt;
  }
}

export class CleanupStack {
  #entries = [];
  #ran = false;

  register(id, cleanup, options = {}) {
    const requiresIfRegistered = options?.requiresIfRegistered ?? [];
    if (this.#ran || !ID.test(id) || typeof cleanup !== "function"
      || !options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => key !== "requiresIfRegistered")
      || !Array.isArray(requiresIfRegistered) || requiresIfRegistered.some((requiredId) => (
        !ID.test(requiredId) || requiredId === id
      )) || new Set(requiresIfRegistered).size !== requiresIfRegistered.length
      || this.#entries.some((entry) => entry.id === id)) {
      throw new Error("LOCAL_PILOT_CLEANUP_REGISTRATION_INVALID");
    }
    this.#entries.push(Object.freeze({
      id,
      cleanup,
      requiresIfRegistered: Object.freeze([...requiresIfRegistered]),
    }));
  }

  async run() {
    if (this.#ran) throw new Error("LOCAL_PILOT_CLEANUP_ALREADY_RAN");
    this.#ran = true;
    const receipts = [];
    const completed = new Map();
    const registered = new Set(this.#entries.map(({ id }) => id));
    for (const entry of [...this.#entries].reverse()) {
      let status = "passed";
      let failureCode = null;
      if (entry.requiresIfRegistered.some((requiredId) => (
        registered.has(requiredId) && completed.get(requiredId) !== "passed"
      ))) {
        status = "failed";
        failureCode = "LOCAL_PILOT_CLEANUP_DEPENDENCY_FAILED";
      } else {
        try {
          await entry.cleanup();
        } catch (error) {
          status = "failed";
          failureCode = stableCode(error, "LOCAL_PILOT_CLEANUP_ACTION_FAILED");
        }
      }
      completed.set(entry.id, status);
      receipts.push(Object.freeze({ id: entry.id, status, failureCode }));
    }
    return Object.freeze(receipts);
  }
}

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) {
    throw new Error("LOCAL_PILOT_WORKFLOW_INVALID");
  }
  return value.toISOString();
}

export async function runLocalPilotWorkflow({
  runId,
  sourceSha,
  stages,
  cleanup,
  now = () => new Date(),
}) {
  if (!RUN_ID.test(runId) || !SHA.test(sourceSha) || !Array.isArray(stages)
    || stages.length === 0 || !(cleanup instanceof CleanupStack) || typeof now !== "function"
    || stages.some((stage) => !stage || !ID.test(stage.id) || typeof stage.run !== "function")
    || new Set(stages.map(({ id }) => id)).size !== stages.length) {
    throw new LocalPilotFailure("LOCAL_PILOT_WORKFLOW_INVALID", undefined);
  }
  const startedAt = timestamp(now);
  const stageReceipts = [];
  let failureCode;
  for (const stage of stages) {
    const stageStartedAt = timestamp(now);
    try {
      await stage.run();
      stageReceipts.push(Object.freeze({
        id: stage.id,
        status: "passed",
        startedAt: stageStartedAt,
        endedAt: timestamp(now),
      }));
    } catch (error) {
      failureCode = stableCode(error, "LOCAL_PILOT_STAGE_FAILED");
      stageReceipts.push(Object.freeze({
        id: stage.id,
        status: "failed",
        startedAt: stageStartedAt,
        endedAt: timestamp(now),
      }));
      break;
    }
  }
  const cleanupReceipts = await cleanup.run();
  if (cleanupReceipts.some(({ status }) => status !== "passed")) {
    failureCode ??= "LOCAL_PILOT_CLEANUP_FAILED";
  }
  const receipt = Object.freeze({
    schemaVersion: 1,
    runId,
    sourceSha,
    status: failureCode ? "failed" : "passed",
    failureCode: failureCode ?? null,
    startedAt,
    endedAt: timestamp(now),
    stages: Object.freeze(stageReceipts),
    cleanup: cleanupReceipts,
  });
  if (failureCode) throw new LocalPilotFailure(failureCode, receipt);
  return receipt;
}
