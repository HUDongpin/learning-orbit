"""Bounded, redirect-free Worker → Server internal HTTP client."""

from __future__ import annotations

import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from .jobs import JobClaim, WorkerJob
from .service_assertion import ServiceAssertionSigner, canonical_json

#: Every worker-job callback signs for a minute, which is the server's bound
#: for those routes.
ASSERTION_LIFETIME_SECONDS = 60

#: One internal request's own ceiling. Named so the callers that have to wait
#: for a request to finish - shutting a probe thread down, for one - can size
#: their budget from the real number instead of guessing at it.
INTERNAL_HTTP_DEFAULT_TIMEOUT_SECONDS = 10.0

# The provider-health route is the one internal mutation that is not a
# worker-job callback, and the server checks it under its own rules
# (`authorizeProviderHealthAssertion`). It differs in all three of the ways
# that matter, so all three live here rather than at the call site: the subject
# is the provider rather than a worker, the assertion may not be valid for
# longer than thirty seconds, and the receipt is `{status}` rather than the
# generic `{code}` shape. Signing a probe like a job callback produced an
# assertion the server refused, which is why nothing ever reached
# `agent_provider_health`.
PROVIDER_HEALTH_PATH = "/internal/agent/provider-health"
PROVIDER_HEALTH_AUDIENCE = "internal.agent.health"
PROVIDER_HEALTH_SUBJECT_PREFIX = "provider-health-probe:"
#: One second inside the server's own bound rather than exactly on it.
#: `authorizeProviderHealthAssertion` refuses `expiresAt - issuedAt > 30_000`,
#: so thirty was the largest window it still accepts and left no room at all:
#: any rounding in either clock, or any later tightening of that bound, turns
#: every sample into a 401 and `agent_provider_health` back into an empty
#: table - the exact failure this route was fixed for.
PROVIDER_HEALTH_LIFETIME_SECONDS = 29
#: The two receipts the route can return. `ignored_stale` means the server kept
#: a row it already had; it is a delivered sample, not a recorded one.
PROVIDER_HEALTH_ACCEPTED = "accepted"
PROVIDER_HEALTH_IGNORED_STALE = "ignored_stale"
PROVIDER_HEALTH_RECEIPT = frozenset({PROVIDER_HEALTH_ACCEPTED, PROVIDER_HEALTH_IGNORED_STALE})
_PROVIDER_ID = re.compile(r"[a-z0-9._-]{1,64}")


class InternalHttpError(RuntimeError):
    def __init__(self, code: str, status: int | None = None) -> None:
        super().__init__(code)
        self.code, self.status = code, status


@dataclass(frozen=True, slots=True)
class InternalResponse:
    status: int
    body: Mapping[str, Any]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _subject(claim: Any) -> str:
    """Resolve the worker that signs, whatever claim shape the caller holds.

    Three types carry the same identity: JobClaim and WorkerClaim name it
    ``worker_id``, while a raw WorkerJob row names it ``locked_by``. Matching on
    the class instead of the field meant a handler passing the WorkerClaim it is
    actually given fell through to ``locked_by`` and raised AttributeError - so
    every signed internal call from a real worker failed before it was sent.
    """
    for field in ("worker_id", "locked_by"):
        value = getattr(claim, field, None)
        if isinstance(value, str) and value:
            return value
    raise InternalHttpError("INTERNAL_HTTP_SUBJECT_INVALID")


