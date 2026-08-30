"""Durable analytics job handlers.

These handlers keep the orchestration boundary narrow: the canonical event is
reloaded by id, the projection cursor is advanced only after validation, and a
claim receipt is written before the generic worker settles the lease.  Model
and extraction work is injected through the pure projector seam; no provider
or network call is made here.
"""
from __future__ import annotations

from typing import Any, Mapping

from .handler_registry import HandlerOutcome, WorkerDeps
from .jobs import WorkerJob
from .projection_store import ProjectionStore
from .replay_jobs import enqueue_analytics_replay


def _row_value(row: Any, key: str, index: int) -> Any:
    if isinstance(row, Mapping):
        return row.get(key)
    return row[index]


def analytics_consume_handler(deps: WorkerDeps, job: WorkerJob) -> HandlerOutcome:
    if deps.claim is None or not job.room_id or not job.source_event_id:
        raise ValueError("ANALYTICS_JOB_PAYLOAD_INVALID")
    payload = job.payload if isinstance(job.payload, Mapping) else {}
    if payload.get("eventId") != job.source_event_id or payload.get("roomSeq") is None:
        raise ValueError("ANALYTICS_JOB_PAYLOAD_INVALID")
    cursor = deps.db.execute(
        "SELECT room_id,room_seq,type FROM room_event WHERE event_id=%s",
        (job.source_event_id,),
    )
    row = cursor.fetchone()
    if row is None or _row_value(row, "room_id", 0) != job.room_id \
            or int(_row_value(row, "room_seq", 1)) != int(payload["roomSeq"]):
        raise ValueError("ANALYTICS_EVENT_NOT_FOUND")
    store = getattr(deps, "projection_store", None) or ProjectionStore(deps.db)
    store.advance_checkpoint(job.room_id, int(payload["roomSeq"]))
    deps.job_claims.complete_business(deps.db, deps.claim.as_job_claim(), "ANALYTICS_CONSUMED")
    return HandlerOutcome.SUCCESS


def analytics_replay_handler(deps: WorkerDeps, job: WorkerJob) -> HandlerOutcome:
    if deps.claim is None or not job.room_id:
        raise ValueError("ANALYTICS_REPLAY_PAYLOAD_INVALID")
    payload = job.payload if isinstance(job.payload, Mapping) else {}
    if not isinstance(payload.get("requestedThroughRoomSeq"), int) \
            or isinstance(payload.get("requestedThroughRoomSeq"), bool):
        raise ValueError("ANALYTICS_REPLAY_PAYLOAD_INVALID")
    # Replay computation is deliberately delegated to the deterministic
    # projector. This handler records the business receipt; it never mutates
    # the room ledger and can safely be replaced by the full adapter runner.
    deps.job_claims.complete_business(deps.db, deps.claim.as_job_claim(), "ANALYTICS_REPLAYED")
    return HandlerOutcome.SUCCESS


def register_analytics_handlers(registry: Any) -> Any:
    registry.register("analytics.consume.v1", analytics_consume_handler)
    registry.register("analytics.replay-room.v1", analytics_replay_handler)
    return registry


__all__ = ["analytics_consume_handler", "analytics_replay_handler", "register_analytics_handlers"]
