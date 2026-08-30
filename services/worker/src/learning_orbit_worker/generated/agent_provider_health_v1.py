"""Generated-style closed parser for agent-provider-health.v1."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from re import fullmatch
from uuid import UUID

_FIELDS = {"probeId", "providerId", "manifestSha256", "health", "checkedAt", "reasonCode"}

@dataclass(frozen=True, slots=True)
class Request:
    probe_id: str; provider_id: str; manifest_sha256: str; health: str; checked_at: str; reason_code: str | None

    @classmethod
    def from_dict(cls, value: object) -> "Request":
        if not isinstance(value, dict) or set(value) != _FIELDS: raise ValueError("INVALID_AGENT_PROVIDER_HEALTH")
        try: UUID(value["probeId"])
        except (ValueError, TypeError, KeyError) as exc: raise ValueError("INVALID_AGENT_PROVIDER_HEALTH") from exc
        if not isinstance(value["providerId"], str) or not fullmatch(r"[a-z0-9._-]{1,64}", value["providerId"]): raise ValueError("INVALID_AGENT_PROVIDER_HEALTH")
        if not isinstance(value["manifestSha256"], str) or not fullmatch(r"[a-f0-9]{64}", value["manifestSha256"]): raise ValueError("INVALID_AGENT_PROVIDER_HEALTH")
        if value["health"] not in {"healthy", "degraded", "unavailable"} or not isinstance(value["checkedAt"], str): raise ValueError("INVALID_AGENT_PROVIDER_HEALTH")
        try: datetime.fromisoformat(value["checkedAt"].replace("Z", "+00:00"))
        except ValueError as exc: raise ValueError("INVALID_AGENT_PROVIDER_HEALTH") from exc
        reason = value["reasonCode"]
        if reason is not None and (not isinstance(reason, str) or not fullmatch(r"[A-Z0-9_]{1,64}", reason)): raise ValueError("INVALID_AGENT_PROVIDER_HEALTH")
        return cls(value["probeId"], value["providerId"], value["manifestSha256"], value["health"], value["checkedAt"], reason)
