"""Bounded, redirect-free Worker → Server internal HTTP client."""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from .jobs import JobClaim, WorkerJob
from .service_assertion import ServiceAssertionSigner, canonical_json


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

    def __init__(self, base_url: str, signer: ServiceAssertionSigner, *, timeout_seconds: float = 10.0, transport: Callable[..., Any] | None = None) -> None:
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
        if not path.startswith("/") or "?" in path or "#" in path:
            raise InternalHttpError("INTERNAL_HTTP_PATH_INVALID")
        subject = _subject(claim)
        if subject != self.signer.issuer and not subject:
            raise InternalHttpError("INTERNAL_HTTP_SUBJECT_INVALID")
        payload = canonical_json(dict(body))
        assertion = self.signer.sign(audience, subject, dict(body))
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
            return self._validate_response(response)
        request = urllib.request.Request(self.base_url + path, data=payload, headers=headers, method="POST")
        opener = urllib.request.build_opener(_NoRedirect())
        try:
            with opener.open(request, timeout=self.timeout_seconds) as response:
                raw_body = response.read(1_048_576 + 1)
                if len(raw_body) > 1_048_576:
                    raise InternalHttpError("INTERNAL_HTTP_RESPONSE_TOO_LARGE", response.status)
                parsed = json.loads(raw_body.decode("utf-8"))
                return self._validate_response(InternalResponse(response.status, parsed))
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


__all__ = ["InternalHttpError", "InternalResponse", "InternalServiceClient"]
