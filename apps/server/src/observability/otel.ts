import { context as otelContext, trace, TraceFlags, type Attributes, type Tracer } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader, type IMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { randomBytes } from "node:crypto";

import { createTelemetry, type Telemetry, type TelemetrySink, type TelemetrySpanRecord } from "./telemetry.js";

/**
 * Real OpenTelemetry export for the server runtime.
 *
 * The exporter is installed *behind* the existing telemetry facade rather than
 * alongside it.  Attributes are redacted by `createTelemetry` before this sink
 * ever sees them, so the OTel path is structurally incapable of carrying a
 * message body, prompt, transcript, media URL or credential to a collector —
 * that property does not depend on remembering to redact at each call site.
 *
 * Everything here is bounded and failure-tolerant.  A missing or unreachable
 * collector degrades observability and nothing else: the batch processor drops
 * on a full queue instead of growing, and export errors are counted and
 * rate-limited by the facade rather than thrown at a classroom write.
 */

/** Bounds chosen so a stalled collector costs a fixed, small amount of memory. */
const BOUNDS = Object.freeze({
  maxQueueSize: 2048,
  maxExportBatchSize: 256,
  scheduledDelayMillis: 5_000,
  exportTimeoutMillis: 10_000,
});

const NON_ZERO_HEX = /^(?=.*[1-9a-f])[0-9a-f]{32}$/;

export interface OtelRuntimeOptions {
  readonly serviceName?: string;
  readonly environment?: string;
  /** OTLP/HTTP base origin of the approved collector, e.g. http://collector:4318 */
  readonly endpoint?: string | undefined;
  /** Tests inject `InMemorySpanExporter`; production leaves this unset. */
  readonly spanExporter?: SpanExporter | undefined;
  readonly metricExporter?: PushMetricExporter | undefined;
  readonly now?: (() => number) | undefined;
}

export interface OtelRuntime {
  readonly telemetry: Telemetry;
  /** False when no collector and no injected exporter was configured. */
  readonly enabled: boolean;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Derive the trace id from the pipeline's own correlation id.
 *
 * A correlation id is already a UUID persisted on `room_event` and
 * `worker_job`, which is exactly sixteen bytes — the width of a trace id.  
 * Reusing it means every stage that carries the correlation id joins the same
 * trace without any propagation header, including the Python worker, which
 * reads the id from the row it claimed.  No stage invents a replacement
 * identifier, so a trace cannot silently split at a process boundary.
 */
export function traceIdForCorrelation(correlationId: unknown): string | undefined {
  if (typeof correlationId !== "string") return undefined;
  const hex = correlationId.replaceAll("-", "").toLowerCase();
  return NON_ZERO_HEX.test(hex) ? hex : undefined;
}

function attributesOf(record: TelemetrySpanRecord, base: Attributes): Attributes {
  const attributes: Attributes = { ...base };
  for (const [key, value] of Object.entries(record.attributes)) {
    // `null` is not a legal OTel attribute value; dropping the key is more
    // honest than exporting a placeholder that reads like real data.
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attributes[key] = value;
    }
  }
  return attributes;
}

/** Adapt already-redacted facade spans onto a tracer, joining them by correlation id. */
function otelSink(tracer: Tracer, base: Attributes): TelemetrySink {
  return {
    emit(record: TelemetrySpanRecord): void {
      const attributes = attributesOf(record, base);
      const traceId = traceIdForCorrelation(record.attributes.correlationId);
      let parent = otelContext.active();
      if (traceId) {
        parent = trace.setSpanContext(parent, {
          traceId,
          spanId: randomBytes(8).toString("hex"),
          traceFlags: TraceFlags.SAMPLED,
          isRemote: true,
        });
      }
      const span = tracer.startSpan(record.name, { startTime: record.startedAt, attributes }, parent);
      span.end(record.endedAt);
    },
  };
}

/**
 * Start telemetry export.  Call this before Fastify and plugin construction so
 * startup work is inside the trace, and `shutdown()` on server close/SIGTERM.
 */
export function startOtelRuntime(options: OtelRuntimeOptions = {}): OtelRuntime {
  const serviceName = options.serviceName ?? "learning-orbit-server";
  const environment = options.environment ?? "development";
  const spanExporter = options.spanExporter
    ?? (options.endpoint ? new OTLPTraceExporter({ url: `${options.endpoint}/v1/traces`, timeoutMillis: BOUNDS.exportTimeoutMillis }) : undefined);
  const metricExporter = options.metricExporter
    ?? (options.endpoint ? new OTLPMetricExporter({ url: `${options.endpoint}/v1/metrics`, timeoutMillis: BOUNDS.exportTimeoutMillis }) : undefined);

  if (!spanExporter) {
    // No approved collector configured.  The facade still works; it just has
    // nowhere to export, which is a supported deployment, not a failure.
    const telemetry = createTelemetry(options.now ? { now: options.now } : {});
    return { telemetry, enabled: false, flush: async () => undefined, shutdown: async () => undefined };
  }

  const metricReaders: IMetricReader[] = metricExporter
    ? [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 30_000, exportTimeoutMillis: BOUNDS.exportTimeoutMillis })]
    : [];
  // The providers are built directly instead of through `NodeSDK` because
  // NodeSDK installs itself as the process-global provider.  A global would
  // make two runtimes in one process silently share state, and it is also how
  // auto-instrumentation gets in — and an HTTP instrumentation would capture
  // request URLs, exactly what the redactor exists to keep out of telemetry.
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new BatchSpanProcessor(spanExporter, { ...BOUNDS })],
  });
  const meterProvider = metricReaders.length ? new MeterProvider({ readers: metricReaders }) : undefined;

  const tracer = tracerProvider.getTracer(serviceName);
  const telemetry = createTelemetry({
    sink: otelSink(tracer, { "service.name": serviceName, "deployment.environment": environment }),
    ...(options.now ? { now: options.now } : {}),
  });

  let stopped = false;
  return {
    telemetry,
    enabled: true,
    async flush(): Promise<void> {
      // A collector that cannot be flushed must not fail the caller.
      try { await tracerProvider.forceFlush(); } catch { /* observability only */ }
      try { await meterProvider?.forceFlush(); } catch { /* observability only */ }
    },
    async shutdown(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try { await tracerProvider.shutdown(); } catch { /* shutdown is best-effort by design */ }
      try { await meterProvider?.shutdown(); } catch { /* shutdown is best-effort by design */ }
    },
  };
}
