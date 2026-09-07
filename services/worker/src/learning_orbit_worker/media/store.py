"""Read and write private objects, signed by the worker itself.

The worker cannot borrow the server's signer across a process boundary, so it
signs its own requests. Two verbs are enough: fetch the staged upload, write
back the sanitized copy.

The read is bounded by the same ceiling the media table enforces. An object
that grew past it between the upload check and this read is refused rather
than streamed into memory, because "the file is bigger than we said it could
be" is a reason to stop, not a reason to allocate.
"""
from __future__ import annotations

import hashlib
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable, Mapping

from .sigv4 import S3Credentials, authorization_headers

#: The media_asset ceiling, so a store read cannot exceed what the row allows.
MAX_OBJECT_BYTES = 25 * 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 60.0


class ObjectStoreError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class StoredObject:
    data: bytes
    sha256: str


Transport = Callable[[str, str, Mapping[str, str], bytes | None, float], tuple[int, bytes]]


def _urllib_transport(url: str, method: str, headers: Mapping[str, str], body: bytes | None, timeout: float) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, method=method, headers=dict(headers))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return int(response.status), response.read(MAX_OBJECT_BYTES + 1)
    except urllib.error.HTTPError as error:
        return int(error.code), error.read(4096)


class PrivateObjectStore:
    """The private bucket, addressed by object key."""

    def __init__(
        self,
        endpoint: str,
        bucket: str,
        credentials: S3Credentials,
        *,
        transport: Transport | None = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_bytes: int = MAX_OBJECT_BYTES,
    ) -> None:
        if not endpoint.startswith("http://") and not endpoint.startswith("https://"):
            raise ObjectStoreError("MEDIA_STORE_ENDPOINT_INVALID")
        self.endpoint = endpoint.rstrip("/")
        self.bucket = bucket
        self.credentials = credentials
        self.max_bytes = max_bytes
        self._timeout = timeout_seconds
        self._transport = transport or _urllib_transport

    def _host(self) -> str:
        return self.endpoint.split("://", 1)[1].split("/", 1)[0]

    def _path(self, object_key: str) -> str:
        if not object_key or object_key.startswith("/") or ".." in object_key.split("/"):
            # A key that can climb out of its prefix is a key that can read
            # another room's media.
            raise ObjectStoreError("MEDIA_STORE_KEY_INVALID")
        return f"/{self.bucket}/{object_key}"

    def get(self, object_key: str) -> StoredObject:
        path = self._path(object_key)
        headers = authorization_headers(
            self.credentials, "GET", self._host(), path,
        )
        status, body = self._call(f"{self.endpoint}{path}", "GET", headers, None)
        if status == 404:
            raise ObjectStoreError("MEDIA_STORE_OBJECT_ABSENT")
        if status != 200:
            raise ObjectStoreError("MEDIA_STORE_READ_REFUSED")
        if len(body) > self.max_bytes:
            raise ObjectStoreError("MEDIA_STORE_OBJECT_TOO_LARGE")
        return StoredObject(body, hashlib.sha256(body).hexdigest())

    def put(self, object_key: str, data: bytes, *, content_type: str, write_once: bool = True) -> str:
        if len(data) > self.max_bytes:
            raise ObjectStoreError("MEDIA_STORE_OBJECT_TOO_LARGE")
        path = self._path(object_key)
        digest = hashlib.sha256(data).hexdigest()
        extra = {"content-type": content_type}
        if write_once:
            # The destination is written exactly once. A second write to the
            # same key would silently replace a file a room already trusts.
            extra["if-none-match"] = "*"
        headers = authorization_headers(
            self.credentials, "PUT", self._host(), path,
            headers=extra, payload_hash=digest,
        )
        status, _body = self._call(f"{self.endpoint}{path}", "PUT", headers, data)
        if status == 412:
            raise ObjectStoreError("MEDIA_STORE_ALREADY_WRITTEN")
        if status not in {200, 201, 204}:
            raise ObjectStoreError("MEDIA_STORE_WRITE_REFUSED")
        return digest

    def _call(self, url: str, method: str, headers: Mapping[str, str], body: bytes | None) -> tuple[int, bytes]:
        try:
            return self._transport(url, method, headers, body, self._timeout)
        except ObjectStoreError:
            raise
        except (TimeoutError, OSError) as error:
            raise ObjectStoreError("MEDIA_STORE_UNREACHABLE") from error
