import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";

import { startOtelRuntime, traceIdForCorrelation } from "../../src/observability/otel.js";
import type { OtelRuntime } from "../../src/observability/otel.js";

let runtime: OtelRuntime | undefined;
afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
});

describe("opentelemetry export", () => {
  it("exports redacted attributes and never the raw values", async () => {
    const exporter = new InMemorySpanExporter();
    runtime = startOtelRuntime({ spanExporter: exporter, environment: "test" });
    runtime.telemetry.record("command.accept", {
      correlationId: "11111111-2222-4333-8444-555555555555",
      roomSeq: 7,
      text: "a student's message",
      authorization: "Bearer live-token",
      snapshotUrl: "https://storage.example/private/object",
    });
    // `flush`, not `shutdown`: InMemorySpanExporter discards its spans when it
    // is shut down, so a test that asserts after shutdown asserts on nothing.
    await runtime.flush();

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("command.accept");
    expect(span?.attributes).toMatchObject({
      correlationId: "11111111-2222-4333-8444-555555555555",
      roomSeq: 7,
      text: "[REDACTED_CONTENT]",
      authorization: "[REDACTED_SECRET]",
      snapshotUrl: "[REDACTED_URL]",
      "deployment.environment": "test",
    });
    const exported = JSON.stringify(exporter.getFinishedSpans().map((s) => ({ name: s.name, attributes: s.attributes, events: s.events })));
    expect(exported).not.toContain("student's message");
    expect(exported).not.toContain("live-token");
    expect(exported).not.toContain("storage.example");
  });

  it("joins every stage of one command into a single trace", async () => {
    const exporter = new InMemorySpanExporter();
    runtime = startOtelRuntime({ spanExporter: exporter });
    const correlationId = "abcdef01-2345-4678-89ab-cdef01234567";
    for (const stage of ["command.accept", "room_event.commit", "outbox.publish", "websocket.send"]) {
      runtime.telemetry.record(stage, { correlationId });
    }
    runtime.telemetry.record("outbox.publish", { correlationId: "fedcba98-7654-4321-8987-6543210fedcb" });
    await runtime.flush();

    const spans = exporter.getFinishedSpans();
    const traces = new Set(spans.map((span) => span.spanContext().traceId));
    expect(spans).toHaveLength(5);
    expect(traces.size).toBe(2);
    expect(traces).toContain("abcdef012345467889abcdef01234567");
    // Each stage is its own span, so a stalled stage is visible as a gap.
    expect(new Set(spans.map((span) => span.spanContext().spanId)).size).toBe(5);
  });

  it("reuses the persisted correlation id and refuses anything that is not one", () => {
    expect(traceIdForCorrelation("abcdef01-2345-4678-89ab-cdef01234567")).toBe("abcdef012345467889abcdef01234567");
    expect(traceIdForCorrelation("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(traceIdForCorrelation("not-a-uuid")).toBeUndefined();
    expect(traceIdForCorrelation(undefined)).toBeUndefined();
  });

  it("degrades to a working facade when no collector is configured", async () => {
    runtime = startOtelRuntime({});
    expect(runtime.enabled).toBe(false);
    expect(() => runtime?.telemetry.record("worker.claim", { jobId: "job-1" })).not.toThrow();
    await expect(runtime.flush()).resolves.toBeUndefined();
  });

  it("counts exporter failures without failing the caller", async () => {
    const exporter = new InMemorySpanExporter();
    exporter.export = () => { throw new Error("COLLECTOR_UNREACHABLE"); };
    runtime = startOtelRuntime({ spanExporter: exporter });
    expect(() => runtime?.telemetry.record("projection.commit", { roomSeq: 3 })).not.toThrow();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });
});
