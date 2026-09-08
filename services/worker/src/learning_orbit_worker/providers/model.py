"""Provider-neutral request and call values (no network implementation)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterator, Protocol

#: The health vocabulary the server stores. It lives here rather than beside
#: the sampler because both sides need it - the adapter that answers a probe
#: and the sampler that reports on the adapter's behalf - and a second copy of
#: three strings that cross a service boundary is a defect waiting to happen.
HEALTHY = "healthy"
DEGRADED = "degraded"
UNAVAILABLE = "unavailable"


@dataclass(frozen=True, slots=True)
class ModelRequest:
    model_id: str
    system: str
    messages: tuple[dict[str, str], ...]
    max_output_tokens: int = 512


@dataclass(frozen=True, slots=True)
class PreparedModelCall:
    request: ModelRequest
    provider_invocation_id: str


class ModelProvider(Protocol):
    provider_id: str

    def prepare(self, request: ModelRequest, provider_invocation_id: str) -> PreparedModelCall: ...

    def open_stream(self, call: PreparedModelCall, *, cancelled: Callable[[], bool] | None = None) -> Iterator[str]: ...
