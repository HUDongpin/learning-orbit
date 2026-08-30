"""Closed shadow contracts used by the deterministic Agent slice.

The production JSON schemas are owned by the contracts package in Plan 04.  A
small local contract here lets the worker be tested before generated manifests
and server routes are integrated.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Mapping


class AgentRunState(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    STREAMING = "streaming"
    COMPLETED = "completed"
    BLOCKED_BY_POLICY = "blocked_by_policy"
    CANCELLED = "cancelled"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class TriggerEvent:
    event_id: str
    room_id: str
    room_seq: int
    actor_id: str
    actor_kind: str
    mentions: tuple[str, ...] = ()
    active: bool = True


@dataclass(frozen=True, slots=True)
class AgentTrigger:
    room_id: str
    trigger_event_id: str
    requested_by_actor_id: str
    requested_by_role: str


@dataclass(frozen=True, slots=True)
class AgentRun:
    agent_run_id: str
    room_id: str
    trigger_event_id: str
    requested_by_actor_id: str
    requested_by_role: str
    input_from_room_seq: int
    input_through_room_seq: int
    state: AgentRunState = AgentRunState.QUEUED
    source_event_ids: tuple[str, ...] = ()
    warning_codes: tuple[str, ...] = ()
    failure_code: str | None = None
    version: int = 1

    def to_wire(self) -> dict[str, Any]:
        """Return a closed, safe shape (no prompt, token, provider or cost)."""
        return {
            "agentRunId": self.agent_run_id,
            "roomId": self.room_id,
            "triggerEventId": self.trigger_event_id,
            "requestedByActorId": self.requested_by_actor_id,
            "requestedByRole": self.requested_by_role,
            "inputFromRoomSeq": self.input_from_room_seq,
            "inputThroughRoomSeq": self.input_through_room_seq,
            "state": self.state.value,
            "sourceEventIds": list(self.source_event_ids),
            "warningCodes": list(self.warning_codes),
            "failureCode": self.failure_code,
            "version": self.version,
        }


def assert_closed_mapping(value: Mapping[str, Any], allowed: set[str], *, name: str) -> None:
    """Reject extras before any state mutation; used by local shadow ports."""
    extras = set(value) - allowed
    if extras:
        raise ValueError(f"{name}_EXTRA_FIELDS:{','.join(sorted(extras))}")
