"""Idempotent enqueue authority for analytics room replay jobs."""
from __future__ import annotations

from hashlib import sha256
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
    dedupe_hash = sha256(f"{room_id}\0{reason}\0{dedupe_token}".encode()).hexdigest()
    dedupe_key = "analytics.replay-room.v1:" + dedupe_hash
    job_id = str(uuid5(REPLAY_JOB_NAMESPACE, dedupe_key))
    connection.execute(
        """INSERT INTO worker_job
           (job_id,job_type,room_id,source_event_id,dedupe_key,payload,correlation_id,
            analytics_order_seq,analytics_order_kind,status)
           VALUES (%s,'analytics.replay-room.v1',%s,%s,%s,%s,%s,%s,1,'queued')
           ON CONFLICT (dedupe_key) DO NOTHING""",
        (job_id, room_id, source_event_id, dedupe_key,
         {"reason": reason, "requestedThroughRoomSeq": requested_through_room_seq},
         correlation_id, requested_through_room_seq),
    )
    connection.execute(
        """INSERT INTO analytics_replay_request
           (job_id,room_id,source_event_id,reason,requested_through_room_seq,dedupe_key,correlation_id)
           VALUES (%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (job_id) DO NOTHING""",
        (job_id, room_id, source_event_id, reason, requested_through_room_seq, dedupe_key, correlation_id),
    )
    return job_id


__all__ = ["REPLAY_REASONS", "enqueue_analytics_replay"]
