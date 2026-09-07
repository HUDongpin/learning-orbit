"""Sample provider health and report it through the signed internal route.

Nothing sampled provider health, so `agent_provider_health` stayed empty and
every Agent request was refused 503 - correctly, but permanently. A probe that
reports `unavailable` is not a failure of this module: it is the honest state
of a provider nobody has configured, and it is the state the server needs to
see in order to say so for a reason rather than by default.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Mapping
from uuid import uuid4

from .manifest import ProviderManifest

HEALTHY = "healthy"
DEGRADED = "degraded"
UNAVAILABLE = "unavailable"


@dataclass(frozen=True, slots=True)
class HealthSample:
    probe_id: str
    provider_id: str
    manifest_sha256: str
    health: str
    checked_at: str
    reason_code: str | None

    def as_body(self) -> dict[str, Any]:
        return {
            "probeId": self.probe_id,
            "providerId": self.provider_id,
            "manifestSha256": self.manifest_sha256,
            "health": self.health,
            "checkedAt": self.checked_at,
            "reasonCode": self.reason_code,
        }


def sample_provider_health(
    manifest: ProviderManifest,
    env: Mapping[str, str],
    *,
    probe: Callable[[], str] | None = None,
    now: Callable[[], datetime] | None = None,
) -> HealthSample:
    """Decide this provider's health without ever reading its credential value.

    The order matters. A missing credential is reported as `unavailable` before
    any network call is attempted, so an unconfigured provider never produces a
    request that could be mistaken for a real outage - and never sends anything
    anywhere.
    """
    checked_at = (now or (lambda: datetime.now(timezone.utc))
                  )().astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    base = {
        "probe_id": str(uuid4()),
        "provider_id": manifest.provider_id,
        "manifest_sha256": manifest.sha256,
        "checked_at": checked_at,
    }
    if not manifest.credential_present(env):
        return HealthSample(**base, health=UNAVAILABLE, reason_code="CREDENTIAL_ABSENT")
    if probe is None:
        return HealthSample(**base, health=UNAVAILABLE, reason_code="PROBE_UNCONFIGURED")
    try:
        result = probe()
    except Exception:  # noqa: BLE001 - any probe failure is an unavailable provider
        return HealthSample(**base, health=UNAVAILABLE, reason_code="PROBE_FAILED")
    if result not in {HEALTHY, DEGRADED, UNAVAILABLE}:
        return HealthSample(**base, health=UNAVAILABLE, reason_code="PROBE_RESULT_INVALID")
    reason = None if result == HEALTHY else "PROBE_REPORTED_" + result.upper()
    return HealthSample(**base, health=result, reason_code=reason)


def report_provider_health(internal_http: Any, sample: HealthSample) -> str:
    """Post one sample and return the server's decision."""
    response = internal_http.post(
        "/internal/agent/provider-health",
        "internal.agent.health",
        sample.as_body(),
        _ProbeSubject(sample.provider_id),
    )
    body = response.body
    if not isinstance(body, dict):
        raise ValueError("INTERNAL_HTTP_RESPONSE_SCHEMA")
    return str(body.get("status"))


@dataclass(frozen=True, slots=True)
class _ProbeSubject:
    """A health probe is signed for the provider, not for a worker job."""
    worker_id: str
