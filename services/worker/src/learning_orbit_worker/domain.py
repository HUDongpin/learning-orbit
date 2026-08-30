"""Small, JSON-compatible domain objects shared by the analytics adapters.

The worker deliberately keeps these objects independent of the wire schemas.
RoomEvent is a validated copy of the canonical server envelope; the ECHO/TRACE
reference classes remain in ``reference/`` and are only fed through adapters.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from math import isfinite
from typing import Any, Mapping


@dataclass(frozen=True)
class RoomEvent:
    event_id: str
    room_id: str
    room_seq: int
    type: str
    actor_id: str
    actor_kind: str
    actor_role: str | None
    revision: int
    operation: str
    event_time: str
    ingest_time: str
    causation_id: str
    correlation_id: str
    payload: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "RoomEvent":
        required = ("eventId", "roomId", "roomSeq", "type", "actorId",
                    "actorKind", "revision", "operation", "eventTime",
                    "ingestTime", "causationId", "correlationId", "payload")
        missing = [name for name in required if name not in value]
        if missing:
            raise ValueError("RoomEvent missing fields: " + ",".join(missing))
        room_seq = value["roomSeq"]
        revision = value["revision"]
        if isinstance(room_seq, bool) or not isinstance(room_seq, int) or room_seq < 1:
            raise ValueError("roomSeq must be a positive integer")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            raise ValueError("revision must be a positive integer")
        actor_kind = str(value["actorKind"])
        if actor_kind not in {"human", "agent", "system"}:
            raise ValueError("unsupported actorKind")
        payload = value["payload"]
        if not isinstance(payload, Mapping):
            raise ValueError("payload must be an object")
        return cls(
            event_id=str(value["eventId"]), room_id=str(value["roomId"]),
            room_seq=room_seq, type=str(value["type"]),
            actor_id=str(value["actorId"]), actor_kind=actor_kind,
            actor_role=None if value.get("actorRole") is None else str(value["actorRole"]),
            revision=revision, operation=str(value["operation"]),
            event_time=str(value["eventTime"]), ingest_time=str(value["ingestTime"]),
            causation_id=str(value["causationId"]),
            correlation_id=str(value["correlationId"]), payload=dict(payload),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "eventId": self.event_id, "roomId": self.room_id,
            "roomSeq": self.room_seq, "type": self.type,
            "actorId": self.actor_id, "actorKind": self.actor_kind,
            "actorRole": self.actor_role, "revision": self.revision,
            "operation": self.operation, "eventTime": self.event_time,
            "ingestTime": self.ingest_time, "causationId": self.causation_id,
            "correlationId": self.correlation_id, "payload": dict(self.payload),
        }


@dataclass(frozen=True)
class ProjectionMetadata:
    """Common immutable metadata attached to every projection snapshot."""
    room_id: str
    analysis_epoch: str
    algorithm_version: str
    parameter_hash: str
    projection_version: int
    base_version: int = 0
    complete_through_room_seq: int = 0
    watermark_event_time: str = ""
    requires_replay: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "roomId": self.room_id, "analysisEpoch": self.analysis_epoch,
            "algorithmVersion": self.algorithm_version, "parameterHash": self.parameter_hash,
            "projectionVersion": self.projection_version, "baseVersion": self.base_version,
            "completeThroughRoomSeq": self.complete_through_room_seq,
            "watermarkEventTime": self.watermark_event_time, "requiresReplay": self.requires_replay,
        }


@dataclass(frozen=True)
class WindowBounds:
    window_start_event_time: str
    window_end_event_time: str

    def to_dict(self) -> dict[str, str]:
        return {"windowStartEventTime": self.window_start_event_time, "windowEndEventTime": self.window_end_event_time}


def finite_number(value: Any, *, name: str = "value") -> float:
    """Return a finite float, rejecting booleans and NaN/Infinity."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be numeric")
    converted = float(value)
    if not isfinite(converted):
        raise ValueError(f"{name} must be finite")
    return converted


def iso_datetime(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        return value
    text = str(value).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError("invalid ISO timestamp") from exc
