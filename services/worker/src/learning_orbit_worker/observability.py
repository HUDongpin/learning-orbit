"""Bounded, content-safe worker observability primitives.

The worker's event ledger and job rows are authoritative.  This module is a
small stdlib-only seam that can be adapted to OpenTelemetry later; it never
places prompts, transcripts, media URLs, or provider payloads in spans.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
import urllib.request
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.parse import urlparse

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


# --------------------------------------------------------------------------
# OTLP/HTTP export
#
# The worker exports over OTLP's JSON encoding using only the standard
# library.  The OpenTelemetry Python SDK would pull roughly a dozen further
# packages -- protobuf, requests and their transitive dependencies -- into a
# hash-pinned lock for a process that handles classroom content, and it would
# buy nothing here: the trace identifier is derived from the correlation id
# the worker already claimed from ``worker_job``, so no propagation library is
# needed.  The wire format below is the one collectors accept at
# ``/v1/traces`` with ``Content-Type: application/json``.
# --------------------------------------------------------------------------

_NON_ZERO_HEX = re.compile(r"^(?=.*[1-9a-f])[0-9a-f]{32}$")


def trace_id_for_correlation(correlation_id: Any) -> str | None:
    """Reuse the persisted correlation id as the trace id.

    A correlation id is a UUID -- exactly the sixteen bytes of a trace id --
    so every stage that carries it, in either runtime, lands in one trace
    without a propagation header.  The worker never invents a replacement.
    """
    if not isinstance(correlation_id, str):
        return None
    candidate = correlation_id.replace("-", "").lower()
    return candidate if _NON_ZERO_HEX.fullmatch(candidate) else None


def _attribute(key: str, value: Any) -> dict[str, Any] | None:
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    if isinstance(value, float):
        return {"key": key, "value": {"doubleValue": value}}
    if isinstance(value, str):
        return {"key": key, "value": {"stringValue": value}}
    # ``None`` and anything else is dropped rather than exported as a
    # placeholder that would read like real data.
    return None


def _span_payload(record: Mapping[str, Any], resource: Mapping[str, str]) -> dict[str, Any]:
    started_ns = int(float(record["startedAt"]) * 1_000_000_000)
    duration_ns = int(float(record.get("durationMs", 0.0)) * 1_000_000)
    attributes = record.get("attributes") or {}
    trace_id = trace_id_for_correlation(attributes.get("correlationId")) or secrets.token_hex(16)
    return {
        "traceId": trace_id,
        "spanId": secrets.token_hex(8),
        "name": str(record["name"]),
        "kind": 1,
        "startTimeUnixNano": str(started_ns),
        "endTimeUnixNano": str(started_ns + max(0, duration_ns)),
        "attributes": [a for a in (_attribute(k, v) for k, v in attributes.items()) if a],
        "_resource": dict(resource),
    }


class OtlpHttpSpanSink:
    """Bounded OTLP/HTTP span sink.

    Spans arrive already redacted by :class:`Telemetry`, so this sink cannot
    become a content side channel even if a caller passes something unsafe.
    The queue has a fixed size and drops the oldest span when full: an
    unreachable collector must cost a bounded amount of memory and must never
    delay or fail job handling.
    """

    def __init__(
        self,
        endpoint: str,
        *,
        service_name: str = "learning-orbit-worker",
        environment: str = "development",
        max_queue: int = 512,
        batch_size: int = 128,
        timeout_seconds: float = 10.0,
        transport: Callable[[str, bytes], None] | None = None,
    ) -> None:
        self.endpoint = endpoint.rstrip("/") + "/v1/traces"
        self.resource = {"service.name": service_name, "deployment.environment": environment}
        self.batch_size = max(1, batch_size)
        self.timeout_seconds = timeout_seconds
        self._queue: deque[dict[str, Any]] = deque(maxlen=max(1, max_queue))
        self._transport = transport or self._post
        self.dropped = 0
        self.export_failures = 0

    def __call__(self, record: Mapping[str, Any]) -> None:
        if len(self._queue) == self._queue.maxlen:
            self.dropped += 1
        self._queue.append(_span_payload(record, self.resource))
        if len(self._queue) >= self.batch_size:
            self.flush()

    def flush(self) -> None:
        """Send whatever is queued.  A failed batch is dropped, not retried.

        Retrying would mean holding classroom-timed work behind a telemetry
        backend, which is exactly the coupling this sink exists to avoid.
        """
        if not self._queue:
            return
        batch = [self._queue.popleft() for _ in range(len(self._queue))]
        try:
            self._transport(self.endpoint, json.dumps(self._request(batch)).encode("utf-8"))
        except Exception:  # noqa: BLE001 - observability never fails a job
            self.export_failures += 1

    def _request(self, batch: list[dict[str, Any]]) -> dict[str, Any]:
        spans = []
        for span in batch:
            span = dict(span)
            span.pop("_resource", None)
            spans.append(span)
        return {
            "resourceSpans": [{
                "resource": {"attributes": [a for a in (_attribute(k, v) for k, v in self.resource.items()) if a]},
                "scopeSpans": [{"scope": {"name": "learning-orbit-worker"}, "spans": spans}],
            }],
        }

    def _post(self, url: str, body: bytes) -> None:
        request = urllib.request.Request(
            url, data=body, method="POST",
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:  # noqa: S310
            response.read()


def telemetry_from_env(env: Mapping[str, str] | None = None) -> tuple[Telemetry, OtlpHttpSpanSink | None]:
    """Build worker telemetry, exporting only when a collector is configured.

    No collector is a supported deployment: telemetry still redacts and counts,
    it simply has nowhere to send.  A worker must claim and finish jobs whether
    or not anything is watching.
    """
    env = os.environ if env is None else env
    endpoint = (env.get("LO_OTLP_ENDPOINT") or "").strip()
    if not endpoint:
        return create_telemetry(), None
    parsed = urlparse(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.path not in {"", "/"}:
        raise ValueError("LO_OTLP_ENDPOINT_INVALID")
    environment = env.get("LO_ENVIRONMENT") or "development"
    sink = OtlpHttpSpanSink(endpoint, environment=environment)
    return Telemetry(sink, time.time), sink
