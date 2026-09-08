"""The derivative a processed upload publishes, in the shape the server accepts.

Two documents own this shape and neither of them lives here:

* ``packages/contracts/schemas/media-internal-outcome.v1.json`` is the wire
  contract. Every field name, every enum member and the digest pattern come
  from it, and the worker's own generated parser
  (``learning_orbit_worker.generated.media_internal_outcome_v1``) is the
  executable copy of it.
* ``apps/server/src/modules/media/media-object-keys.ts`` owns the key layout.
  The server recomputes that key on every download and every deletion sweep and
  refuses a derivative row whose ``object_key`` is not exactly it, so a key
  invented here is a file no student can ever open.

They are mirrored rather than approximated because the failure mode is silent
from the worker's side: a derivative the server refuses leaves the upload at
``uploaded`` while the job retries itself to death.

Nothing in here decides whether an upload is publishable. It writes the bytes a
caller already scanned and sanitized, and it refuses to describe them with
anything it has not verified.
"""
from __future__ import annotations

import hashlib
from re import IGNORECASE, compile as _compile
from typing import Any
from uuid import uuid4

#: The server's own UUID shape, from media-object-keys.ts. A key built from
#: anything else is a key that could address another room's prefix.
_UUID = _compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", IGNORECASE)

_DIGEST = _compile(r"[a-f0-9]{64}")

#: The two derivative kinds a room ever serves back. `thumbnail` and `waveform`
#: exist in the contract but have no producer, and the server's download path
#: maps image -> sanitized_image and everything else -> playback_audio.
SAFE_DERIVATIVE_KINDS = ("sanitized_image", "playback_audio")

#: The contract's ceiling on a single derivative.
MAX_DERIVATIVE_BYTES = 26_214_400

#: The contract's ceiling on the mime string.
MAX_MIME_LENGTH = 127


class DerivativeError(RuntimeError):
    """A derivative that cannot be written, or cannot be honestly described."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def safe_derivative_object_key(room_id: str, media_id: str, kind: str) -> str:
    """The canonical key, byte-for-byte what ``safeDerivativeObjectKey`` returns."""
    if kind not in SAFE_DERIVATIVE_KINDS:
        raise DerivativeError("MEDIA_DERIVATIVE_KIND_INVALID")
    if not _UUID.fullmatch(str(room_id)) or not _UUID.fullmatch(str(media_id)):
        raise DerivativeError("MEDIA_DERIVATIVE_IDENTITY_INVALID")
    return f"rooms/{room_id}/derivative/{media_id}/{kind}"


def _readback_digest(store: Any, object_key: str) -> str:
    try:
        stored = store.get(object_key)
    except Exception as error:  # noqa: BLE001 - a store body may echo a key
        raise DerivativeError(str(getattr(error, "code", None) or "MEDIA_STORE_READ_FAILED")) from None
    digest = getattr(stored, "sha256", None)
    return digest if isinstance(digest, str) else ""


def write_derivative(
    store: Any,
    *,
    room_id: str,
    media_id: str,
    kind: str,
    data: bytes,
    mime: str,
) -> dict[str, object]:
    """Write one derivative write-once and return the outcome entry for it.

    The returned mapping is exactly the contract's ``Derivative``: no extra
    key, no missing one, and a ``sha256`` that describes the object now at
    ``objectKey`` rather than the one this attempt happened to hold.
    """
    object_key = safe_derivative_object_key(room_id, media_id, kind)
    if not isinstance(mime, str) or not 0 < len(mime) <= MAX_MIME_LENGTH:
        raise DerivativeError("MEDIA_DERIVATIVE_MIME_INVALID")
    if not data:
        raise DerivativeError("MEDIA_DERIVATIVE_EMPTY")
    if len(data) > MAX_DERIVATIVE_BYTES:
        raise DerivativeError("MEDIA_DERIVATIVE_TOO_LARGE")

    expected = hashlib.sha256(data).hexdigest()
    try:
        digest = store.put(object_key, data, content_type=mime)
    except Exception as error:  # noqa: BLE001 - a store body may echo a key
        code = getattr(error, "code", None)
        if code != "MEDIA_STORE_ALREADY_WRITTEN":
            raise DerivativeError(str(code or "MEDIA_STORE_WRITE_FAILED")) from None
        # A retry after a lost response. The destination is write-once, so the
        # first copy stands - and the digest reported has to describe that
        # copy. Read it back instead of asserting what it must contain; the
        # previous code reported an empty digest here, which the contract
        # refuses and which would have been a lie if it had not.
        digest = _readback_digest(store, object_key)
        if digest != expected:
            # This key is scoped to one media asset and one kind, so no other
            # job writes it. An object under it that is not the one this
            # attempt produced is unexplained, and an unexplained object is not
            # one to publish.
            raise DerivativeError("MEDIA_DERIVATIVE_CONFLICT")
    if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
        # A store that returns no usable digest cannot have its write described.
        raise DerivativeError("MEDIA_DERIVATIVE_DIGEST_INVALID")

    return {
        "derivativeId": str(uuid4()),
        "kind": kind,
        "objectKey": object_key,
        "mime": mime,
        "sizeBytes": len(data),
        "sha256": digest,
    }
