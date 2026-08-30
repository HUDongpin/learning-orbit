"""Handlers for Plan 01's core durable job families."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .handler_registry import HandlerOutcome, WorkerDeps
from .internal_http import InternalHttpError
from .jobs import WorkerJob


class RetryableJobError(RuntimeError):
    retryable = True

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class TerminalJobError(RuntimeError):
    terminal = True

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
    if isinstance(value, str):
        return value
    raise TerminalJobError("JOB_PAYLOAD_INVALID")


def room_auto_close_handler(deps: WorkerDeps, job: WorkerJob) -> HandlerOutcome:
    """Call the signed internal route; domain mutation remains server-owned."""

    if deps.internal_http is None or deps.claim is None:
        raise TerminalJobError("WORKER_DEPENDENCY_MISSING")
    payload = job.payload if isinstance(job.payload, dict) else {}
    room_id = payload.get("roomId")
    closes_at = payload.get("closesAt")
    if room_id != job.room_id or not isinstance(room_id, str) or not closes_at:
        raise TerminalJobError("JOB_PAYLOAD_INVALID")
    claim = deps.claim
    body = {
        "jobId": claim.job_id,
        "jobType": claim.job_type,
        "roomId": claim.room_id,
        "sourceEventId": claim.source_event_id,
        "dedupeKey": claim.dedupe_key,
        "correlationId": claim.correlation_id,
        "claimGeneration": claim.claim_generation,
        "claimToken": claim.claim_token,
        "workerId": claim.worker_id,
        "closesAt": _iso(closes_at),
    }
    try:
        response = deps.internal_http.post("/internal/rooms/auto-close", "internal.rooms.autoClose", body, claim)
    except InternalHttpError as error:
        if error.code in {"INTERNAL_HTTP_TIMEOUT", "INTERNAL_HTTP_TRANSPORT", "INTERNAL_HTTP_STATUS"}:
            raise RetryableJobError("INTERNAL_HTTP_RETRYABLE") from error
        raise TerminalJobError("INTERNAL_HTTP_REJECTED") from error
    result = response.body
    status, code = result.get("status"), result.get("code")
    if status == "completed" and code in {"ROOM_CLOSED", "ALREADY_CLOSED"}:
        return HandlerOutcome.SUCCESS
    if status == "retryable" and code == "ROOM_CLOSE_NOT_DUE":
        raise RetryableJobError("ROOM_CLOSE_NOT_DUE")
    if status == "rejected" and code == "JOB_CLAIM_STALE":
        return HandlerOutcome.LOST_LEASE
    if status == "rejected" and isinstance(code, str):
        raise TerminalJobError(code)
    raise TerminalJobError("INTERNAL_HTTP_RESPONSE_SCHEMA")


def register_core_handlers(registry: Any) -> Any:
    registry.register("room.auto-close.v1", room_auto_close_handler)
    return registry


__all__ = ["RetryableJobError", "TerminalJobError", "register_core_handlers", "room_auto_close_handler"]
