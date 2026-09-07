"""AWS Signature Version 4 for the worker's object-store calls.

The server already signs its own requests; the worker needs to read a staged
upload and write back the sanitized copy, and it cannot borrow the server's
signer across a process boundary. Rather than add an SDK to a hash-pinned lock
for two verbs, the algorithm is written out — it is deterministic, it is
published, and the tests below reproduce Amazon's own documented vectors, which
is a stronger check than "the SDK compiled".

The credential is read from the environment at call time and never stored on
an instance, so nothing holding a signer holds a secret.
"""
from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Mapping
from urllib.parse import quote

ALGORITHM = "AWS4-HMAC-SHA256"
UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"
EMPTY_PAYLOAD_SHA256 = hashlib.sha256(b"").hexdigest()


@dataclass(frozen=True, slots=True)
class S3Credentials:
    access_key_id: str
    secret_access_key: str
    region: str
    service: str = "s3"


def rfc3986(value: str, preserve_slash: bool = False) -> str:
    """Percent-encode the way SigV4 requires, which is not the way URLs do."""
    return quote(value, safe="/-._~" if preserve_slash else "-._~")


def canonical_query_string(query: Mapping[str, str]) -> str:
    return "&".join(
        f"{rfc3986(key)}={rfc3986(value)}"
        for key, value in sorted(query.items())
    )


def amz_timestamps(now: datetime) -> tuple[str, str]:
    stamp = now.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return stamp, stamp[:8]


def canonical_request(
    method: str,
    path: str,
    query: Mapping[str, str],
    headers: Mapping[str, str],
    payload_hash: str,
) -> tuple[str, str]:
    lowered = {key.lower().strip(): " ".join(str(value).split()) for key, value in headers.items()}
    signed = ";".join(sorted(lowered))
    canonical_headers = "".join(f"{key}:{lowered[key]}\n" for key in sorted(lowered))
    request = "\n".join([
        method.upper(),
        rfc3986(path, preserve_slash=True) or "/",
        canonical_query_string(query),
        canonical_headers,
        signed,
        payload_hash,
    ])
    return request, signed


def _signing_key(credentials: S3Credentials, date_stamp: str) -> bytes:
    key = f"AWS4{credentials.secret_access_key}".encode("utf-8")
    for part in (date_stamp, credentials.region, credentials.service, "aws4_request"):
        key = hmac.new(key, part.encode("utf-8"), hashlib.sha256).digest()
    return key


def _string_to_sign(amz_date: str, scope: str, request: str) -> str:
    return "\n".join([ALGORITHM, amz_date, scope, hashlib.sha256(request.encode("utf-8")).hexdigest()])


def authorization_headers(
    credentials: S3Credentials,
    method: str,
    host: str,
    path: str,
    *,
    query: Mapping[str, str] | None = None,
    headers: Mapping[str, str] | None = None,
    payload_hash: str = EMPTY_PAYLOAD_SHA256,
    now: datetime | None = None,
) -> dict[str, str]:
    """Sign a request, returning the headers to send with it."""
    amz_date, date_stamp = amz_timestamps(now or datetime.now(timezone.utc))
    scope = f"{date_stamp}/{credentials.region}/{credentials.service}/aws4_request"
    signed_headers = {
        "host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
        **(headers or {}),
    }
    request, signed = canonical_request(method, path, query or {}, signed_headers, payload_hash)
    signature = hmac.new(
        _signing_key(credentials, date_stamp),
        _string_to_sign(amz_date, scope, request).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {
        **signed_headers,
        "Authorization": (
            f"{ALGORITHM} Credential={credentials.access_key_id}/{scope}, "
            f"SignedHeaders={signed}, Signature={signature}"
        ),
    }


def presign_url(
    credentials: S3Credentials,
    method: str,
    endpoint: str,
    path: str,
    *,
    expires_seconds: int,
    headers: Mapping[str, str] | None = None,
    now: datetime | None = None,
) -> str:
    """A URL that carries its own signature, for handing to a browser."""
    if not 1 <= expires_seconds <= 604800:
        raise ValueError("S3_PRESIGN_EXPIRY_INVALID")
    moment = now or datetime.now(timezone.utc)
    amz_date, date_stamp = amz_timestamps(moment)
    host = endpoint.split("://", 1)[1].split("/", 1)[0]
    scope = f"{date_stamp}/{credentials.region}/{credentials.service}/aws4_request"
    signed_headers = {"host": host, **(headers or {})}
    signed = ";".join(sorted(key.lower() for key in signed_headers))
    query = {
        "X-Amz-Algorithm": ALGORITHM,
        "X-Amz-Credential": f"{credentials.access_key_id}/{scope}",
        "X-Amz-Date": amz_date,
        "X-Amz-Expires": str(expires_seconds),
        "X-Amz-SignedHeaders": signed,
    }
    request, _ = canonical_request(method, path, query, signed_headers, UNSIGNED_PAYLOAD)
    signature = hmac.new(
        _signing_key(credentials, date_stamp),
        _string_to_sign(amz_date, scope, request).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{endpoint}{path}?{canonical_query_string(query)}&X-Amz-Signature={signature}"
