"""Memory-only Agent candidate orchestration for the Plan 04 shadow gate."""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from threading import RLock
from typing import Callable

from ..providers.fixture import ProviderCancelled, ProviderError
from ..providers.model import ModelRequest, ModelProvider
from ..safety.policy import SafetyDecision, evaluate_agent_output
from .context import AgentContext
from .contracts import AgentRun, AgentRunState
from .trigger import AgentTriggerCoordinator


@dataclass(frozen=True, slots=True)
class CandidateResult:
    state: AgentRunState
    text: str = ""
    output_sha256: str | None = None
    source_event_ids: tuple[str, ...] = ()
    warning_codes: tuple[str, ...] = ()
    failure_code: str | None = None
    safety: SafetyDecision | None = None


class AgentRunner:
    """Runs a deterministic provider and returns an uncommitted candidate.

    ``submit`` is intentionally absent: only the server's authenticated final
    command may convert this candidate to a RoomEvent.  This prevents provider
    text from masquerading as student-authored content.
    """

    def __init__(self, coordinator: AgentTriggerCoordinator, provider: ModelProvider, *, model_id: str = "fixture-socratic-v1", policy_version: str = "socratic-policy-v1") -> None:
        self.coordinator = coordinator
        self.provider = provider
        self.model_id = model_id
        self.policy_version = policy_version
        self._results: dict[str, CandidateResult] = {}
        self._lock = RLock()

    def execute(self, run: AgentRun, context: AgentContext, *, cancelled: Callable[[], bool] | None = None) -> CandidateResult:
        # A response-loss retry may invoke the same runner concurrently.  The
        # lock keeps provider invocation idempotent while cancellation still
        # propagates through the coordinator's independent lock.
        with self._lock:
            existing = self._results.get(run.agent_run_id)
            if existing is not None:
                return existing
            current = self.coordinator.get(run.agent_run_id)
            if current.state in {AgentRunState.CANCELLED, AgentRunState.COMPLETED, AgentRunState.BLOCKED_BY_POLICY, AgentRunState.FAILED}:
                result = CandidateResult(current.state, failure_code=current.failure_code)
                self._results[run.agent_run_id] = result
                return result
            if cancelled and cancelled():
                self.coordinator.cancel(run.agent_run_id, reason="CANCEL_REQUESTED")
                result = CandidateResult(AgentRunState.CANCELLED, failure_code="CANCEL_REQUESTED")
                self._results[run.agent_run_id] = result
                return result
            self.coordinator.transition(run.agent_run_id, AgentRunState.RUNNING)
            request = ModelRequest(
                model_id=self.model_id,
                system="Ask for evidence; connect views; surface contradictions; summarize without supplying the answer.",
                messages=({"role": "user", "content": context.rendered},),
            )
            try:
                call = self.provider.prepare(request, run.agent_run_id)
                self.coordinator.transition(run.agent_run_id, AgentRunState.STREAMING)
                chunks: list[str] = []
                for chunk in self.provider.open_stream(call, cancelled=cancelled):
                    chunks.append(chunk)
                text = "".join(chunks).strip()
            except ProviderCancelled as exc:
                self.coordinator.cancel(run.agent_run_id, reason=exc.code)
                result = CandidateResult(AgentRunState.CANCELLED, failure_code=exc.code)
                self._results[run.agent_run_id] = result
                return result
            except ProviderError as exc:
                self.coordinator.transition(run.agent_run_id, AgentRunState.FAILED, failure_code=exc.code)
                result = CandidateResult(AgentRunState.FAILED, failure_code=exc.code)
                self._results[run.agent_run_id] = result
                return result
            decision = evaluate_agent_output(text, policy_version=self.policy_version)
            if decision.action == "hold":
                self.coordinator.transition(run.agent_run_id, AgentRunState.BLOCKED_BY_POLICY, failure_code=decision.reason_codes[0])
                result = CandidateResult(AgentRunState.BLOCKED_BY_POLICY, warning_codes=decision.reason_codes, failure_code=decision.reason_codes[0], safety=decision)
                self._results[run.agent_run_id] = result
                return result
            result = CandidateResult(
                AgentRunState.COMPLETED, text=text,
                output_sha256=sha256(text.encode("utf-8")).hexdigest(),
                source_event_ids=tuple(event.event_id for event in context.events),
                warning_codes=decision.reason_codes, safety=decision,
            )
            self.coordinator.transition(run.agent_run_id, AgentRunState.COMPLETED)
            self._results[run.agent_run_id] = result
            return result
