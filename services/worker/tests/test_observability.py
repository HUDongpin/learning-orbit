import json
import unittest

from learning_orbit_worker.observability import (
    InMemoryTelemetry,
    OtlpHttpSpanSink,
    Telemetry,
    redact_log,
    telemetry_from_env,
    trace_id_for_correlation,
)


class ObservabilityTests(unittest.TestCase):
    def test_redacts_content_urls_and_secrets(self) -> None:
        self.assertEqual(
            redact_log(
                {
                    "roomId": "r1",
                    "eventId": "e1",
                    "text": "student content",
                    "uploadUrl": "https://store/x?sig=secret",
                    "token": "secret",
                }
            ),
            {
                "roomId": "r1",
                "eventId": "e1",
                "text": "[REDACTED_CONTENT]",
                "uploadUrl": "[REDACTED_URL]",
                "token": "[REDACTED_SECRET]",
            },
        )

    def test_span_attributes_are_redacted_and_export_failures_degrade(self) -> None:
        sink = InMemoryTelemetry()
        telemetry = sink.telemetry(max_failure_reports=1, now=lambda: 1000.0)
        telemetry.record("worker.claim", {"jobId": "j1", "prompt": "secret"})
        self.assertEqual(sink.spans[0]["attributes"]["prompt"], "[REDACTED_CONTENT]")
        sink.fail = True
        telemetry.record("worker.claim", {"jobId": "j2"})
        telemetry.record("worker.claim", {"jobId": "j3"})
        self.assertEqual(telemetry.exporter_failure_count, 2)
        self.assertEqual(telemetry.failure_reports, 1)


if __name__ == "__main__":
    unittest.main()


class OtlpExportTest(unittest.TestCase):
    def _sink(self, **kwargs):
        sent: list[tuple[str, bytes]] = []
        sink = OtlpHttpSpanSink(
            "http://collector.internal:4318",
            transport=lambda url, body: sent.append((url, body)),
            **kwargs,
        )
        return sink, sent

    def test_exports_redacted_spans_to_the_collector(self) -> None:
        sink, sent = self._sink()
        telemetry = Telemetry(sink, lambda: 1_700_000_000.0)
        telemetry.record(
            "worker.claim",
            {
                "correlationId": "abcdef01-2345-4678-89ab-cdef01234567",
                "jobId": "job-1",
                "transcript": "what a student said",
                "providerApiKey": "live-secret",
            },
            duration_ms=12.0,
        )
        sink.flush()

        self.assertEqual(len(sent), 1)
        url, body = sent[0]
        self.assertEqual(url, "http://collector.internal:4318/v1/traces")
        self.assertNotIn(b"what a student said", body)
        self.assertNotIn(b"live-secret", body)
        span = json.loads(body)["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
        self.assertEqual(span["name"], "worker.claim")
        self.assertEqual(span["traceId"], "abcdef012345467889abcdef01234567")
        self.assertEqual(
            int(span["endTimeUnixNano"]) - int(span["startTimeUnixNano"]), 12_000_000,
        )

    def test_trace_id_reuses_the_claimed_correlation_id(self) -> None:
        self.assertEqual(
            trace_id_for_correlation("abcdef01-2345-4678-89ab-cdef01234567"),
            "abcdef012345467889abcdef01234567",
        )
        self.assertIsNone(trace_id_for_correlation("00000000-0000-0000-0000-000000000000"))
        self.assertIsNone(trace_id_for_correlation("not-a-uuid"))
        self.assertIsNone(trace_id_for_correlation(None))

    def test_a_full_queue_drops_instead_of_growing(self) -> None:
        sink, sent = self._sink(max_queue=2, batch_size=1000)
        for index in range(5):
            sink({"name": "worker.claim", "attributes": {"jobId": f"job-{index}"}, "startedAt": 0.0, "durationMs": 0.0})
        self.assertEqual(sink.dropped, 3)
        sink.flush()
        spans = json.loads(sent[0][1])["resourceSpans"][0]["scopeSpans"][0]["spans"]
        self.assertEqual(len(spans), 2)

    def test_an_unreachable_collector_never_reaches_the_caller(self) -> None:
        def refuse(_url: str, _body: bytes) -> None:
            raise OSError("COLLECTOR_UNREACHABLE")

        sink = OtlpHttpSpanSink("http://collector.internal:4318", transport=refuse)
        telemetry = Telemetry(sink, lambda: 0.0)
        telemetry.record("worker.claim", {"jobId": "job-1"})
        sink.flush()
        self.assertEqual(sink.export_failures, 1)
        # The batch is dropped rather than retried: a telemetry backend must
        # never hold classroom-timed work.
        self.assertEqual(len(sink._queue), 0)

    def test_no_collector_configured_still_yields_working_telemetry(self) -> None:
        telemetry, sink = telemetry_from_env({})
        self.assertIsNone(sink)
        telemetry.record("worker.claim", {"jobId": "job-1"})
        self.assertEqual(telemetry.exporter_failure_count, 0)

    def test_a_malformed_endpoint_is_refused_at_startup(self) -> None:
        for endpoint in ("collector:4318", "http://collector:4318/v1/traces", "ftp://collector"):
            with self.assertRaises(ValueError):
                telemetry_from_env({"LO_OTLP_ENDPOINT": endpoint})
