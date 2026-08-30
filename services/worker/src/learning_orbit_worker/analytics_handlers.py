"""Durable analytics job handlers.

These handlers keep the orchestration boundary narrow: the canonical event is
reloaded by id, the projection cursor is advanced only after validation, and a
claim receipt is written before the generic worker settles the lease.  Model
and extraction work is injected through the pure projector seam; no provider
or network call is made here.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import os
import re
from typing import Any, Mapping
from uuid import UUID, uuid5

from .handler_registry import HandlerOutcome, WorkerDeps
from .jobs import WorkerJob
from .projection_store import ProjectionStore
from .projector import StreamingProjector
from .extractors import extract_echo
from .derived_text import maybe_derive_direct_text
from .projection_store import _jsonb
from .echo_adapter import diff_echo_snapshots, echo_wire_edge_id, project_echo_snapshot
from .trace_adapter import project_trace, scoped_node_id
from .reference.learning_orbit_algorithms_v1 import StreamingInteractionNetwork
from .replay_jobs import enqueue_analytics_replay
from .room_lock import lock_room_in_transaction

REPLAY_REASONS = frozenset({
    "late_event", "artifact_available", "analytics_review", "operator_rebuild",
})
REPLAY_DEDUPE_PATTERN = re.compile(r"^analytics\.replay-room\.v1:[a-f0-9]{64}$")


def _canonical_uuid(value: Any, code: str) -> str:
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise ValueError(code) from None


def _same_uuid(left: Any, right: Any) -> bool:
    try:
        return UUID(str(left)) == UUID(str(right))
    except (ValueError, TypeError, AttributeError):
        return False


def _strict_int(value: Any, code: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(code)
    return value


def _validate_consume_job(job: WorkerJob) -> tuple[str, str, int, str]:
    """Validate the closed consume ABI before any room/projection I/O."""
    if job.job_type != "analytics.consume.v1" or not job.room_id or not job.source_event_id:
        raise ValueError("ANALYTICS_JOB_PAYLOAD_INVALID")
    room_id = _canonical_uuid(job.room_id, "ANALYTICS_JOB_PAYLOAD_INVALID")
    event_id = _canonical_uuid(job.source_event_id, "ANALYTICS_JOB_PAYLOAD_INVALID")
    _canonical_uuid(job.correlation_id, "ANALYTICS_JOB_PAYLOAD_INVALID")
    payload = job.payload
    if not isinstance(payload, Mapping) or set(payload) != {"eventId", "roomSeq", "eventType"}:
        raise ValueError("ANALYTICS_JOB_PAYLOAD_INVALID")
    if not _same_uuid(payload.get("eventId"), event_id):
        raise ValueError("ANALYTICS_JOB_PAYLOAD_INVALID")
    room_seq = _strict_int(payload.get("roomSeq"), "ANALYTICS_JOB_PAYLOAD_INVALID", minimum=1)
    event_type = payload.get("eventType")
    if not isinstance(event_type, str) or not re.fullmatch(r"[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*", event_type) or len(event_type) > 160:
        raise ValueError("ANALYTICS_JOB_PAYLOAD_INVALID")
    if job.dedupe_key != f"analytics.consume.v1:{room_id}:{room_seq}":
        raise ValueError("ANALYTICS_JOB_IDENTITY_INVALID")
    if job.analytics_order_seq != room_seq or job.analytics_order_kind != 0:
        raise ValueError("ANALYTICS_JOB_ORDER_INVALID")
    return room_id, event_id, room_seq, event_type


def _validate_replay_job(job: WorkerJob) -> tuple[str, str | None, str, int]:
    """Validate replay payload plus its immutable database authority row."""
    if job.job_type != "analytics.replay-room.v1" or not job.room_id:
        raise ValueError("ANALYTICS_REPLAY_PAYLOAD_INVALID")
    room_id = _canonical_uuid(job.room_id, "ANALYTICS_REPLAY_PAYLOAD_INVALID")
    source_event_id = None if job.source_event_id is None else _canonical_uuid(
        job.source_event_id, "ANALYTICS_REPLAY_PAYLOAD_INVALID"
    )
    _canonical_uuid(job.correlation_id, "ANALYTICS_REPLAY_PAYLOAD_INVALID")
    payload = job.payload
    if not isinstance(payload, Mapping) or set(payload) != {"reason", "requestedThroughRoomSeq"}:
        raise ValueError("ANALYTICS_REPLAY_PAYLOAD_INVALID")
    reason = payload.get("reason")
    if not isinstance(reason, str) or reason not in REPLAY_REASONS:
        raise ValueError("ANALYTICS_REPLAY_PAYLOAD_INVALID")
    requested = _strict_int(payload.get("requestedThroughRoomSeq"), "ANALYTICS_REPLAY_PAYLOAD_INVALID")
    if job.analytics_order_seq != requested or job.analytics_order_kind != 1:
        raise ValueError("ANALYTICS_REPLAY_ORDER_INVALID")
    if not REPLAY_DEDUPE_PATTERN.fullmatch(job.dedupe_key):
        raise ValueError("ANALYTICS_REPLAY_IDENTITY_INVALID")
    return room_id, source_event_id, reason, requested


def _row_value(row: Any, key: str, index: int) -> Any:
    if isinstance(row, Mapping):
        return row.get(key)
    return row[index]


def _event_dict(row: Any) -> dict[str, Any]:
    names = ("eventId", "roomId", "roomSeq", "schemaVersion", "type", "actorId",
             "actorKind", "actorRole", "revision", "operation", "eventTime",
             "ingestTime", "causationId", "correlationId", "payload")
    value = ({name: row[name] for name in names}
             if isinstance(row, Mapping) else dict(zip(names, row, strict=True)))
    # psycopg returns UUID instances for uuid columns.  The JSON-compatible
    # projector domain deliberately carries text identifiers, so normalize
    # them at the database boundary rather than relying on implicit equality.
    for name in ("eventId", "roomId", "actorId", "causationId", "correlationId"):
        value[name] = str(value[name])
    return value


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    text = str(value)
    return text.replace("+00:00", "Z") if text.endswith("+00:00") else text


def _parse_datetime(value: Any, fallback: datetime) -> datetime:
    """Parse a DB timestamp defensively, returning an explicit fallback."""
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return fallback
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


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
    events = [_event_dict(row) for row in cursor.fetchall()]
    expected = 1
    for event in events:
        seq = event.get("roomSeq")
        if isinstance(seq, bool) or not isinstance(seq, int) or seq != expected:
            raise ValueError("ANALYTICS_EVENT_SEQUENCE_INVALID")
        expected += 1
    return events


def _metadata(
    room_id: str,
    key: str,
    epoch: str,
    version: int,
    through: int,
    watermark: str,
    *,
    requires_replay: bool = False,
    warnings: tuple[str, ...] = (),
    reason_codes: tuple[str, ...] = (),
) -> dict[str, Any]:
    merged_warnings = list(dict.fromkeys([
        *warnings,
        *(["requires_replay"] if requires_replay else []),
    ]))
    return {
        "roomId": room_id, "analysisEpoch": epoch,
        "algorithmVersion": ECHO_VERSION if key.startswith("echo.") else TRACE_VERSION,
        "parameterHash": PARAMETER_HASH, "projectionVersion": version,
        "baseVersion": version - 1, "completeThroughRoomSeq": through,
        "watermarkEventTime": watermark, "requiresReplay": requires_replay,
        "warnings": merged_warnings, "reasonCodes": list(reason_codes),
    }


def _enqueue_replay(
    connection: Any,
    room_id: str,
    source_event: Mapping[str, Any],
    *,
    reason: str,
    requested_through: int,
) -> None:
    """Insert one deterministic replay authority, idempotently.

    The consume transaction owns this helper so a late-event flag can never be
    committed without its replay job.  Review commands use the same shape and
    dedupe key; their direct server insert converges with this path.
    """
    if reason not in {"late_event", "artifact_available", "analytics_review", "operator_rebuild"}:
        raise ValueError("ANALYTICS_REPLAY_REASON_INVALID")
    event_id = str(source_event["eventId"])
    enqueue_analytics_replay(
        connection,
        room_id=room_id,
        source_event_id=event_id,
        requested_through_room_seq=requested_through,
        reason=reason,
        dedupe_token=event_id,
        correlation_id=str(source_event["correlationId"]),
    )


def _window_trace_reference(
    network: StreamingInteractionNetwork,
    window_start: str,
    window_end: str,
) -> dict[str, Any]:
    """Build all three TRACE reference views for one event-time window.

    The pinned reference implementation remains byte-for-byte immutable.  We
    therefore create a fresh instance and feed it the recorded immutable input
    tuples rather than adding a second, subtly different window algorithm to
    the reference module.  This keeps the production persistence seam honest:
    window filtering is explicit, while decay/view semantics stay owned by the
    reference ``snapshot`` implementation.
    """
    start = _parse_datetime(window_start, datetime.min.replace(tzinfo=timezone.utc)).timestamp()
    end = _parse_datetime(window_end, datetime.max.replace(tzinfo=timezone.utc)).timestamp()
    if start > end:
        raise ValueError("TRACE_WINDOW_INVALID")
    history = list(getattr(network, "_history", ()))
    selected = [
        item for item in history
        if start <= _parse_datetime(item.event.event_time, datetime.fromtimestamp(0, timezone.utc)).timestamp() <= end
    ]
    views: dict[str, Any] = {}
    for view in ("observed", "human_only", "lineage_adjusted"):
        clone = StreamingInteractionNetwork(
            network.relation_extractor,
            allowed_lateness=network.allowed_lateness,
            half_lives=dict(network.half_lives),
        )
        views[view] = clone.replay(selected, now=window_end, view=view).to_dict()
    return {"views": views}


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


def _review_allowlist(connection: Any, room_id: str, through: int) -> tuple[set[str], set[str]]:
    """Resolve teacher approvals into the ECHO student filter.

    Review details are teacher-only JSON.  The worker reads only the bounded
    decision/target fields needed to project approved edges and never emits
    rationale or corrected text into a student payload.
    """
    cursor = connection.execute(
        """SELECT d.validated_payload
           FROM analytics_review_detail d
           JOIN room_event e ON e.event_id=d.review_event_id AND e.room_id=d.room_id
          WHERE d.room_id=%s AND e.room_seq<=%s ORDER BY e.room_seq,d.review_detail_id""",
        (room_id, through),
    )
    approved_edges: set[str] = set()
    approved_nodes: set[str] = set()
    for row in cursor.fetchall():
        value = row if isinstance(row, Mapping) else row[0]
        if not isinstance(value, Mapping):
            continue
        decision = value.get("decision")
        target_type = value.get("targetType")
        target_id = value.get("targetId")
        if target_type == "projection" and isinstance(target_id, str):
            if decision in {"approve", "review_pass"}:
                approved_edges.add(target_id)
            elif decision in {"reject", "revoke", "review_fail"}:
                approved_edges.discard(target_id)
        if target_type == "evidence" and isinstance(target_id, str):
            # Evidence approvals are resolved against event IDs by the adapter
            # after extraction; retain a prefixed marker to avoid confusing an
            # event UUID with an edge UUID.
            if decision in {"approve", "review_pass"}:
                approved_edges.add("evidence:" + target_id)
            elif decision in {"reject", "revoke", "review_fail"}:
                approved_edges.discard("evidence:" + target_id)
        if target_type == "derived_text" and isinstance(target_id, str):
            artifact = connection.execute(
                "SELECT event_id FROM derived_text_artifact WHERE room_id=%s AND artifact_id=%s",
                (room_id, target_id),
            ).fetchone()
            if artifact:
                event_id = str(_row_value(artifact, "event_id", 0))
                if decision in {"approve", "review_pass"}:
                    approved_edges.add("evidence:" + event_id)
                elif decision in {"reject", "revoke", "review_fail"}:
                    approved_edges.discard("evidence:" + event_id)
    return approved_edges, approved_nodes


def _persist_direct_artifacts(connection: Any, room_id: str, events: list[dict[str, Any]]) -> None:
    """Materialize learner-authored text and deterministic extraction rows.

    Media/ASR/OCR artifacts are inserted by their reviewed upstream adapter;
    this function never invents a transcript.  Replaying the same event is
    idempotent and a revision deactivates only the prior active lineage.
    """
    for event in events:
        if str(event.get("roomId")) != room_id:
            raise ValueError("ANALYTICS_CROSS_ROOM_EVENT")
        artifact = maybe_derive_direct_text(event)
        if artifact is None:
            payload = event.get("payload") if isinstance(event.get("payload"), Mapping) else {}
            if event.get("operation") in {"retract", "delete"} or event.get("type") == "message.retracted":
                message_id = payload.get("messageId")
                if message_id:
                    # Direct-text lineage IDs are deterministic on messageId;
                    # mark the active artifact inactive without deleting the
                    # immutable evidence row.
                    from .derived_text import LINEAGE_NAMESPACE
                    lineage_id = str(uuid5(LINEAGE_NAMESPACE, str(message_id) + ":direct"))
                    connection.execute(
                        "UPDATE derived_text_artifact SET active=false WHERE room_id=%s AND lineage_id=%s AND active=true",
                        (room_id, lineage_id),
                    )
            continue
        value = artifact.to_dict()
        try:
            from .generated.derived_text_artifact_v1 import Artifact
            Artifact.from_dict(value)
        except (ImportError, ValueError, TypeError, KeyError) as error:
            raise ValueError("INVALID_DERIVED_TEXT_ARTIFACT") from error
        connection.execute(
            """UPDATE derived_text_artifact
               SET active=false
             WHERE room_id=%s AND lineage_id=%s AND active=true AND artifact_id<>%s""",
            (room_id, artifact.lineage_id, artifact.artifact_id),
        )
        connection.execute(
            """INSERT INTO derived_text_artifact(
                 artifact_id,lineage_id,event_id,room_id,room_seq,source_media_id,
                 source_modality,derivation,text_content,normalized_text_sha256,
                 source_confidence_raw,source_confidence_calibrated,provider,
                 model_version,language_tag,spans,review_status,display_status,
                 warnings,supersedes_artifact_id,active,created_at)
               VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (lineage_id,event_id,derivation,model_version,normalized_text_sha256)
               DO NOTHING""",
            (artifact.artifact_id, artifact.lineage_id, artifact.event_id, artifact.room_id,
             artifact.room_seq, artifact.source_media_id, artifact.source_modality,
             artifact.derivation, artifact.text, artifact.normalized_text_sha256,
             artifact.source_confidence_raw, artifact.source_confidence_calibrated,
             artifact.provider, artifact.model_version, artifact.language_tag,
             _jsonb(list(artifact.spans)), artifact.review_status, artifact.display_status,
             _jsonb(list(artifact.warnings)), artifact.supersedes_artifact_id,
             artifact.active, artifact.created_at),
        )


def _persist_extractions(connection: Any, room_id: str, chats: list[Any], seq_by_event: Mapping[str, int]) -> None:
    if not chats:
        return
    event_ids = [str(chat.event_id) for chat in chats]
    rows = connection.execute(
        "SELECT artifact_id,event_id FROM derived_text_artifact WHERE room_id=%s AND event_id=ANY(%s::uuid[]) AND active=true",
        (room_id, event_ids),
    ).fetchall()
    artifact_by_event = {
        str(_row_value(row, "event_id", 1)): str(_row_value(row, "artifact_id", 0))
        for row in rows
    }
    for chat in chats:
        artifact_id = artifact_by_event.get(str(chat.event_id))
        if not artifact_id:
            continue
        extracted = extract_echo(chat)
        extraction_id = str(uuid5(ANALYSIS_NAMESPACE, f"{artifact_id}:ECHO:{extracted['outputSha256']}"))
        connection.execute(
            """INSERT INTO extraction_artifacts(
                 extraction_id,artifact_id,room_id,room_seq,algorithm,
                 extractor_version,output,output_sha256,extraction_confidence_raw)
               VALUES(%s,%s,%s,%s,'ECHO-CM',%s,%s,%s,%s)
               ON CONFLICT (artifact_id,algorithm,extractor_version,output_sha256)
               DO NOTHING""",
            (extraction_id, artifact_id, room_id, int(seq_by_event.get(str(chat.event_id), 0)),
             extracted["output"]["extractorVersion"], _jsonb(extracted["output"]),
             extracted["outputSha256"], float(chat.source_confidence)),
        )


PROJECTION_KEYS = (
    "echo.teacher_shadow", "echo.student_approved",
    "trace.teacher_bundle", "trace.student_bundle",
)


def _current_or_initial_epoch(store: ProjectionStore, room_id: str) -> str:
    """Continue the currently visible epoch after a replay.

    A normal consume must never silently switch back to the room's initial
    UUID after a replay installed a new epoch.  All four heads are checked
    under the room lock; a partial/corrupt set is fail-closed rather than
    allowing one projection to roll back independently.
    """
    head_reader = getattr(store, "head", None)
    if not callable(head_reader):
        # Lightweight unit doubles predating the durable store expose only a
        # checkpoint method.  They cannot represent an installed replay epoch,
        # so retain the deterministic initial value for that test seam.
        return str(uuid5(ANALYSIS_NAMESPACE, room_id))
    heads = [head_reader(room_id, key) for key in PROJECTION_KEYS]
    present = [head for head in heads if head is not None]
    if not present:
        return str(uuid5(ANALYSIS_NAMESPACE, room_id))
    if len(present) != len(PROJECTION_KEYS):
        raise ValueError("ANALYTICS_HEAD_SET_INCOMPLETE")
    epochs = {str(head.get("analysis_epoch")) for head in present}
    if len(epochs) != 1:
        raise ValueError("ANALYTICS_HEAD_EPOCH_MISMATCH")
    return next(iter(epochs))


def _materialize(
    deps: WorkerDeps,
    room_id: str,
    through: int,
    epoch: str,
    *,
    enqueue_replay: bool = True,
) -> None:
    events = _canonical_events(deps.db, room_id, through)
    if not events or int(events[-1]["roomSeq"]) != through:
        raise ValueError("ANALYTICS_EVENT_SEQUENCE_INVALID")
    _persist_direct_artifacts(deps.db, room_id, events)
    projector = StreamingProjector(room_id)
    for event in events:
        projector.consume(event)
    requires_replay = bool(
        projector.state.echo.requires_replay or projector.state.trace.requires_replay
    )
    watermark = _iso(events[-1]["ingestTime"])
    watermark_dt = _parse_datetime(watermark, datetime.now(timezone.utc))
    room_row = deps.db.execute(
        "SELECT starts_at,closes_at FROM classroom_room WHERE room_id=%s", (room_id,)
    ).fetchone()
    room_start = _parse_datetime(
        _row_value(room_row, "starts_at", 0) if room_row is not None else None,
        watermark_dt - timedelta(seconds=2700),
    )
    room_close_value = _row_value(room_row, "closes_at", 1) if room_row is not None else None
    room_end = _parse_datetime(room_close_value, watermark_dt) if room_close_value else watermark_dt
    session_end = min(watermark_dt, room_end)
    session_start = min(room_start, session_end)
    recent_start = session_end - timedelta(seconds=600)
    window_bounds = {
        "recent_10m": {
            "windowStartEventTime": recent_start.isoformat().replace("+00:00", "Z"),
            "windowEndEventTime": session_end.isoformat().replace("+00:00", "Z"),
        },
        "session_45m": {
            "windowStartEventTime": session_start.isoformat().replace("+00:00", "Z"),
            "windowEndEventTime": session_end.isoformat().replace("+00:00", "Z"),
        },
    }
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
    _persist_extractions(
        deps.db, room_id, projector._chat_history,
        {str(event["eventId"]): int(event["roomSeq"]) for event in events},
    )
    pseudonyms, actor_mapping = _pseudonym_index(deps.db, room_id)
    approved_edges, approved_nodes = _review_allowlist(deps.db, room_id, through)
    # Scoped IDs include the epoch and are therefore rotated on replay.
    for actor, value in list(pseudonyms.items()):
        pseudonyms[actor] = {**value, "nodeId": scoped_node_id(
            _pseudonym_key(), room_id, epoch, actor)}
    # Keep the three reference views separate all the way to the wire
    # adapter.  In particular, ``lineage_adjusted`` is computed by the
    # network reference before aggregation (it can attribute an Agent summary
    # back to the originating learner); passing only the observed snapshot
    # would lose that provenance and could leak an Agent endpoint into the
    # student-safe branch.
    trace_references = {
        window: _window_trace_reference(
            projector.state.trace,
            bounds["windowStartEventTime"],
            bounds["windowEndEventTime"],
        )
        for window, bounds in window_bounds.items()
    }
    trace_evidence: dict[str, dict[str, Any]] = {}
    for event in events:
        payload = event.get("payload") if isinstance(event.get("payload"), Mapping) else {}
        text = payload.get("text") if isinstance(payload.get("text"), str) else ""
        if text:
            trace_evidence[str(event["eventId"])] = {
                "eventId": str(event["eventId"]), "start": 0,
                "end": len(text), "basis": "text_span",
            }
        else:
            # Metadata-only communication (for example an image/audio message
            # that has not received ASR/OCR) is evidence, but it has no text
            # offsets.  Marking it as event_metadata keeps the TRACE contract
            # honest instead of inventing a one-character span.
            trace_evidence[str(event["eventId"])] = {
                "eventId": str(event["eventId"]), "start": None,
                "end": None, "basis": "event_metadata",
            }
    # Stable epoch means normal consumes append to one chain; replay gets a
    # deterministic new epoch from the replay job id.
    for key in PROJECTION_KEYS:
        head = store.head(room_id, key)
        # A replay is a new immutable epoch.  Its first snapshot must start at
        # version 1 even when the previous epoch ended at a larger version;
        # ProjectionStore then swaps the room head with a CAS while retaining
        # every old-epoch snapshot for audit/recovery.
        current = int(head["version"]) if head and str(head.get("analysis_epoch")) == epoch else 0
        version = current + 1
        latest_event = events[-1]
        metadata = _metadata(
            room_id, key, epoch, version, through, watermark,
            requires_replay=requires_replay and enqueue_replay,
            warnings=tuple(projector.state.warnings),
        )
        if key.startswith("echo."):
            edge_approvals = {edge_id for edge_id in approved_edges if not edge_id.startswith("evidence:")}
            for edge in echo_internal.get("edges", ()):
                if any("evidence:" + ref in approved_edges for ref in edge.get("evidenceIds", ())):
                    edge_approvals.add(echo_wire_edge_id(room_id, edge))
            projected = project_echo_snapshot(
                echo_internal, metadata, echo_evidence,
                approved_edge_ids=edge_approvals, approved_node_ids=approved_nodes,
            )
            current_projection = projected["teacher" if key == "echo.teacher_shadow" else "student"]
            previous = store.snapshot_for_head(head.get("snapshot_id") if head else None) if head else None
            # Both ECHO views expose a contiguous patch chain.  The student
            # view is filtered before this diff, so a newly approved edge (or
            # endpoint) is represented without leaking teacher-only content;
            # omitting these patches would make the documented student
            # timeline endpoint resync on every version after the first.
            prior = {"payload": {"nodes": [], "edges": []}}
            if previous:
                prior = {"payload": previous.get("payload", {})}
            patch = diff_echo_snapshots(prior, current_projection, metadata)
            changed = any(
                patch.get(name)
                for name in (
                    "nodesAdded", "nodesUpdated", "nodesHidden",
                    "edgesAdded", "edgesUpdated", "edgesHidden",
                    "positionUpdates",
                )
            )
            reason_codes = (
                ("event_applied",) if changed
                else (f"semantic_noop:{latest_event.get('type', 'unknown')}",)
            )
            if requires_replay and "late_event" not in reason_codes:
                reason_codes = ("late_event", *reason_codes)
            metadata["reasonCodes"] = list(reason_codes)
            # Rebuild the patch after adding the reason code so its content
            # hash and persisted payload include the final explanation.
            patch = diff_echo_snapshots(prior, current_projection, metadata)
            store.persist_and_advance(snapshot=current_projection,
                                      payload_hash=store.content_hash(current_projection["payload"]),
                                      patch=patch,
                                      patch_hash=store.content_hash(patch) if patch else None)
        else:
            trace_teacher, trace_student = project_trace(
                trace_references,
                window_bounds,
                {**metadata, "teacherActorMapping": actor_mapping}, pseudonyms, trace_evidence, 4,
            )
            current_projection = trace_teacher if key == "trace.teacher_bundle" else trace_student
            store.persist_and_advance(snapshot=current_projection,
                                      payload_hash=store.content_hash(current_projection["payload"]))
    store.advance_checkpoint(room_id, through)
    if requires_replay and enqueue_replay:
        late_ids = tuple(projector.state.echo.requires_replay) or tuple(projector.state.trace.requires_replay)
        source_event = next(
            (event for event in events if str(event["eventId"]) in late_ids),
            events[-1],
        )
        _enqueue_replay(
            deps.db, room_id, source_event,
            reason="late_event", requested_through=through,
        )


def analytics_consume_handler(deps: WorkerDeps, job: WorkerJob) -> HandlerOutcome:
    if deps.claim is None:
        raise ValueError("ANALYTICS_JOB_PAYLOAD_INVALID")
    room_id, event_id, event_seq, event_type = _validate_consume_job(job)
    cursor = deps.db.execute(
        "SELECT room_id,room_seq,type,correlation_id FROM room_event WHERE event_id=%s",
        (event_id,),
    )
    row = cursor.fetchone()
    db_seq = _row_value(row, "room_seq", 1) if row is not None else None
    db_type = _row_value(row, "type", 2) if row is not None else None
    db_correlation = _row_value(row, "correlation_id", 3) if row is not None else None
    if row is None or not _same_uuid(_row_value(row, "room_id", 0), room_id) \
            or isinstance(db_seq, bool) or not isinstance(db_seq, int) or db_seq != event_seq \
            or db_type != event_type or not _same_uuid(db_correlation, job.correlation_id):
        raise ValueError("ANALYTICS_EVENT_NOT_FOUND")
    store = getattr(deps, "projection_store", None) or ProjectionStore(deps.db)
    target_seq = event_seq
    with _transaction(deps.db):
        # Room mutations and analytics heads share the canonical advisory
        # lock.  Re-read the checkpoint after acquiring it so a concurrent
        # room writer cannot make this claim compute from a stale cursor.
        lock_room_in_transaction(deps.db, room_id)
        checkpoint = store.checkpoint(room_id)
        if checkpoint >= target_seq:
            deps.job_claims.complete_business(deps.db, deps.claim.as_job_claim(), "ANALYTICS_CONSUMED")
            return HandlerOutcome.SUCCESS
        if checkpoint + 1 != target_seq:
            raise ValueError("ANALYTICS_CURSOR_GAP")
        epoch = _current_or_initial_epoch(store, room_id)
        _materialize(deps, room_id, target_seq, epoch, enqueue_replay=True)
        deps.job_claims.complete_business(deps.db, deps.claim.as_job_claim(), "ANALYTICS_CONSUMED")
    return HandlerOutcome.SUCCESS


def analytics_replay_handler(deps: WorkerDeps, job: WorkerJob) -> HandlerOutcome:
    if deps.claim is None:
        raise ValueError("ANALYTICS_REPLAY_PAYLOAD_INVALID")
    room_id, source_event_id, reason, requested = _validate_replay_job(job)
    authority = deps.db.execute(
        """SELECT room_id,source_event_id,reason,requested_through_room_seq,
                  dedupe_key,correlation_id
           FROM analytics_replay_request WHERE job_id=%s FOR UPDATE""",
        (job.job_id,),
    ).fetchone()
    if authority is None:
        raise ValueError("ANALYTICS_REPLAY_AUTHORITY_MISSING")
    authority_room = _row_value(authority, "room_id", 0)
    authority_source = _row_value(authority, "source_event_id", 1)
    authority_reason = _row_value(authority, "reason", 2)
    authority_requested = _row_value(authority, "requested_through_room_seq", 3)
    authority_dedupe = _row_value(authority, "dedupe_key", 4)
    authority_correlation = _row_value(authority, "correlation_id", 5)
    if not _same_uuid(authority_room, room_id) \
            or ((source_event_id is None) != (authority_source is None)) \
            or (source_event_id is not None and not _same_uuid(authority_source, source_event_id)) \
            or authority_reason != reason \
            or isinstance(authority_requested, bool) or not isinstance(authority_requested, int) \
            or authority_requested != requested \
            or authority_dedupe != job.dedupe_key \
            or not _same_uuid(authority_correlation, job.correlation_id):
        raise ValueError("ANALYTICS_REPLAY_AUTHORITY_INVALID")
    if source_event_id is not None:
        source = deps.db.execute(
            "SELECT room_id,room_seq FROM room_event WHERE event_id=%s", (source_event_id,)
        ).fetchone()
        source_seq = _row_value(source, "room_seq", 1) if source is not None else None
        if source is None or not _same_uuid(_row_value(source, "room_id", 0), room_id) \
                or isinstance(source_seq, bool) or not isinstance(source_seq, int) \
                or source_seq > requested:
            raise ValueError("ANALYTICS_REPLAY_AUTHORITY_INVALID")
    store = getattr(deps, "projection_store", None) or ProjectionStore(deps.db)
    with _transaction(deps.db):
        lock_room_in_transaction(deps.db, room_id)
        through = store.checkpoint(room_id)
        if through < requested:
            raise ValueError("ANALYTICS_REPLAY_CURSOR_BEHIND")
        epoch = str(uuid5(ANALYSIS_NAMESPACE, job.job_id))
        if hasattr(store, "head"):
            existing_heads = [store.head(room_id, key) for key in PROJECTION_KEYS]
            if all(head is not None and str(head.get("analysis_epoch")) == epoch
                   and int(head.get("complete_through_seq", 0)) >= through for head in existing_heads):
                deps.job_claims.complete_business(deps.db, deps.claim.as_job_claim(), "ANALYTICS_REPLAYED")
                return HandlerOutcome.SUCCESS
        _materialize(deps, room_id, through, epoch, enqueue_replay=False)
        deps.job_claims.complete_business(deps.db, deps.claim.as_job_claim(), "ANALYTICS_REPLAYED")
    return HandlerOutcome.SUCCESS


def register_analytics_handlers(registry: Any) -> Any:
    registry.register("analytics.consume.v1", analytics_consume_handler)
    registry.register("analytics.replay-room.v1", analytics_replay_handler)
    return registry


__all__ = ["analytics_consume_handler", "analytics_replay_handler", "register_analytics_handlers"]
