/**
 * Allow-list-first log redaction.
 *
 * Observability is useful only when it cannot become a second content store.
 * Values outside the small operational allow-list are replaced before they
 * reach a logger/exporter.  The function intentionally does not stringify or
 * inspect nested objects: treating an object as content is safer than walking
 * it and accidentally preserving a prompt, transcript, URL, or secret.
 */

const SAFE_KEYS = new Set([
  "service",
  "environment",
  "roomId",
  "eventId",
  "roomSeq",
  "commandId",
  "jobId",
  "correlationId",
  "agentRunId",
  "projectionVersion",
  "completeThroughRoomSeq",
  "failureCode",
  "durationMs",
]);

const MAX_SAFE_STRING = 256;

function safeValue(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, MAX_SAFE_STRING);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || value === null) return value;
  return "[REDACTED_CONTENT]";
}

/** Redact one structured log record without mutating the caller's object. */
export function redactLog(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SAFE_KEYS.has(key)) {
      result[key] = safeValue(value);
    } else if (/url/i.test(key)) {
      result[key] = "[REDACTED_URL]";
    } else if (/secret|token|key|cookie|authorization|password|credential/i.test(key)) {
      result[key] = "[REDACTED_SECRET]";
    } else {
      result[key] = "[REDACTED_CONTENT]";
    }
  }
  return result;
}

export type SafeLogRecord = ReturnType<typeof redactLog>;

/** Convenience helper for error paths; stack/message are never exported. */
export function redactError(error: unknown, metadata: Record<string, unknown> = {}): SafeLogRecord {
  return redactLog({ ...metadata, failureCode: error instanceof Error ? error.name : "UNKNOWN_ERROR" });
}

