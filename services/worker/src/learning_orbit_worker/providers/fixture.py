"""Deterministic provider fixture for tests and local shadow demonstrations."""
from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence

from .model import ModelRequest, PreparedModelCall


class ProviderError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class ProviderCancelled(ProviderError):
    pass


class DeterministicFixtureProvider:
    provider_id = "fixture-socratic-v1"

    def __init__(self, chunks: Sequence[str], *, fail_code: str | None = None) -> None:
        self._chunks = tuple(chunks)
        self._fail_code = fail_code
        self.calls = 0

    def prepare(self, request: ModelRequest, provider_invocation_id: str) -> PreparedModelCall:
        if self._fail_code:
            raise ProviderError(self._fail_code)
        if not request.model_id or request.max_output_tokens < 1:
            raise ProviderError("MODEL_REQUEST_INVALID")
        self.calls += 1
        return PreparedModelCall(request, provider_invocation_id)

    def open_stream(self, call: PreparedModelCall, *, cancelled: Callable[[], bool] | None = None) -> Iterator[str]:
        for chunk in self._chunks:
            if cancelled and cancelled():
                raise ProviderCancelled("CANCELLED_BEFORE_FINAL")
            yield chunk
