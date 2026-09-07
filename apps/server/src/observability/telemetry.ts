import { redactLog, type SafeLogRecord } from "./redaction.js";

export type TelemetrySpanRecord = Readonly<{
  name: string;
  attributes: SafeLogRecord;
  startedAt: number;
  endedAt: number;
}>;

export interface TelemetrySink {
  emit(span: TelemetrySpanRecord): void;
}

/** A deterministic sink used by unit tests and local pilot diagnostics. */
export class InMemoryTelemetry implements TelemetrySink {
  readonly spans: TelemetrySpanRecord[] = [];
  fail = false;

  emit(span: TelemetrySpanRecord): void {
    if (this.fail) throw new Error("TELEMETRY_SINK_UNAVAILABLE");
    this.spans.push(span);
  }
}

export interface SpanHandle {
  /**
   * `extraAttributes` exists because the identifier that makes a span useful —
   * the correlation id — is assigned by the database commit, i.e. after the
   * span has already started.  Naming it at `end` keeps the measured duration
   * honest without having to guess the id up front.
   */
  end(durationMs?: number, extraAttributes?: Record<string, unknown>): void;
}

export interface Telemetry {
  readonly exporterFailureCount: number;
  readonly failureReports: number;
  startSpan(name: string, attributes?: Record<string, unknown>): SpanHandle;
  record(name: string, attributes?: Record<string, unknown>): void;
}

export interface TelemetryOptions {
  sink?: TelemetrySink;
  now?: () => number;
  maxFailureReports?: number;
}

const defaultSink: TelemetrySink = { emit: () => undefined };

/**
 * Create a bounded, failure-tolerant telemetry facade.  Export failure never
 * blocks a classroom write and failure notices are capped to avoid a logging
 * feedback loop.  All attributes pass through the same allow-list redactor as
 * structured logs, so spans cannot become a content or secret side channel.
 */
export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? Date.now;
  const maxFailureReports = Math.max(0, Math.floor(options.maxFailureReports ?? 8));
  let exporterFailureCount = 0;
  let failureReports = 0;

  function emit(span: TelemetrySpanRecord): void {
    try {
      sink.emit(span);
    } catch {
      exporterFailureCount += 1;
      if (failureReports < maxFailureReports) failureReports += 1;
      // Deliberately swallow exporter errors: classroom writes are the source
      // of truth and must degrade independently from observability.
    }
  }

  return {
    get exporterFailureCount() { return exporterFailureCount; },
    get failureReports() { return failureReports; },
    startSpan(name, attributes = {}) {
      const startedAt = now();
      let ended = false;
      return {
        end(durationMs, extraAttributes) {
          if (ended) return;
          ended = true;
          const safeDuration = Number.isFinite(durationMs) && durationMs !== undefined
            ? Math.max(0, durationMs)
            : Math.max(0, now() - startedAt);
          emit({
            name,
            attributes: redactLog({ ...attributes, ...extraAttributes }),
            startedAt,
            endedAt: startedAt + safeDuration,
          });
        },
      };
    },
    record(name, attributes = {}) {
      const startedAt = now();
      emit({ name, attributes: redactLog(attributes), startedAt, endedAt: startedAt });
    },
  };
}

