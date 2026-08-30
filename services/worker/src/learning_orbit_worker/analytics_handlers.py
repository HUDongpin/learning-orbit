"""Durable analytics job handlers.

These handlers keep the orchestration boundary narrow: the canonical event is
reloaded by id, the projection cursor is advanced only after validation, and a
claim receipt is written before the generic worker settles the lease.  Model
and extraction work is injected through the pure projector seam; no provider
or network call is made here.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from typing import Any, Mapping
from uuid import UUID, uuid5

from .handler_registry import HandlerOutcome, WorkerDeps
from .jobs import WorkerJob
from .projection_store import ProjectionStore
from .projector import StreamingProjector
from .extractors import extract_echo
from .echo_adapter import diff_echo_snapshots, project_echo_snapshot
from .trace_adapter import project_trace, scoped_node_id


def _row_value(row: Any, key: str, index: int) -> Any:
    if isinstance(row, Mapping):
        return row.get(key)
    return row[index]


def _event_dict(row: Any) -> dict[str, Any]:
    names = ("eventId", "roomId", "roomSeq", "schemaVersion", "type", "actorId",
             "actorKind", "actorRole", "revision", "operation", "eventTime",
             "ingestTime", "causationId", "correlationId", "payload")
    if isinstance(row, Mapping):
        return {name: row[name] for name in names}
    return dict(zip(names, row, strict=True))


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    text = str(value)
    return text.replace("+00:00", "Z") if text.endswith("+00:00") else text


@contextmanager
def _transaction(connection: Any):
    transaction = getattr(connection, "transaction", None)
    if callable(transaction):
        with transaction():
            yield
    else:
        yield


ANALYSIS_NAMESPACE = UUID("f2d0ce55-6c06-5b8f-a6b0-4a6b08cbf8af")
ECHO_VERSION = "echo-cm-reference-v1+adapter-v1"
TRACE_VERSION = "trace-ai-reference-v1+adapter-v1"
PARAMETER_HASH = sha256(json.dumps({
    "echoHalfLifeSeconds": 1800, "traceCommunicationHalfLifeSeconds": 600,
    "allowedLatenessSeconds": 5, "adapterVersion": 1,
}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _pseudonym_key() -> bytes:
    raw = os.environ.get("LO_ANALYTICS_PSEUDONYM_KEY", "")
    if len(raw) < 16:
        # Never silently derive learner IDs from a public/static key.
        raise ValueError("ANALYTICS_PSEUDONYM_KEY_REQUIRED")
    return raw.encode("utf-8")


def _canonical_events(connection: Any, room_id: str, through: int) -> list[dict[str, Any]]:
    cursor = connection.execute(
        """SELECT event_id,room_id,room_seq,schema_version,type,actor_id,actor_kind,
                  actor_role,revision,operation,event_time,ingest_time,causation_id,
                  correlation_id,payload
           FROM room_event WHERE room_id=%s AND room_seq<=%s ORDER BY room_seq,event_id""",
        (room_id, through),
    )
    return [_event_dict(row) for row in cursor.fetchall()]


def _metadata(room_id: str, key: str, epoch: str, version: int, through: int, watermark: str) -> dict[str, Any]:
    return {
        "roomId": room_id, "analysisEpoch": epoch,
        "algorithmVersion": ECHO_VERSION if key.startswith("echo.") else TRACE_VERSION,
        "parameterHash": PARAMETER_HASH, "projectionVersion": version,
        "baseVersion": version - 1, "completeThroughRoomSeq": through,
        "watermarkEventTime": watermark, "requiresReplay": False, "warnings": [],
    }


def _pseudonym_index(connection: Any, room_id: str) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    rows = connection.execute(
        "SELECT actor_id,pseudonym FROM room_member WHERE room_id=%s ORDER BY seat_index", (room_id,)
    ).fetchall()
    key = _pseudonym_key()
    students: dict[str, dict[str, Any]] = {}
    mapping: dict[str, dict[str, Any]] = {}
    for row in rows:
        actor, label = _row_value(row, "actor_id", 0), _row_value(row, "pseudonym", 1)
        actor = str(actor)
        students[actor] = {"nodeId": scoped_node_id(key, room_id, "EPOCH_PLACEHOLDER", actor), "label": str(label), "kind": "learner"}
        mapping[actor] = {"actorId": actor, "pseudonym": str(label), "kind": "learner"}
    room = connection.execute("SELECT nova_actor_id FROM classroom_room WHERE room_id=%s", (room_id,)).fetchone()
    if room:
        nova = str(_row_value(room, "nova_actor_id", 0))
        students[nova] = {"nodeId": scoped_node_id(key, room_id, "EPOCH_PLACEHOLDER", nova), "label": "Nova Agent", "kind": "agent"}
        students["ROOM"] = {"nodeId": scoped_node_id(key, room_id, "EPOCH_PLACEHOLDER", "ROOM"), "label": "共學聊天室", "kind": "room"}
        mapping[nova] = {"actorId": nova, "pseudonym": "Nova Agent", "kind": "agent"}
        mapping["ROOM"] = {"actorId": nova, "pseudonym": "共學聊天室", "kind": "room"}
    return students, mapping


def _materialize(deps: WorkerDeps, room_id: str, through: int, epoch: str) -> None:
    events = _canonical_events(deps.db, room_id, through)
    if not events or int(events[-1]["roomSeq"]) != through:
        raise ValueError("ANALYTICS_EVENT_SEQUENCE_INVALID")
    projector = StreamingProjector(room_id)
    for event in events:
        projector.consume(event)
    watermark = _iso(events[-1]["ingestTime"])
    store = getattr(deps, "projection_store", None) or ProjectionStore(deps.db)
    echo_internal = projector.state.echo.snapshot(now=watermark)
    echo_evidence: dict[str, dict[str, Any]] = {}
    for chat in projector._chat_history:
        extracted = extract_echo(chat)["output"]
        for candidate in extracted.get("candidates", ()):
            for evidence in candidate.get("evidence", ()):
                echo_evidence[str(evidence["evidenceId"])] = {
                    "eventId": str(evidence["eventId"]), "start": int(evidence["start"]), "end": int(evidence["end"]),
                }
    pseudonyms, actor_mapping = _pseudonym_index(deps.db, room_id)
    # Scoped IDs include the epoch and are therefore rotated on replay.
    for actor, value in list(pseudonyms.items()):
        pseudonyms[actor] = {**value, "nodeId": scoped_node_id(
            _pseudonym_key(), room_id, epoch, actor)}
    trace_snap = projector.state.trace.snapshot(now=watermark, view="observed").to_dict()
    trace_evidence = {
        str(event["eventId"]): {"eventId": str(event["eventId"]), "start": 0,
                                "end": max(1, len(str((event.get("payload") or {}).get("text", "")))),
                                "basis": "text_span"}
        for event in events
    }
    # Stable epoch means normal consumes append to one chain; replay gets a
    # deterministic new epoch from the replay job id.
    for key in ("echo.teacher_shadow", "echo.student_approved", "trace.teacher_bundle", "trace.student_bundle"):
        head = store.head(room_id, key)
        current = int(head["version"]) if head else 0
        version = current + 1
        metadata = _metadata(room_id, key, epoch, version, through, watermark)
        if key.startswith("echo."):
            projected = project_echo_snapshot(echo_internal, metadata, echo_evidence)
            current_projection = projected["teacher" if key == "echo.teacher_shadow" else "student"]
            previous = store.snapshot_for_head(head.get("snapshot_id") if head else None) if head else None
            patch = None
            if key == "echo.teacher_shadow":
                prior = {"payload": {"nodes": [], "edges": []}}
                if previous:
                    prior = {"payload": previous.get("payload", {})}
                patch = diff_echo_snapshots(prior, current_projection, metadata)
            store.persist_and_advance(snapshot=current_projection,
                                      payload_hash=store.content_hash(current_projection["payload"]),
                                      patch=patch,
                                      patch_hash=store.content_hash(patch) if patch else None)
        else:
            trace_teacher, trace_student = project_trace(
                {"recent_10m": trace_snap, "session_45m": trace_snap},
                {"recent_10m": {"windowStartEventTime": watermark, "windowEndEventTime": watermark},
                 "session_45m": {"windowStartEventTime": watermark, "windowEndEventTime": watermark}},
                {**metadata, "teacherActorMapping": actor_mapping}, pseudonyms, trace_evidence, 4,
            )
            current_projection = trace_teacher if key == "trace.teacher_bundle" else trace_student
            store.persist_and_advance(snapshot=current_projection,
                                      payload_hash=store.content_hash(current_projection["payload"]))
    store.advance_checkpoint(room_id, through)


def analytics_consume_handler(deps: WorkerDeps, job: WorkerJob) -> HandlerOutcome:
    if deps.claim is None or not job.room_id or not job.source_event_id:
        raise ValueError("ANALYTICS_JOB_PAYLOAD_INVALID")
    payload = job.payload if isinstance(job.payload, Mapping) else {}
    event_seq = payload.get("roomSeq")
    if payload.get("eventId") != job.source_event_id or isinstance(event_seq, bool) \
            or not isinstance(event_seq, int) or event_seq < 1:
        raise ValueError("ANALYTICS_JOB_PAYLOAD_INVALID")
    cursor = deps.db.execute(
        "SELECT room_id,room_seq,type FROM room_event WHERE event_id=%s",
        (job.source_event_id,),
    )
    row = cursor.fetchone()
    if row is None or _row_value(row, "room_id", 0) != job.room_id \
            or int(_row_value(row, "room_seq", 1)) != event_seq:
        raise ValueError("ANALYTICS_EVENT_NOT_FOUND")
    store = getattr(deps, "projection_store", None) or ProjectionStore(deps.db)
    target_seq = event_seq
    checkpoint = store.checkpoint(job.room_id)
    if checkpoint >= target_seq:
        deps.job_claims.complete_business(deps.db, deps.claim.as_job_claim(), "ANALYTICS_CONSUMED")
        return HandlerOutcome.SUCCESS
    if checkpoint + 1 != target_seq:
        raise ValueError("ANALYTICS_CURSOR_GAP")
    epoch = str(uuid5(ANALYSIS_NAMESPACE, job.room_id))
    with _transaction(deps.db):
        _materialize(deps, job.room_id, target_seq, epoch)
        deps.job_claims.complete_business(deps.db, deps.claim.as_job_claim(), "ANALYTICS_CONSUMED")
    return HandlerOutcome.SUCCESS


def analytics_replay_handler(deps: WorkerDeps, job: WorkerJob) -> HandlerOutcome:
    if deps.claim is None or not job.room_id:
        raise ValueError("ANALYTICS_REPLAY_PAYLOAD_INVALID")
    payload = job.payload if isinstance(job.payload, Mapping) else {}
    if not isinstance(payload.get("requestedThroughRoomSeq"), int) \
            or isinstance(payload.get("requestedThroughRoomSeq"), bool):
        raise ValueError("ANALYTICS_REPLAY_PAYLOAD_INVALID")
    store = getattr(deps, "projection_store", None) or ProjectionStore(deps.db)
    through = store.checkpoint(job.room_id)
    requested = int(payload["requestedThroughRoomSeq"])
    if through < requested:
        raise ValueError("ANALYTICS_REPLAY_CURSOR_BEHIND")
    epoch = str(uuid5(ANALYSIS_NAMESPACE, job.job_id))
    with _transaction(deps.db):
        _materialize(deps, job.room_id, through, epoch)
        deps.job_claims.complete_business(deps.db, deps.claim.as_job_claim(), "ANALYTICS_REPLAYED")
    return HandlerOutcome.SUCCESS


def register_analytics_handlers(registry: Any) -> Any:
    registry.register("analytics.consume.v1", analytics_consume_handler)
    registry.register("analytics.replay-room.v1", analytics_replay_handler)
    return registry


__all__ = ["analytics_consume_handler", "analytics_replay_handler", "register_analytics_handlers"]
