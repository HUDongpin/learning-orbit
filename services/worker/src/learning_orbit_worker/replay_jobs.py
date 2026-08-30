"""Idempotent enqueue authority for analytics room replay jobs."""
from __future__ import annotations

from hashlib import sha256
from typing import Any
from uuid import UUID, uuid5

REPLAY_REASONS = frozenset({"late_event", "artifact_available", "analytics_review", "operator_rebuild"})
REPLAY_JOB_NAMESPACE = UUID("00000000-0000-5000-8000-000000000033")


def enqueue_analytics_replay(
    connection, *, room_id: str, source_event_id: str | None,
    requested_through_room_seq: int, reason: str, dedupe_token: str,
    correlation_id: str,
) -> str:
    if reason not in REPLAY_REASONS or not isinstance(requested_through_room_seq, int) \
            or isinstance(requested_through_room_seq, bool) or requested_through_room_seq < 0:
        raise ValueError("INVALID_REPLAY_REQUEST")
    try:
        room_id = str(UUID(str(room_id)))
        if source_event_id is not None:
            source_event_id = str(UUID(str(source_event_id)))
        correlation_id = str(UUID(str(correlation_id)))
    except (ValueError, TypeError, AttributeError):
        raise ValueError("INVALID_REPLAY_REQUEST") from None
    if not isinstance(dedupe_token, str) or not 1 <= len(dedupe_token) <= 160:
        raise ValueError("INVALID_REPLAY_REQUEST")
    dedupe_hash = sha256(f"{room_id}\0{reason}\0{dedupe_token}".encode()).hexdigest()
    dedupe_key = "analytics.replay-room.v1:" + dedupe_hash
    job_id = str(uuid5(REPLAY_JOB_NAMESPACE, dedupe_key))
    try:
        from psycopg.types.json import Jsonb
        payload: Any = Jsonb({"reason": reason, "requestedThroughRoomSeq": requested_through_room_seq})
    except ImportError:
        payload = {"reason": reason, "requestedThroughRoomSeq": requested_through_room_seq}
    connection.execute(
        """INSERT INTO worker_job
           (job_id,job_type,room_id,source_event_id,dedupe_key,payload,correlation_id,
            analytics_order_seq,analytics_order_kind,status)
           VALUES (%s,'analytics.replay-room.v1',%s,%s,%s,%s,%s,%s,1,'queued')
           ON CONFLICT (dedupe_key) DO NOTHING""",
        (job_id, room_id, source_event_id, dedupe_key,
         payload,
         correlation_id, requested_through_room_seq),
    )
    # ``ON CONFLICT DO NOTHING`` is only an idempotency primitive, not an
    # authority check.  Resolve the existing row and compare every immutable
    # field so a reused dedupe key cannot silently bind a replay to another
    # room, cursor or correlation.
    worker_row = connection.execute(
        """SELECT job_id,job_type,room_id,source_event_id,dedupe_key,
                  correlation_id,payload,analytics_order_seq,analytics_order_kind
             FROM worker_job WHERE dedupe_key=%s FOR UPDATE""",
        (dedupe_key,),
    ).fetchone()
    if worker_row is None:
        raise ValueError("REPLAY_AUTHORITY_CONFLICT")

    def field(row: Any, name: str, index: int) -> Any:
        return row.get(name) if isinstance(row, dict) else row[index]

    def same_uuid(left: Any, right: str | None) -> bool:
        if right is None:
            return left is None
        try:
            return UUID(str(left)) == UUID(right)
        except (ValueError, TypeError, AttributeError):
            return False

    existing_payload = field(worker_row, "payload", 6)
    if not isinstance(existing_payload, dict):
        raise ValueError("REPLAY_AUTHORITY_CONFLICT")
    if (
        not same_uuid(field(worker_row, "job_id", 0), job_id)
        or field(worker_row, "job_type", 1) != "analytics.replay-room.v1"
        or not same_uuid(field(worker_row, "room_id", 2), room_id)
        or not same_uuid(field(worker_row, "source_event_id", 3), source_event_id)
        or field(worker_row, "dedupe_key", 4) != dedupe_key
        or not same_uuid(field(worker_row, "correlation_id", 5), correlation_id)
        or existing_payload != {"reason": reason, "requestedThroughRoomSeq": requested_through_room_seq}
        or field(worker_row, "analytics_order_seq", 7) != requested_through_room_seq
        or field(worker_row, "analytics_order_kind", 8) != 1
    ):
        raise ValueError("REPLAY_AUTHORITY_CONFLICT")
    connection.execute(
        """INSERT INTO analytics_replay_request
           (job_id,room_id,source_event_id,reason,requested_through_room_seq,dedupe_key,correlation_id)
           VALUES (%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (job_id) DO NOTHING""",
        (job_id, room_id, source_event_id, reason, requested_through_room_seq, dedupe_key, correlation_id),
    )
    authority_row = connection.execute(
        """SELECT job_id,room_id,source_event_id,reason,
                  requested_through_room_seq,dedupe_key,correlation_id
             FROM analytics_replay_request WHERE job_id=%s FOR UPDATE""",
        (job_id,),
    ).fetchone()
    if authority_row is None or (
        not same_uuid(field(authority_row, "job_id", 0), job_id)
        or not same_uuid(field(authority_row, "room_id", 1), room_id)
        or not same_uuid(field(authority_row, "source_event_id", 2), source_event_id)
        or field(authority_row, "reason", 3) != reason
        or field(authority_row, "requested_through_room_seq", 4) != requested_through_room_seq
        or field(authority_row, "dedupe_key", 5) != dedupe_key
        or not same_uuid(field(authority_row, "correlation_id", 6), correlation_id)
    ):
        raise ValueError("REPLAY_AUTHORITY_CONFLICT")
    return job_id


__all__ = ["REPLAY_REASONS", "enqueue_analytics_replay"]
