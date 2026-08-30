"""Bounded, content-safe worker observability primitives.

The worker's event ledger and job rows are authoritative.  This module is a
small stdlib-only seam that can be adapted to OpenTelemetry later; it never
places prompts, transcripts, media URLs, or provider payloads in spans.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping

SAFE_KEYS = {
    "service", "environment", "roomId", "eventId", "roomSeq", "commandId",
    "jobId", "correlationId", "agentRunId", "projectionVersion",
    "completeThroughRoomSeq", "failureCode", "durationMs",
}


def _safe_value(value: Any) -> Any:
    if isinstance(value, str):
        return value[:256]
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value if value == value and value not in (float("inf"), float("-inf")) else "[REDACTED_CONTENT]"
    return "[REDACTED_CONTENT]"


def redact_log(values: Mapping[str, Any]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key, value in values.items():
        if key in SAFE_KEYS:
            output[key] = _safe_value(value)
        elif "url" in key.lower():
            output[key] = "[REDACTED_URL]"
        elif any(token in key.lower() for token in ("secret", "token", "key", "cookie", "authorization", "password", "credential")):
            output[key] = "[REDACTED_SECRET]"
        else:
            output[key] = "[REDACTED_CONTENT]"
    return output


@dataclass
class Telemetry:
    sink: Callable[[dict[str, Any]], None]
    now: Callable[[], float]
    max_failure_reports: int = 8
    exporter_failure_count: int = 0
    failure_reports: int = 0

    def record(self, name: str, attributes: Mapping[str, Any] | None = None, duration_ms: float = 0.0) -> None:
        record = {
            "name": name,
            "attributes": redact_log(attributes or {}),
            "startedAt": self.now(),
            "durationMs": max(0.0, float(duration_ms)),
        }
        try:
            self.sink(record)
        except Exception:
            self.exporter_failure_count += 1
            if self.failure_reports < max(0, self.max_failure_reports):
                self.failure_reports += 1


class InMemoryTelemetry:
    """Deterministic sink for tests and local pilot diagnostics."""

    def __init__(self) -> None:
        self.spans: list[dict[str, Any]] = []
        self.fail = False

    def __call__(self, span: dict[str, Any]) -> None:
        if self.fail:
            raise RuntimeError("TELEMETRY_SINK_UNAVAILABLE")
        self.spans.append(span)

    def telemetry(self, *, max_failure_reports: int = 8, now: Callable[[], float] | None = None) -> Telemetry:
        return Telemetry(self, now or __import__("time").time, max_failure_reports)


def create_telemetry(sink: Callable[[dict[str, Any]], None] | None = None, *, now: Callable[[], float] | None = None) -> Telemetry:
    return Telemetry(sink or (lambda _record: None), now or __import__("time").time)
