"""Deterministic, provider-neutral Nova Agent shadow components.

These modules intentionally operate on immutable, JSON-compatible values.  They
can be wired to the durable AgentRun/worker-job implementation in Plan 04,
without making network calls or claiming that a draft is a learner message.
"""

from .contracts import AgentRun, AgentRunState, AgentTrigger, TriggerEvent
from .context import AgentContext, ContextEvent, build_context
from .artifacts import DerivedArtifact, build_asr_artifact, build_image_artifact, build_ocr_artifact
from .run import AgentRunner, CandidateResult
from .trigger import AgentTriggerCoordinator, TriggerError

__all__ = [
    "AgentContext",
    "AgentRun",
    "AgentRunState",
    "AgentRunner",
    "AgentTrigger",
    "AgentTriggerCoordinator",
    "CandidateResult",
    "ContextEvent",
    "DerivedArtifact",
    "TriggerError",
    "TriggerEvent",
    "build_context",
    "build_asr_artifact",
    "build_image_artifact",
    "build_ocr_artifact",
]