class InternalServiceClient:
    """One HTTP request per Worker attempt; retry belongs to durable jobs."""

    def __init__(self, base_url: str, signer: ServiceAssertionSigner, *, timeout_seconds: float = INTERNAL_HTTP_DEFAULT_TIMEOUT_SECONDS, transport: Callable[..., Any] | None = None) -> None:
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme not in {"https", "http"} or not parsed.netloc:
            raise ValueError("INTERNAL_HTTP_ORIGIN_INVALID")
        if parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("INTERNAL_HTTP_ORIGIN_INVALID")
        if timeout_seconds <= 0 or timeout_seconds > 60:
            raise ValueError("INTERNAL_HTTP_TIMEOUT_INVALID")
        self.base_url = base_url.rstrip("/")
        self.signer = signer
        self.timeout_seconds = timeout_seconds
        self.transport = transport

    def post(self, path: str, audience: str, body: Mapping[str, Any], claim: JobClaim | WorkerJob) -> InternalResponse:
        subject = _subject(claim)
        if subject != self.signer.issuer and not subject:
            raise InternalHttpError("INTERNAL_HTTP_SUBJECT_INVALID")
        return self._send(path, audience, subject, body, ASSERTION_LIFETIME_SECONDS, self._validate_response)

    def post_provider_health(self, body: Mapping[str, Any], provider_id: str) -> InternalResponse:
        """Post one health sample under the provider-health route's own rules.

        The provider is the subject because there is no job and no room here:
        the sample says something about a provider, and the server will only
        accept it from a caller that says so too.
        """
        if not isinstance(provider_id, str) or _PROVIDER_ID.fullmatch(provider_id) is None:
            raise InternalHttpError("INTERNAL_HTTP_SUBJECT_INVALID")
        return self._send(
            PROVIDER_HEALTH_PATH,
            PROVIDER_HEALTH_AUDIENCE,
            PROVIDER_HEALTH_SUBJECT_PREFIX + provider_id,
            body,
            PROVIDER_HEALTH_LIFETIME_SECONDS,
            self._validate_health_response,
        )

    def _send(
        self,
        path: str,
        audience: str,
        subject: str,
        body: Mapping[str, Any],
        lifetime_seconds: int,
        validate: Callable[[InternalResponse], InternalResponse],
    ) -> InternalResponse:
        if not path.startswith("/") or "?" in path or "#" in path:
            raise InternalHttpError("INTERNAL_HTTP_PATH_INVALID")
        payload = canonical_json(dict(body))
        assertion = self.signer.sign(audience, subject, dict(body), lifetime_seconds)
        headers = {"Content-Type": "application/json", "Accept": "application/json", "X-LO-Service-Assertion": assertion}
        if self.transport is not None:
            try:
                raw = self.transport(self.base_url + path, payload, headers, self.timeout_seconds)
                response = raw if isinstance(raw, InternalResponse) else InternalResponse(int(raw[0]), raw[1])
            except InternalHttpError:
                raise
            except (TimeoutError, socket.timeout) as error:
                raise InternalHttpError("INTERNAL_HTTP_TIMEOUT") from error
            except Exception as error:
                raise InternalHttpError("INTERNAL_HTTP_TRANSPORT") from error
            return validate(response)
        request = urllib.request.Request(self.base_url + path, data=payload, headers=headers, method="POST")
        opener = urllib.request.build_opener(_NoRedirect())
        try:
            with opener.open(request, timeout=self.timeout_seconds) as response:
                raw_body = response.read(1_048_576 + 1)
                if len(raw_body) > 1_048_576:
                    raise InternalHttpError("INTERNAL_HTTP_RESPONSE_TOO_LARGE", response.status)
                parsed = json.loads(raw_body.decode("utf-8"))
                return validate(InternalResponse(response.status, parsed))
        except InternalHttpError:
            raise
        except urllib.error.HTTPError as error:
            if 300 <= error.code < 400:
                raise InternalHttpError("INTERNAL_HTTP_REDIRECT", error.code) from error
            raise InternalHttpError("INTERNAL_HTTP_STATUS", error.code) from error
        except (TimeoutError, socket.timeout) as error:
            raise InternalHttpError("INTERNAL_HTTP_TIMEOUT") from error
        except Exception as error:
            raise InternalHttpError("INTERNAL_HTTP_TRANSPORT") from error

    @staticmethod
    def _validate_response(response: InternalResponse) -> InternalResponse:
        if response.status < 200 or response.status >= 300:
            raise InternalHttpError("INTERNAL_HTTP_STATUS", response.status)
        if not isinstance(response.body, Mapping):
            raise InternalHttpError("INTERNAL_HTTP_RESPONSE_SCHEMA", response.status)
        # Closed generic receipt shape. Domain routes may add fields only via
        # generated codecs; unknown values are never surfaced in exceptions.
        if "code" not in response.body or not isinstance(response.body.get("code"), str):
            raise InternalHttpError("INTERNAL_HTTP_RESPONSE_SCHEMA", response.status)
        if len(response.body) > 3:
            raise InternalHttpError("INTERNAL_HTTP_RESPONSE_SCHEMA", response.status)
        return response

    @staticmethod
    def _validate_health_response(response: InternalResponse) -> InternalResponse:
        """The provider-health receipt is `{status}`, not the generic `{code}`.

        A refusal arrives as 401 or 409 and is raised as a status failure, so a
        rejected sample can never be read as a delivered one - the row stays as
        it was, goes stale, and the server keeps answering `unavailable`.
        """
        if response.status < 200 or response.status >= 300:
            raise InternalHttpError("INTERNAL_HTTP_STATUS", response.status)
        if not isinstance(response.body, Mapping) or len(response.body) != 1:
            raise InternalHttpError("INTERNAL_HTTP_RESPONSE_SCHEMA", response.status)
        if response.body.get("status") not in PROVIDER_HEALTH_RECEIPT:
            raise InternalHttpError("INTERNAL_HTTP_RESPONSE_SCHEMA", response.status)
        return response


__all__ = ["InternalHttpError", "InternalResponse", "InternalServiceClient"]
