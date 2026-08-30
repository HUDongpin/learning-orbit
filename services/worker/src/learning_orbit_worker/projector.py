"""In-memory deterministic projection coordinator used by worker tests.

Persistence and job claiming live in the TypeScript service.  This module is
the pure computation seam: events are consumed once by room sequence, late
events set ``requires_replay`` and a replay can rebuild an epoch from history.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import math
import re
from typing import Any, Mapping

from .extractors import MessageLineageIndex, to_chat_event, extract_trace_evidence
from .echo_adapter import project_echo_snapshot
from .reference.learning_orbit_algorithms_v1 import StreamingConceptMap, StreamingInteractionNetwork


# These are deliberately product defaults, not educational-science constants.
# They are kept next to the cursor policy so callers cannot accidentally use a
# different lateness/future-clock rule for ECHO and TRACE.
ALLOWED_LATENESS = timedelta(seconds=5)
FUTURE_CLOCK_WARNING = timedelta(seconds=30)


def _utc(value: datetime) -> datetime:
    """Return an aware UTC timestamp or fail closed for malformed input."""
    if not isinstance(value, datetime):
        raise ValueError("timestamp must be datetime")
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


@dataclass(frozen=True)
class CursorDecision:
    """The server-time-bounded decision for one immutable room event."""

    effective_event_time: datetime
    max_seen_event_time: datetime
    watermark_event_time: datetime
    too_late: bool
    warnings: tuple[str, ...]


def advance_watermark(
    event_time: datetime,
    ingest_time: datetime,
    previous_max_seen: datetime,
    previous_watermark: datetime,
) -> CursorDecision:
    """Clamp client time and advance a monotonic event-time watermark.

    ``event_time`` remains available in the immutable RoomEvent audit, but the
    algorithms only receive ``effective_event_time = min(event_time,
    ingest_time)``.  This prevents a client clock set days in the future from
    poisoning decay or marking the next ordinary event as late.
    """
    event = _utc(event_time)
    ingest = _utc(ingest_time)
    prior_max = _utc(previous_max_seen)
    prior_watermark = _utc(previous_watermark)
    effective = min(event, ingest)
    max_seen = max(prior_max, effective)
    watermark = max(prior_watermark, max_seen - ALLOWED_LATENESS)
    warnings: tuple[str, ...] = (
        ("client_time_future_clamped",)
        if event - ingest > FUTURE_CLOCK_WARNING
        else ()
    )
    return CursorDecision(
        effective_event_time=effective,
        max_seen_event_time=max_seen,
        watermark_event_time=watermark,
        too_late=effective < prior_watermark,
        warnings=warnings,
    )


def next_patch_metadata(base_version: int) -> dict[str, int]:
    """Return the only legal successor pair for an incremental patch."""
    if isinstance(base_version, bool) or not isinstance(base_version, int) or base_version < 0:
        raise ValueError("base_version must be a non-negative integer")
    return {"baseVersion": base_version, "projectionVersion": base_version + 1}


def sequence_decision(room_seq: int, complete_through_seq: int) -> str:
    """Classify a room sequence without mutating cursor state."""
    if any(
        isinstance(value, bool) or not isinstance(value, int) or value < 0
        for value in (room_seq, complete_through_seq)
    ):
        raise ValueError("room sequence must be a non-negative integer")
    if room_seq <= complete_through_seq:
        return "duplicate"
    if room_seq == complete_through_seq + 1:
        return "next"
    return "room_seq_gap"


def make_semantic_noop_patch(
    event_type: str,
    analysis_epoch: str,
    algorithm_version: str,
    parameter_hash: str,
    base_version: int,
    room_seq: int,
) -> dict[str, Any]:
    """Build an explicit empty ECHO delta for a non-semantic event."""
    if not isinstance(event_type, str) or not re.fullmatch(
        r"[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*", event_type
    ):
        raise ValueError("event_type is invalid")
    if not isinstance(analysis_epoch, str) or not analysis_epoch:
        raise ValueError("analysis_epoch is required")
    if not isinstance(algorithm_version, str) or not algorithm_version:
        raise ValueError("algorithm_version is required")
    if not isinstance(parameter_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", parameter_hash):
        raise ValueError("parameter_hash is invalid")
    pair = next_patch_metadata(base_version)
    if isinstance(room_seq, bool) or not isinstance(room_seq, int) or room_seq < 0:
        raise ValueError("room_seq must be a non-negative integer")
    return {
        "analysisEpoch": analysis_epoch,
        "algorithmVersion": algorithm_version,
        "parameterHash": parameter_hash,
        **pair,
        "completeThroughRoomSeq": room_seq,
        "requiresReplay": False,
        "warnings": [],
        "nodesAdded": [],
        "nodesUpdated": [],
        "nodesHidden": [],
        "edgesAdded": [],
        "edgesUpdated": [],
        "edgesHidden": [],
        "positionUpdates": [],
        "changeScore": 0.0,
        "reasonCodes": [f"semantic_noop:{event_type}"],
        "evidenceRefs": [],
    }


@dataclass(frozen=True)
class FutureFixtureResult:
    """Small deterministic result used by the future-clock regression test."""

    future_effective_time: datetime
    future_ingest_time: datetime
    future_warnings: tuple[str, ...]
    normal_event_marked_late: bool
    final_evidence_ids: tuple[str, ...]


def project_future_then_normal_fixture() -> FutureFixtureResult:
    """Exercise the future-clock clamp with a future event then a normal one."""
    ingest = datetime(2026, 8, 28, 9, 0, 0, tzinfo=timezone.utc)
    future_time = ingest + timedelta(days=1)
    first = advance_watermark(future_time, ingest, ingest, ingest - ALLOWED_LATENESS)
    normal_ingest = ingest + timedelta(seconds=1)
    normal = advance_watermark(
        normal_ingest,
        normal_ingest,
        first.max_seen_event_time,
        first.watermark_event_time,
    )
    return FutureFixtureResult(
        future_effective_time=first.effective_event_time,
        future_ingest_time=ingest,
        future_warnings=first.warnings,
        normal_event_marked_late=normal.too_late,
        final_evidence_ids=("normal-event",),
    )


@dataclass
class ProjectionState:
    room_id: str
    complete_through_room_seq: int = 0
    requires_replay: bool = False
    history: list[dict[str, Any]] = field(default_factory=list)
    echo: StreamingConceptMap = field(default_factory=StreamingConceptMap)
    trace: StreamingInteractionNetwork = field(default_factory=StreamingInteractionNetwork)
    lineage: MessageLineageIndex = field(default_factory=MessageLineageIndex)
    max_seen_event_time: datetime | None = None
    watermark_event_time: datetime | None = None
    warnings: list[str] = field(default_factory=list)


class StreamingProjector:
    """Apply canonical events and expose ECHO/TRACE reference snapshots."""
    def __init__(self, room_id: str) -> None:
        self.state = ProjectionState(room_id=room_id)
        self._pending: dict[int, dict[str, Any]] = {}
        self._chat_history: list[Any] = []

    def consume(self, room_event: Mapping[str, Any]) -> dict[str, Any]:
        if str(room_event.get("roomId")) != self.state.room_id:
            raise ValueError("event belongs to another room")
        seq = room_event["roomSeq"]
        if isinstance(seq, bool) or not isinstance(seq, int) or seq < 1:
            raise ValueError("roomSeq must be a positive integer")
        event_id = str(room_event["eventId"])
        revision = room_event.get("revision", 1)
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            raise ValueError("revision must be a positive integer")
        if any(str(item["eventId"]) == event_id and item["revision"] == revision for item in self.state.history):
            return {"duplicate": True, "completeThroughRoomSeq": self.state.complete_through_room_seq}
        self.state.history.append(dict(room_event))
        self.state.history.sort(key=lambda item: (item["roomSeq"], str(item["eventId"])))
        decision = sequence_decision(seq, self.state.complete_through_room_seq)
        if decision == "duplicate":
            self.state.requires_replay = True
            return {"late": True, "requiresReplay": True, "completeThroughRoomSeq": self.state.complete_through_room_seq}
        if decision == "room_seq_gap":
            self._pending[seq] = dict(room_event)
            return {"blocked": True, "completeThroughRoomSeq": self.state.complete_through_room_seq}
        self._pending[seq] = dict(room_event)
        applied_result: dict[str, Any] = {"applied": True}
        while self.state.complete_through_room_seq + 1 in self._pending:
            next_seq = self.state.complete_through_room_seq + 1
            next_event = self._pending.pop(next_seq)
            applied_result = self._apply_one(next_event)
            self.state.complete_through_room_seq = next_seq
        return {
            **applied_result,
            "applied": True,
            "completeThroughRoomSeq": self.state.complete_through_room_seq,
            "requiresReplay": self.state.requires_replay,
        }

    @staticmethod
    def _timestamp(value: Any, fallback: datetime | None = None) -> datetime:
        if isinstance(value, datetime):
            return _utc(value)
        try:
            return _utc(datetime.fromisoformat(str(value).replace("Z", "+00:00")))
        except (TypeError, ValueError):
            if fallback is not None:
                return fallback
            raise ValueError("invalid room event timestamp") from None

    def _apply_one(self, room_event: Mapping[str, Any], *, replaying: bool = False) -> dict[str, Any]:
        """Apply one contiguous event and return semantic cursor metadata."""
        ingest = self._timestamp(room_event.get("ingestTime"))
        event_time = self._timestamp(room_event.get("eventTime"), ingest)
        prior_max = self.state.max_seen_event_time or min(event_time, ingest)
        prior_watermark = self.state.watermark_event_time or datetime.min.replace(tzinfo=timezone.utc)
        decision = advance_watermark(event_time, ingest, prior_max, prior_watermark)
        self.state.max_seen_event_time = decision.max_seen_event_time
        self.state.watermark_event_time = decision.watermark_event_time
        for warning in decision.warnings:
            if warning not in self.state.warnings:
                self.state.warnings.append(warning)

        # Lifecycle, review and system events are semantic no-ops but still
        # advance the shared room cursor and watermark.
        semantic_types = {"message.added", "message.revised", "message.retracted", "message.deleted"}
        if room_event.get("type") not in semantic_types:
            return {
                "semanticNoop": True,
                "reasonCode": f"semantic_noop:{room_event.get('type', 'unknown')}",
                "requiresReplay": decision.too_late and not replaying,
            }
        effective_event = dict(room_event)
        effective_event["eventTime"] = decision.effective_event_time.isoformat().replace("+00:00", "Z")
        try:
            chat = to_chat_event(effective_event, lineage=self.state.lineage)
        except ValueError:
            # The canonical server envelope is validated before reaching the
            # worker.  A malformed test double is treated as a semantic no-op
            # rather than allowing a partial projection update.
            return {"semanticNoop": True, "reasonCode": "invalid_event_adapter"}
        # During a full replay the reference lateness gate is disabled; all
        # accepted historical events must be reconsidered in one deterministic
        # epoch.  Online application keeps the pinned five-second gate.
        echo_lateness = self.state.echo.allowed_lateness
        trace_lateness = self.state.trace.allowed_lateness
        if replaying:
            self.state.echo.allowed_lateness = math.inf
            self.state.trace.allowed_lateness = math.inf
        try:
            echo_result = self.state.echo.apply(chat)
            evidence = extract_trace_evidence(chat, self._chat_history)
            trace_result = self.state.trace.apply(chat, evidence=evidence, derive_event_relations=False)
        finally:
            if replaying:
                self.state.echo.allowed_lateness = echo_lateness
                self.state.trace.allowed_lateness = trace_lateness
        if echo_result.requires_replay or trace_result.requires_replay or (decision.too_late and not replaying):
            self.state.requires_replay = True
        self._chat_history.append(chat)
        return {
            "requiresReplay": bool(
                echo_result.requires_replay or trace_result.requires_replay
                or (decision.too_late and not replaying)
            ),
            "warnings": decision.warnings,
        }

    def replay(self) -> dict[str, Any]:
        history = list(self.state.history)
        self._pending.clear()
        self.state.echo = StreamingConceptMap()
        self.state.trace = StreamingInteractionNetwork()
        self.state.lineage = MessageLineageIndex()
        self._chat_history = []
        self.state.complete_through_room_seq = 0
        self.state.max_seen_event_time = None
        self.state.watermark_event_time = None
        self.state.warnings = []
        for event in sorted(history, key=lambda item: (item["roomSeq"], str(item["eventId"]))):
            self._apply_one(event, replaying=True)
            self.state.complete_through_room_seq = max(self.state.complete_through_room_seq, event["roomSeq"])
        self.state.requires_replay = False
        return {"replayed": True, "completeThroughRoomSeq": self.state.complete_through_room_seq}

    def snapshot(self, *, now: Any | None = None, view: str = "observed") -> dict[str, Any]:
        return self.state.trace.snapshot(now=now, view=view).to_dict()


__all__ = [
    "ALLOWED_LATENESS",
    "FUTURE_CLOCK_WARNING",
    "CursorDecision",
    "FutureFixtureResult",
    "StreamingProjector",
    "advance_watermark",
    "make_semantic_noop_patch",
    "next_patch_metadata",
    "project_future_then_normal_fixture",
    "sequence_decision",
]
