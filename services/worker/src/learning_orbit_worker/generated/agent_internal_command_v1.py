"""Generated-style closed parser for agent-internal-command.v1."""
from __future__ import annotations

from dataclasses import dataclass
from re import fullmatch
from uuid import UUID

_FIELDS = {"jobId", "jobType", "roomId", "sourceEventId", "dedupeKey", "agentRunId", "correlationId", "claimGeneration", "claimToken", "workerId", "text", "outputSha256", "sourceEventIds", "warningCodes"}

def _uuid(value: object) -> str:
    if not isinstance(value, str): raise ValueError("INVALID_AGENT_INTERNAL_COMMAND")
    try: UUID(value)
    except ValueError as exc: raise ValueError("INVALID_AGENT_INTERNAL_COMMAND") from exc
    return value

@dataclass(frozen=True, slots=True)
class Request:
    job_id: str; job_type: str; room_id: str; source_event_id: str; dedupe_key: str
    agent_run_id: str; correlation_id: str; claim_generation: str; claim_token: str
    worker_id: str; text: str; output_sha256: str; source_event_ids: tuple[str, ...]; warning_codes: tuple[str, ...]

    @classmethod
    def from_dict(cls, value: object) -> "Request":
        if not isinstance(value, dict) or set(value) != _FIELDS: raise ValueError("INVALID_AGENT_INTERNAL_COMMAND")
        for key in ("jobId", "roomId", "sourceEventId", "agentRunId", "correlationId", "claimToken"): _uuid(value[key])
        if value["jobType"] != "agent.execute.v1" or not isinstance(value["dedupeKey"], str) or not fullmatch(r"agent\.execute\.v1:[0-9a-f-]{36}", value["dedupeKey"]): raise ValueError("INVALID_AGENT_INTERNAL_COMMAND")
        if not isinstance(value["claimGeneration"], str) or not fullmatch(r"[1-9][0-9]{0,18}", value["claimGeneration"]): raise ValueError("INVALID_AGENT_INTERNAL_COMMAND")
        if not isinstance(value["workerId"], str) or not 0 < len(value["workerId"]) <= 128 or not isinstance(value["text"], str) or not 0 < len(value["text"]) <= 4000 or not isinstance(value["outputSha256"], str) or not fullmatch(r"[a-f0-9]{64}", value["outputSha256"]): raise ValueError("INVALID_AGENT_INTERNAL_COMMAND")
        ids = value["sourceEventIds"]; warnings = value["warningCodes"]
        if not isinstance(ids, list) or not 1 <= len(ids) <= 30 or len(set(ids)) != len(ids) or any(not isinstance(item, str) for item in ids): raise ValueError("INVALID_AGENT_INTERNAL_COMMAND")
        if any(_uuid(item) != item for item in ids): raise ValueError("INVALID_AGENT_INTERNAL_COMMAND")
        if not isinstance(warnings, list) or len(warnings) > 10 or len(set(warnings)) != len(warnings) or any(not isinstance(item, str) or not fullmatch(r"[A-Z0-9_]{1,64}", item) for item in warnings): raise ValueError("INVALID_AGENT_INTERNAL_COMMAND")
        return cls(value["jobId"], value["jobType"], value["roomId"], value["sourceEventId"], value["dedupeKey"], value["agentRunId"], value["correlationId"], value["claimGeneration"], value["claimToken"], value["workerId"], value["text"], value["outputSha256"], tuple(ids), tuple(warnings))
