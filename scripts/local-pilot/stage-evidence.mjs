import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";

const ID = /^[a-z][a-z0-9-]{0,63}$/;

function fail(code) {
  throw new Error(code);
}

function stableCode(error, fallback) {
  const message = error instanceof Error ? error.message : "";
  return /^((?:LOCAL_PILOT|REQUIRED_TEST|MAILPIT)_[A-Z0-9_]+)/.exec(message)?.[1] ?? fallback;
}

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) {
    fail("LOCAL_PILOT_EVIDENCE_CLOCK_INVALID");
  }
  return value.toISOString();
}

function sanitizeArgument(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192
    || value.includes("\u0000")
    || /(?:[?&](?:token|cookie|password|secret)=|postgres(?:ql)?:\/\/|--(?:token|cookie|password|secret)=)/i.test(value)) {
    fail("LOCAL_PILOT_COMMAND_EVIDENCE_INVALID");
  }
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) fail("LOCAL_PILOT_COMMAND_EVIDENCE_INVALID");
  } catch (error) {
    if (error instanceof Error && error.message === "LOCAL_PILOT_COMMAND_EVIDENCE_INVALID") {
      throw error;
    }
  }
  return isAbsolute(value) ? `<absolute:${basename(value)}>` : value;
}

function outputSha256(stdout, stderr) {
  const first = typeof stdout === "string" ? stdout : "";
  const second = typeof stderr === "string" ? stderr : "";
  const firstLength = Buffer.alloc(8);
  firstLength.writeBigUInt64BE(BigInt(Buffer.byteLength(first, "utf8")));
  return createHash("sha256")
    .update(firstLength)
    .update(first)
    .update(second)
    .digest("hex");
}

function sanitizedCommand(executable, argv) {
  if (typeof executable !== "string" || executable.length === 0
    || executable.length > 8_192 || executable.includes("\u0000")
    || !Array.isArray(argv) || argv.length > 256) {
    fail("LOCAL_PILOT_COMMAND_EVIDENCE_INVALID");
  }
  return Object.freeze([basename(executable), ...argv.map(sanitizeArgument)]);
}

export function createLocalPilotEvidenceRecorder({ id, now = () => new Date() }) {
  if (!ID.test(id ?? "") || typeof now !== "function") {
    fail("LOCAL_PILOT_EVIDENCE_RECORDER_INVALID");
  }
  const checks = [];
  const commands = [];
  const observedChecks = new Set();

  return Object.freeze({
    assertCommand({ executable, argv }) {
      return sanitizedCommand(executable, argv);
    },

    async runCheck(checkId, operation) {
      if (!ID.test(checkId ?? "") || observedChecks.has(checkId)
        || typeof operation !== "function") {
        fail("LOCAL_PILOT_EVIDENCE_CHECK_INVALID");
      }
      observedChecks.add(checkId);
      const startedAt = timestamp(now);
      try {
        const value = await operation();
        checks.push(Object.freeze({
          id: checkId,
          status: "passed",
          failureCode: null,
          startedAt,
          endedAt: timestamp(now),
        }));
        return value;
      } catch (error) {
        checks.push(Object.freeze({
          id: checkId,
          status: "failed",
          failureCode: stableCode(error, "LOCAL_PILOT_CHECK_FAILED"),
          startedAt,
          endedAt: timestamp(now),
        }));
        throw error;
      }
    },

    recordCommand({ executable, argv, exitCode, startedAt, endedAt, stdout, stderr }) {
      if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255
        || typeof startedAt !== "string" || typeof endedAt !== "string"
        || !Number.isSafeInteger(Date.parse(startedAt)) || !Number.isSafeInteger(Date.parse(endedAt))) {
        fail("LOCAL_PILOT_COMMAND_EVIDENCE_INVALID");
      }
      const sanitizedArgv = sanitizedCommand(executable, argv);
      commands.push(Object.freeze({
        argv: Object.freeze(sanitizedArgv),
        exitCode,
        startedAt,
        endedAt,
        outputSha256: outputSha256(stdout, stderr),
      }));
    },

    snapshot() {
      return Object.freeze({
        checks: Object.freeze([...checks]),
        commands: Object.freeze([...commands]),
      });
    },
  });
}
