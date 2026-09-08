"""Sample provider health and report it through the signed internal route.

Nothing sampled provider health, so `agent_provider_health` stayed empty and
every Agent request was refused 503 - correctly, but permanently. A probe that
reports `unavailable` is not a failure of this module: it is the honest state
of a provider nobody has configured, and it is the state the server needs to
see in order to say so for a reason rather than by default.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Mapping
from uuid import uuid4

from ..internal_http import INTERNAL_HTTP_DEFAULT_TIMEOUT_SECONDS
from .anthropic import PROBE_TIMEOUT_SECONDS, build_model_provider
from .manifest import ProviderManifest, load_provider_manifest
from .model import DEGRADED, HEALTHY, UNAVAILABLE

#: ``ProviderHealthRepository.current`` reads a sample older than thirty
#: seconds as ``unavailable``. The probe therefore has to run several times
#: inside that window: at the window's own length Nova would flicker between
#: answering and being refused with nothing actually wrong.
PROVIDER_HEALTH_INTERVAL_SECONDS = 10.0
#: What one call to :meth:`ProviderHealthProbe.run_once` can actually cost:
#: a provider probe that hangs to its own timeout, then a report that hangs to
#: the internal client's, plus a second for the loop around them. Whoever shuts
#: the probe thread down has to wait at least this long before calling it a
#: leak, or an ordinary shutdown arriving mid-sample would be reported as one.
PROVIDER_HEALTH_JOIN_SECONDS = (
    PROBE_TIMEOUT_SECONDS + INTERNAL_HTTP_DEFAULT_TIMEOUT_SECONDS + 1.0
)


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
    """Post one sample and return the server's decision.

    The route has its own subject, its own assertion lifetime and its own
    receipt shape, all of which belong to the client that speaks to it - a
    sample signed like a worker-job callback was refused before it was read,
    which is why `agent_provider_health` stayed empty however often this was
    called.
    """
    response = internal_http.post_provider_health(sample.as_body(), sample.provider_id)
    body = response.body
    if not isinstance(body, dict):
        raise ValueError("INTERNAL_HTTP_RESPONSE_SCHEMA")
    return str(body.get("status"))


class ProviderHealthProbe:
    """One sample of one reviewed provider, reported once.

    The probe callable is the provider's own: it is asked whether the provider
    answers, and it is the only thing that can produce `healthy`. Everything
    else this class can do - an absent credential, a probe that raises, a probe
    that returns something nobody recognises - ends in `unavailable` with a
    bounded reason.
    """

    def __init__(
        self,
        manifest: ProviderManifest,
        internal_http: Any,
        *,
        env: Mapping[str, str] | None = None,
        probe: Callable[[], str] | None = None,
    ) -> None:
        self.manifest = manifest
        self._internal_http = internal_http
        self._env = os.environ if env is None else env
        self._probe = probe

    def run_once(self) -> str:
        """Sample the provider and report it, returning the server's decision."""
        sample = sample_provider_health(self.manifest, self._env, probe=self._probe)
        return report_provider_health(self._internal_http, sample)


def build_provider_health_probe(
    internal_http: Any,
    env: Mapping[str, str] | None = None,
    *,
    provider_factory: Callable[[ProviderManifest], Any] | None = None,
) -> ProviderHealthProbe | None:
    """Compose the probe, or return None when no manifest has been reviewed.

    Absent is the state a pilot starts in, and the state it stays in until
    someone approves a provider: no manifest means no probe, no probe means no
    row in `agent_provider_health`, and no row means the server refuses every
    Agent request with a stated reason. Nothing here shortens that path.

    A manifest that is *present* but unreadable, malformed, or naming a
    provider this build cannot call is a different thing - always a mistake,
    never a deployment - and is raised here, the way a partly supplied media
    store is.
    """
    env = os.environ if env is None else env
    path = env.get("LO_AGENT_PROVIDER_MANIFEST")
    if not path:
        return None
    manifest = load_provider_manifest(path)
    factory = provider_factory or (lambda reviewed: build_model_provider(reviewed, env=env))
    provider = factory(manifest)
    # A provider that offers no probe is reported `PROBE_UNCONFIGURED`, never
    # assumed reachable.
    probe = getattr(provider, "probe", None)
    return ProviderHealthProbe(
        manifest, internal_http, env=env, probe=probe if callable(probe) else None,
    )
