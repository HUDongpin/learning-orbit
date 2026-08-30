"""Explicit trigger, one-active-run and cancellation semantics in memory.

This coordinator mirrors the server invariants while remaining deterministic
and side-effect free.  It is intentionally not a replacement for the durable
transaction in ``apps/server``.
"""
from __future__ import annotations

from dataclasses import replace
from threading import RLock
from uuid import NAMESPACE_URL, uuid5

from .contracts import AgentRun, AgentRunState, AgentTrigger, TriggerEvent


class TriggerError(ValueError):
    """Stable policy code suitable for mapping to an HTTP reject response."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class AgentTriggerCoordinator:
    def __init__(self, *, nova_actor_id: str) -> None:
        self.nova_actor_id = nova_actor_id
        self._lock = RLock()
        self._events: dict[str, TriggerEvent] = {}
        self._runs_by_trigger: dict[tuple[str, str], AgentRun] = {}
        self._runs: dict[str, AgentRun] = {}
        self._enabled: dict[str, bool] = {}
        self._room_status: dict[str, str] = {}

    def register_event(self, event: TriggerEvent) -> None:
        with self._lock:
            self._events[event.event_id] = event

    def set_enabled(self, room_id: str, enabled: bool) -> tuple[str, ...]:
        with self._lock:
            self._enabled[room_id] = enabled
            if enabled:
                return ()
            cancelled: list[str] = []
            for run in tuple(self._runs.values()):
                if run.room_id == room_id and run.state in {
                    AgentRunState.QUEUED, AgentRunState.RUNNING, AgentRunState.STREAMING,
                }:
                    self._runs[run.agent_run_id] = replace(
                        run, state=AgentRunState.CANCELLED, failure_code="AGENT_DISABLED",
                        version=run.version + 1,
                    )
                    self._runs_by_trigger[(run.room_id, run.trigger_event_id)] = self._runs[run.agent_run_id]
                    cancelled.append(run.agent_run_id)
            return tuple(cancelled)

    def set_room_status(self, room_id: str, status: str) -> None:
        if status not in {"scheduled", "open", "paused", "closed"}:
            raise TriggerError("ROOM_STATUS_INVALID")
        with self._lock:
            self._room_status[room_id] = status

    def request(self, trigger: AgentTrigger) -> AgentRun:
        with self._lock:
            event = self._events.get(trigger.trigger_event_id)
            if event is None or event.room_id != trigger.room_id or not event.active:
                raise TriggerError("TRIGGER_EVENT_NOT_FOUND")
            if self._room_status.get(trigger.room_id, "open") != "open":
                raise TriggerError("ROOM_NOT_OPEN")
            if event.actor_kind == "agent":
                raise TriggerError("AGENT_CANNOT_TRIGGER_AGENT")
            if not self._enabled.get(trigger.room_id, True):
                raise TriggerError("AGENT_DISABLED")
            explicit = self.nova_actor_id in event.mentions
            if trigger.requested_by_role != "teacher" and not explicit:
                raise TriggerError("EXPLICIT_TRIGGER_REQUIRED")
            key = (trigger.room_id, trigger.trigger_event_id)
            existing = self._runs_by_trigger.get(key)
            if existing is not None:
                return existing
            active = next((run for run in self._runs.values() if run.room_id == trigger.room_id and run.state in {
                AgentRunState.QUEUED, AgentRunState.RUNNING, AgentRunState.STREAMING,
            }), None)
            if active is not None:
                raise TriggerError("AGENT_RUN_ALREADY_ACTIVE")
            run_id = str(uuid5(NAMESPACE_URL, f"learning-orbit:agent:{trigger.room_id}:{trigger.trigger_event_id}"))
            run = AgentRun(
                agent_run_id=run_id, room_id=trigger.room_id,
                trigger_event_id=event.event_id,
                requested_by_actor_id=trigger.requested_by_actor_id,
                requested_by_role=trigger.requested_by_role,
                input_from_room_seq=1, input_through_room_seq=event.room_seq,
            )
            self._runs_by_trigger[key] = run
            self._runs[run_id] = run
            return run

    def transition(self, agent_run_id: str, state: AgentRunState, *, failure_code: str | None = None) -> AgentRun:
        with self._lock:
            run = self._runs.get(agent_run_id)
            if run is None:
                raise TriggerError("AGENT_RUN_NOT_FOUND")
            if run.state in {AgentRunState.COMPLETED, AgentRunState.BLOCKED_BY_POLICY, AgentRunState.CANCELLED, AgentRunState.FAILED}:
                return run
            if state == AgentRunState.COMPLETED and not self._enabled.get(run.room_id, True):
                state, failure_code = AgentRunState.CANCELLED, "AGENT_DISABLED"
            updated = replace(run, state=state, failure_code=failure_code, version=run.version + 1)
            self._runs[agent_run_id] = updated
            self._runs_by_trigger[(run.room_id, run.trigger_event_id)] = updated
            return updated

    def cancel(self, agent_run_id: str, *, reason: str = "CANCEL_REQUESTED") -> AgentRun:
        with self._lock:
            run = self._runs.get(agent_run_id)
            if run is None:
                raise TriggerError("AGENT_RUN_NOT_FOUND")
            if run.state in {AgentRunState.COMPLETED, AgentRunState.BLOCKED_BY_POLICY, AgentRunState.FAILED}:
                return run
            return self.transition(agent_run_id, AgentRunState.CANCELLED, failure_code=reason)

    def get(self, agent_run_id: str) -> AgentRun:
        with self._lock:
            try:
                return self._runs[agent_run_id]
            except KeyError as exc:
                raise TriggerError("AGENT_RUN_NOT_FOUND") from exc
