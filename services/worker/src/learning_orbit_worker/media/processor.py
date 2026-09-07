"""The media processor: read the staged upload, scan it, sanitize it, report.

This is the capability `media.process.v1` has always delegated to and nothing
ever supplied, so every media job raised MEDIA_PROCESSOR_UNAVAILABLE and
retried until it died.

The order is the whole design, and it is one-way:

1. Read the staged object and check it is the file the row describes.
2. Scan it. Nothing downstream of here runs on an unscanned file.
3. Sanitize it — strip the metadata a student did not mean to share.
4. Write the sanitized copy to its own key, write-once.
5. Report the outcome through the signed internal route.

The server, not the worker, moves the row. This reports what it found and lets
the authenticated route decide; a worker that could write `ready` itself would
be a worker that could publish an unscanned file by getting one line wrong.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping
from uuid import uuid4

from ..core_handlers import RetryableJobError, TerminalJobError
from ..handler_registry import HandlerOutcome
from .sanitize import SanitizeError, sanitize_image
from .scan import ClamAvScanner, ScanUnavailable

#: What a sanitized copy is called, derived from the staged key so the pair is
#: obvious to a human reading the bucket.
DERIVATIVE_SUFFIX = ".sanitized"

IMAGE_KINDS = {"image"}


@dataclass(frozen=True, slots=True)
class MediaRow:
    media_id: str
    room_id: str
    kind: str
    state: str
    object_key: str
    sha256: str
    detected_mime: str | None


def _row(cursor: Any) -> dict[str, Any] | None:
    row = cursor.fetchone()
    if row is None:
        return None
    if isinstance(row, Mapping):
        return dict(row)
    description = getattr(cursor, "description", None) or []
    names = [column.name if hasattr(column, "name") else column[0] for column in description]
    return dict(zip(names, row, strict=False))


def load_media_row(connection: Any, media_id: str, room_id: str) -> MediaRow:
    row = _row(connection.execute(
        """SELECT media_id, room_id, kind::text AS kind, state::text AS state,
                  object_key, sha256, detected_mime
           FROM media_asset WHERE media_id=%s""",
        (media_id,),
    ))
    if row is None:
        raise TerminalJobError("MEDIA_ASSET_ABSENT")
    if str(row["room_id"]) != str(room_id):
        raise TerminalJobError("MEDIA_ASSET_ROOM_MISMATCH")
    if not row.get("object_key") or not row.get("sha256"):
        # An unpromoted row has nothing to read yet; that is a wait, not a
        # failure.
        raise RetryableJobError("MEDIA_ASSET_NOT_STAGED")
    return MediaRow(
        media_id=str(row["media_id"]), room_id=str(row["room_id"]),
        kind=str(row["kind"]), state=str(row["state"]),
        object_key=str(row["object_key"]), sha256=str(row["sha256"]),
        detected_mime=row.get("detected_mime"),
    )


class MediaProcessor:
    """Injectable `deps.media_processor`."""

    def __init__(
        self,
        connection: Any,
        store: Any,
        internal_http: Any,
        *,
        scanner: Any = None,
        transcoder: Any = None,
    ) -> None:
        self._connection = connection
        self._store = store
        self._internal_http = internal_http
        self._scanner = scanner or ClamAvScanner()
        # Audio and video transcoding is a separate capability. Absent, an
        # audio upload is reported as failed with a stated reason rather than
        # published unconverted.
        self._transcoder = transcoder

    def __call__(self, *, media_id: str, room_id: str, claim: Any, job: Any = None) -> HandlerOutcome:
        row = load_media_row(self._connection, media_id, room_id)
        stored = self._store.get(row.object_key)
        if stored.sha256 != row.sha256:
            # The bytes are not the bytes the room committed to. Nothing is
            # scanned, nothing is written, and the row is not advanced.
            return self._report(claim, job, row, "failed", "MEDIA_CONTENT_HASH_MISMATCH", [])

        try:
            verdict = self._scanner.scan(stored.data)
        except ScanUnavailable as error:
            # An unscannable upload waits. It never becomes a file a student
            # can open on the strength of the scanner being down.
            raise RetryableJobError(error.code) from None
        if not verdict.clean:
            return self._report(claim, job, row, "quarantined", verdict.code, [])

        if row.kind in IMAGE_KINDS:
            try:
                sanitized = sanitize_image(stored.data)
            except SanitizeError as error:
                return self._report(claim, job, row, "failed", error.code, [])
            derivative_key = f"{row.object_key}{DERIVATIVE_SUFFIX}"
            try:
                digest = self._store.put(
                    derivative_key, sanitized.data,
                    content_type=row.detected_mime or "application/octet-stream",
                )
            except Exception as error:  # noqa: BLE001 - a store body may echo a key
                code = getattr(error, "code", None)
                if code == "MEDIA_STORE_ALREADY_WRITTEN":
                    # A retry after a lost response. The destination is
                    # write-once, so the first write stands.
                    digest = None
                else:
                    raise RetryableJobError(str(code or "MEDIA_STORE_WRITE_FAILED")) from None
            return self._report(claim, job, row, "ready", None, [{
                "kind": "sanitized_image",
                "objectKey": derivative_key,
                "sha256": digest or "",
                "bytes": len(sanitized.data),
            }])

        if self._transcoder is None:
            # Stated, not silent. A media kind with no reviewed processor is a
            # gap in the deployment, and publishing it unconverted would be a
            # worse answer than saying so.
            return self._report(claim, job, row, "failed", "MEDIA_TRANSCODER_UNAVAILABLE", [])
        derivatives = self._transcoder(row=row, data=stored.data, store=self._store)
        return self._report(claim, job, row, "ready", None, list(derivatives))

    def _report(self, claim: Any, job: Any, row: MediaRow, state: str, failure_code: str | None, derivatives: list) -> HandlerOutcome:
        if self._internal_http is None or job is None:
            # Without the signed route there is no way to report, and a silent
            # success would leave the row staged forever while the job says it
            # finished.
            raise RetryableJobError("INTERNAL_HTTP_UNAVAILABLE")
        body = {
            "jobId": job.job_id, "jobType": "media.process.v1", "roomId": row.room_id,
            "sourceEventId": None, "dedupeKey": job.dedupe_key, "mediaId": row.media_id,
            "transitionId": str(uuid4()), "state": state, "failureCode": failure_code,
            "derivatives": derivatives, "correlationId": job.correlation_id,
            "claimGeneration": str(job.claim_generation), "claimToken": job.claim_token,
            "workerId": getattr(claim, "worker_id", None) or getattr(claim, "locked_by", ""),
        }
        response = self._internal_http.post(
            "/internal/media/outcome", "internal.media.outcome", body, claim,
        )
        result = response.body if isinstance(response.body, Mapping) else {}
        if result.get("status") in {"applied", "already_applied"}:
            return HandlerOutcome.SUCCESS
        if result.get("code") == "JOB_CLAIM_STALE":
            return HandlerOutcome.LOST_LEASE
        raise RetryableJobError(f"MEDIA_OUTCOME_{result.get('code', 'REJECTED')}")
