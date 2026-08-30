import { describe, expect, it } from "vitest";

import { InMemoryTelemetry, createTelemetry } from "../../src/observability/telemetry.js";

describe("bounded telemetry", () => {
  it("correlates spans while redacting content and secrets", () => {
    const sink = new InMemoryTelemetry();
    const telemetry = createTelemetry({ sink, now: () => 1000 });
    const span = telemetry.startSpan("command.accept", {
      correlationId: "corr-1",
      roomId: "room-1",
      text: "student content",
      apiKey: "secret",
    });
    span.end(12);
    expect(sink.spans).toEqual([
      {
        name: "command.accept",
        attributes: { correlationId: "corr-1", roomId: "room-1", text: "[REDACTED_CONTENT]", apiKey: "[REDACTED_SECRET]" },
        startedAt: 1000,
        endedAt: 1012,
      },
    ]);
  });

  it("bounds and rate-limits exporter failures", () => {
    const sink = new InMemoryTelemetry();
    const telemetry = createTelemetry({ sink, now: () => 0, maxFailureReports: 1 });
    telemetry.record("worker.claim", { jobId: "job-1" });
    expect(sink.spans).toHaveLength(1);
    sink.fail = true;
    telemetry.record("worker.claim", { jobId: "job-2" });
    telemetry.record("worker.claim", { jobId: "job-3" });
    expect(telemetry.exporterFailureCount).toBe(2);
    expect(telemetry.failureReports).toBe(1);
  });
});
