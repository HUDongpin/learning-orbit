import unittest

from learning_orbit_worker.observability import InMemoryTelemetry, redact_log


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
