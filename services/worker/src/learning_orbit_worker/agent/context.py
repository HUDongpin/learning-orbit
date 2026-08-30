"""Bounded, provenance-preserving Agent context assembly."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from ..domain import RoomEvent


@dataclass(frozen=True, slots=True)
class ContextEvent:
    event_id: str
    room_seq: int
    actor_id: str
    actor_kind: str
    text: str
    source_event_id: str


@dataclass(frozen=True, slots=True)
class ApprovedArtifact:
    artifact_id: str
    source_event_id: str
    text: str
    derivation: str


@dataclass(frozen=True, slots=True)
class AgentContext:
    room_id: str
    source_range: tuple[int, int]
    events: tuple[ContextEvent, ...]
    approved_artifacts: tuple[ApprovedArtifact, ...] = ()

    @property
    def rendered(self) -> str:
        lines = [f"[{e.room_seq}] {e.actor_kind}:{e.actor_id} — {e.text}" for e in self.events]
        if self.approved_artifacts:
            lines.append("Approved evidence:")
            lines.extend(f"[{a.source_event_id}] {a.text}" for a in self.approved_artifacts)
        return "\n".join(lines)


def _event(value: RoomEvent | Mapping[str, Any]) -> RoomEvent:
    return value if isinstance(value, RoomEvent) else RoomEvent.from_dict(value)


def build_context(
    room_id: str,
    events: Iterable[RoomEvent | Mapping[str, Any]],
    *,
    through_seq: int,
    max_events: int = 30,
    approved_artifacts: Iterable[Mapping[str, Any]] = (),
) -> AgentContext:
    """Select only active message events in the authorized room and seq range.

    Retractions are represented by an event with ``operation='retract'`` and
    ``payload.messageId``.  They remove the prior message from context; later
    corrections can re-add a distinct active revision with provenance intact.
    """
    if through_seq < 1 or max_events < 1:
        raise ValueError("INVALID_CONTEXT_BOUNDS")
    parsed = sorted((_event(item) for item in events), key=lambda item: item.room_seq)
    active_message_ids: set[str] = set()
    latest: dict[str, RoomEvent] = {}
    for item in parsed:
        if item.room_id != room_id or item.room_seq > through_seq or item.type != "message.added" and item.type != "message.revised" and item.type != "message.retracted":
            continue
        message_id = str(item.payload.get("messageId", item.event_id))
        if item.operation == "retract" or item.type == "message.retracted":
            active_message_ids.discard(message_id)
            latest.pop(message_id, None)
        elif item.operation in {"add", "revise"} and item.payload.get("text") is not None:
            active_message_ids.add(message_id)
            latest[message_id] = item
    selected_events = sorted((item for message_id, item in latest.items() if message_id in active_message_ids), key=lambda item: item.room_seq)[-max_events:]
    if not selected_events:
        raise ValueError("NO_ACTIVE_CONTEXT")
    context_events = tuple(ContextEvent(
        event_id=item.event_id, room_seq=item.room_seq, actor_id=item.actor_id,
        actor_kind=item.actor_kind, text=str(item.payload.get("text", "")),
        source_event_id=item.event_id,
    ) for item in selected_events)
    allowed_sources = {item.event_id for item in selected_events}
    artifacts: list[ApprovedArtifact] = []
    for artifact in approved_artifacts:
        source = str(artifact.get("sourceEventId", ""))
        if source not in allowed_sources or artifact.get("reviewStatus") != "approved":
            continue
        artifacts.append(ApprovedArtifact(
            artifact_id=str(artifact.get("artifactId", "")), source_event_id=source,
            text=str(artifact.get("text", "")), derivation=str(artifact.get("derivation", "")),
        ))
    return AgentContext(room_id, (context_events[0].room_seq, context_events[-1].room_seq), context_events, tuple(artifacts))
