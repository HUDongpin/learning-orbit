"""One reviewed model provider behind the manifest: the Anthropic Messages API.

What this module is careful about is not the request format — that part is
mechanical — but everything around it.

The credential is *named* by the manifest and read from the environment at the
moment of the call. It is never stored on an instance, never placed in a
dataclass that something might repr, never attached to a span, and never
included in an error. The same rule applies in the other direction: a provider
error body can echo the prompt it was sent, so no response body ever reaches an
exception message, a log line, or a caller. Errors are bounded codes.

The transport is the standard library. The Anthropic SDK would add packages to
a hash-pinned lock for a process that handles classroom content, and the
Messages API over SSE is a small, stable surface — the same trade this
repository already made for SigV4 and for OTLP export.

Streaming exists so a cancelled run stops costing tokens: cancellation is
checked between chunks, and the response is closed rather than drained.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator, Mapping
from typing import Any

from .fixture import ProviderCancelled, ProviderError
from .manifest import (
    IMPLEMENTED_REMOTE_COPY_MODES,
    REMOTE_COPY_MODES,
    ProviderManifest,
)
from .model import DEGRADED, HEALTHY, UNAVAILABLE, ModelRequest, PreparedModelCall

API_VERSION = "2023-06-01"
DEFAULT_ENDPOINT = "https://api.anthropic.com"
#: A Socratic turn is short. A larger ceiling would mostly buy a longer wait
#: before a cancelled run notices it was cancelled.
MAX_STREAM_BYTES = 4 * 1024 * 1024
CONNECT_TIMEOUT_SECONDS = 30.0
#: A probe waits far less than a completion. The server treats a sample older
#: than thirty seconds as no sample at all, so a probe that hung for the
#: completion timeout would not report late - it would not report.
PROBE_TIMEOUT_SECONDS = 5.0
#: A 30x is refused rather than followed, on both the probe and the streaming
#: path, and never reduced to anything a caller could read as reachable.
PROVIDER_REDIRECT_REFUSED = "PROVIDER_REDIRECT_REFUSED"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse every 30x rather than replaying the request somewhere else.

    ``urlopen`` follows redirects and carries the request headers with it, so a
    30x from the provider endpoint would hand the manifest-named credential to
    whatever host ``Location`` names - in plaintext, if it names ``http`` - and
    a 200 from that host would then be reported as a healthy reviewed model.
    Returning None turns the redirect into an ``HTTPError`` the callers below
    reduce to a bounded code that is never `healthy`. This mirrors the same
    handler the internal HTTP client already installs.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _no_redirect_opener() -> urllib.request.OpenerDirector:
    """An opener that follows nothing: the credential leaves for one host only."""
    return urllib.request.build_opener(_NoRedirect())


class AnthropicMessagesProvider:
    """A :class:`~.model.ModelProvider` backed by the Anthropic Messages API."""

    def __init__(
        self,
        manifest: ProviderManifest,
        *,
        env: Mapping[str, str] | None = None,
        endpoint: str = DEFAULT_ENDPOINT,
        transport: Callable[[str, bytes, dict[str, str]], Iterator[bytes]] | None = None,
        probe_transport: Callable[[str, dict[str, str]], int] | None = None,
        timeout_seconds: float = CONNECT_TIMEOUT_SECONDS,
    ) -> None:
        if manifest.remote_copy_mode not in REMOTE_COPY_MODES:
            raise ProviderError("PROVIDER_COPY_MODE_UNREVIEWED")
        if manifest.remote_copy_mode not in IMPLEMENTED_REMOTE_COPY_MODES:
            # `delete_and_probe` reaches here as a mode the contracts describe
            # and this build cannot deliver: nothing in this repository deletes
            # a remote copy or probes that the deletion took. Running under it
            # would make the manifest assert a deletion guarantee no code
            # performs, so the adapter refuses to be constructed at all. The
            # mode is not wrong in principle - see IMPLEMENTED_REMOTE_COPY_MODES
            # in `manifest.py` for exactly what to implement to re-enable it.
            # A manifest parsed from disk is already refused by the loader; this
            # is the second door, for a ProviderManifest built in memory.
            raise ProviderError("PROVIDER_COPY_MODE_UNIMPLEMENTED")
        if not endpoint.startswith("https://"):
            # A provider call carries classroom text off this machine; plaintext
            # is not a configuration this adapter offers, not even locally.
            raise ProviderError("PROVIDER_ENDPOINT_INSECURE")
        self.provider_id = manifest.provider_id
        self._manifest = manifest
        # The mapping is held, not the credential: reading it later means a
        # rotated key takes effect without rebuilding the provider, and means
        # no instance of this class ever holds a secret.
        self._env = env if env is not None else os.environ
        self._endpoint = endpoint.rstrip("/")
        self._transport = transport or self._https_stream
        self._probe_transport = probe_transport or self._https_status
        self._timeout_seconds = timeout_seconds

    # -- preparation -------------------------------------------------------

    def prepare(self, request: ModelRequest, provider_invocation_id: str) -> PreparedModelCall:
        """Validate the call against the manifest before anything is sent.

        The manifest is the reviewed thing. A request naming a different model,
        or asking for more output than was reviewed, is refused here rather
        than quietly sent — otherwise the review would describe one system and
        the classroom would run another.
        """
        if not provider_invocation_id:
            raise ProviderError("PROVIDER_INVOCATION_ID_REQUIRED")
        if request.model_id != self._manifest.model_id:
            raise ProviderError("MODEL_NOT_IN_MANIFEST")
        if request.max_output_tokens < 1 or request.max_output_tokens > self._manifest.max_output_tokens:
            raise ProviderError("MODEL_OUTPUT_CEILING_EXCEEDED")
        if not request.messages:
            raise ProviderError("MODEL_REQUEST_INVALID")
        for message in request.messages:
            if message.get("role") not in {"user", "assistant"} or not isinstance(message.get("content"), str):
                raise ProviderError("MODEL_REQUEST_INVALID")
        if not self._manifest.credential_present(self._env):
            # The same code the health probe reports, so an unconfigured
            # provider looks the same from both directions.
            raise ProviderError("CREDENTIAL_ABSENT")
        return PreparedModelCall(request, provider_invocation_id)

    # -- streaming ---------------------------------------------------------

    def open_stream(
        self,
        call: PreparedModelCall,
        *,
        cancelled: Callable[[], bool] | None = None,
    ) -> Iterator[str]:
        if cancelled and cancelled():
            raise ProviderCancelled("CANCELLED_BEFORE_FINAL")
        body = json.dumps(self._payload(call.request)).encode("utf-8")
        headers = self._headers(call)
        try:
            lines = self._transport(f"{self._endpoint}/v1/messages", body, headers)
        except ProviderError:
            raise
        except Exception as error:  # noqa: BLE001 - never surface a provider body
            raise ProviderError(_transport_code(error)) from None
        return self._decode(lines, cancelled)

    def _payload(self, request: ModelRequest) -> dict[str, Any]:
        return {
            "model": request.model_id,
            "max_tokens": request.max_output_tokens,
            "system": request.system,
            "messages": [{"role": m["role"], "content": m["content"]} for m in request.messages],
            "stream": True,
        }

    def _headers(self, call: PreparedModelCall) -> dict[str, str]:
        credential = self._env.get(self._manifest.credential_env_var) or ""
        if not credential:
            raise ProviderError("CREDENTIAL_ABSENT")
        return {
            "content-type": "application/json",
            "accept": "text/event-stream",
            "anthropic-version": API_VERSION,
            "x-api-key": credential,
            # Correlates a provider-side record with this run without carrying
            # a room, a student, or any content.
            "anthropic-client-request-id": call.provider_invocation_id,
        }

    def _decode(self, lines: Iterator[bytes], cancelled: Callable[[], bool] | None) -> Iterator[str]:
        seen = 0
        for line in lines:
            seen += len(line)
            if seen > MAX_STREAM_BYTES:
                raise ProviderError("PROVIDER_STREAM_TOO_LARGE")
            if cancelled and cancelled():
                # Closing the iterator stops the request; a cancelled run must
                # not keep paying for tokens nobody will read.
                close = getattr(lines, "close", None)
                if callable(close):
                    close()
                raise ProviderCancelled("CANCELLED_BEFORE_FINAL")
            text = self._chunk(line)
            if text:
                yield text

    @staticmethod
    def _chunk(line: bytes) -> str | None:
        """Pull the text out of one SSE line, or return None for everything else.

        Unknown event types are ignored rather than treated as errors: the API
        may add them, and a Socratic turn that fails because of a new
        housekeeping event would be a self-inflicted outage.
        """
        if not line.startswith(b"data:"):
            return None
        raw = line[5:].strip()
        if not raw or raw == b"[DONE]":
            return None
        try:
            event = json.loads(raw)
        except ValueError:
            raise ProviderError("PROVIDER_STREAM_MALFORMED") from None
        if not isinstance(event, dict):
            raise ProviderError("PROVIDER_STREAM_MALFORMED")
        if event.get("type") == "error":
            # The provider's message can quote what it was sent; only the type
            # is kept, and only after being reduced to a bounded code.
            kind = (event.get("error") or {}).get("type")
            raise ProviderError(_error_code(kind))
        if event.get("type") != "content_block_delta":
            return None
        delta = event.get("delta") or {}
        text = delta.get("text")
        return text if isinstance(text, str) and text else None

    # -- health ------------------------------------------------------------

    def probe(self) -> str:
        """Report whether the reviewed model is reachable with this credential.

        A probe is not a completion. It sends no prompt, spends no tokens and
        reads no response body: it asks the models endpoint for the one model
        the manifest names, which is the smallest question that still proves
        the network path, the credential and the reviewed model at once.

        Only the status code is read. A provider's error body can quote what it
        was sent, so nothing but the status ever leaves this method - and the
        credential is read here, at the moment of the call, exactly as a
        completion reads it.
        """
        credential = self._env.get(self._manifest.credential_env_var) or ""
        if not credential:
            raise ProviderError("CREDENTIAL_ABSENT")
        model = urllib.parse.quote(self._manifest.model_id, safe="")
        status = self._probe_transport(
            f"{self._endpoint}/v1/models/{model}",
            {
                "accept": "application/json",
                "anthropic-version": API_VERSION,
                "x-api-key": credential,
            },
        )
        return _probe_health(status)

    def _https_status(self, url: str, headers: dict[str, str]) -> int:
        request = urllib.request.Request(url, method="GET", headers=headers)
        try:
            with _no_redirect_opener().open(request, timeout=PROBE_TIMEOUT_SECONDS) as response:  # noqa: S310
                status = int(response.status)
        except urllib.error.HTTPError as error:
            # The body is closed rather than drained: a refusal can quote the
            # request that caused it, and only the status is wanted here. A
            # 30x arrives this way precisely because it was not followed.
            error.close()
            status = int(error.code)
        if 300 <= status < 400:
            # The credential went to one host only, and a redirect is not an
            # answer about the reviewed model. Refused rather than returned:
            # `_probe_health` would read it as unavailable today, and no edit
            # there should ever be able to read it as anything else.
            raise ProviderError(PROVIDER_REDIRECT_REFUSED)
        return status

    def _https_stream(self, url: str, body: bytes, headers: dict[str, str]) -> Iterator[bytes]:
        request = urllib.request.Request(url, data=body, method="POST", headers=headers)
        # The same credential goes out on this path, and the same 30x would
        # carry it somewhere the manifest never named.
        response = _no_redirect_opener().open(request, timeout=self._timeout_seconds)  # noqa: S310
        def lines() -> Iterator[bytes]:
            try:
                for line in response:
                    yield line
            finally:
                response.close()
        return lines()


def _probe_health(status: int) -> str:
    """Turn one HTTP status into the health the server stores.

    Throttling and overload are `degraded`: the provider is there, and calling
    it unavailable would refuse Nova for a whole freshness window over a
    condition that usually clears in seconds. Anything else that is not a 200 -
    a rejected credential, a model the manifest names and the provider does
    not, an outage - is `unavailable`. There is no status that is treated as
    healthy by default.
    """
    if status == 200:
        return HEALTHY
    if status in {429, 529}:
        return DEGRADED
    return UNAVAILABLE


def _error_code(kind: Any) -> str:
    mapping = {
        "authentication_error": "PROVIDER_CREDENTIAL_REJECTED",
        "permission_error": "PROVIDER_PERMISSION_DENIED",
        "rate_limit_error": "PROVIDER_RATE_LIMITED",
        "overloaded_error": "PROVIDER_OVERLOADED",
        "invalid_request_error": "PROVIDER_REQUEST_REJECTED",
    }
    return mapping.get(kind if isinstance(kind, str) else "", "PROVIDER_FAILED")


def _transport_code(error: BaseException) -> str:
    if isinstance(error, urllib.error.HTTPError):
        status = error.code
        if 300 <= status < 400:
            # Never followed, so nothing was sent on; the run fails rather
            # than being answered by a host the manifest does not name.
            return PROVIDER_REDIRECT_REFUSED
        if status in {401, 403}:
            return "PROVIDER_CREDENTIAL_REJECTED"
        if status == 429:
            return "PROVIDER_RATE_LIMITED"
        if status >= 500:
            return "PROVIDER_UNAVAILABLE"
        return "PROVIDER_REQUEST_REJECTED"
    if isinstance(error, urllib.error.URLError) or isinstance(error, TimeoutError):
        return "PROVIDER_UNREACHABLE"
    return "PROVIDER_FAILED"


#: Provider ids this build knows how to call. A manifest naming anything else
#: is refused rather than falling back to a default: "which model answered the
#: students" is not a question that should have an implicit answer.
ADAPTERS = {"anthropic-messages-v1": AnthropicMessagesProvider}


def build_model_provider(manifest: ProviderManifest, **kwargs: Any):
    """Select the adapter the reviewed manifest names."""
    adapter = ADAPTERS.get(manifest.provider_id)
    if adapter is None:
        raise ProviderError("PROVIDER_NOT_IMPLEMENTED")
    return adapter(manifest, **kwargs)
