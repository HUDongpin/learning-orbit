"""Fail-closed worker handler for the room deletion surface saga.

Deletion jobs deliberately have ``room_id`` and ``source_event_id`` set to
NULL so the final surface may delete ``classroom_room`` without losing its
claim.  This module owns only durable PostgreSQL lifecycle state; provider and
media object deletion must be supplied by reviewed capability adapters.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
from typing import Any, Mapping
from uuid import UUID

from .core_handlers import RetryableJobError, TerminalJobError
from .handler_registry import HandlerOutcome, WorkerDeps
from .internal_http import InternalHttpError
from .jobs import StaleClaim, WorkerJob
from .room_lock import lock_room_in_transaction

SURFACES = ("events", "media", "derivatives", "artifacts", "projections", "agent_runs", "caches", "provider_copies")
DELETE_ORDER = ("provider_copies", "media", "derivatives", "artifacts", "projections", "agent_runs", "caches", "events")
JOB_TYPE = "room.delete-surface.v1"


@contextmanager
def _transaction(connection: Any):
    transaction = getattr(connection, "transaction", None)
    if callable(transaction):
        with transaction():
            yield
    else:
        yield


def _jsonb(value: Any) -> Any:
    try:
        from psycopg.types.json import Jsonb
        return Jsonb(value)
    except ImportError:
        return value


def _uuid(value: Any, code: str) -> str:
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise TerminalJobError(code) from None


def _payload(job: WorkerJob) -> tuple[str, str]:
    if job.job_type != JOB_TYPE or job.room_id is not None or job.source_event_id is not None:
        raise TerminalJobError("LIFECYCLE_JOB_IDENTITY_INVALID")
    if not isinstance(job.payload, Mapping) or set(job.payload) != {"deletionJobId", "surface"}:
        raise TerminalJobError("LIFECYCLE_JOB_PAYLOAD_INVALID")
    deletion_id = _uuid(job.payload["deletionJobId"], "LIFECYCLE_JOB_PAYLOAD_INVALID")
    surface = job.payload["surface"]
    if not isinstance(surface, str) or surface not in SURFACES:
        raise TerminalJobError("LIFECYCLE_JOB_PAYLOAD_INVALID")
    expected_dedupe = f"{JOB_TYPE}:{deletion_id}:{surface}"
    if job.dedupe_key != expected_dedupe:
        raise TerminalJobError("LIFECYCLE_JOB_IDENTITY_INVALID")
    _uuid(job.correlation_id, "LIFECYCLE_JOB_IDENTITY_INVALID")
    return deletion_id, surface


def _row(row: Any, name: str, index: int) -> Any:
    return row.get(name) if isinstance(row, Mapping) else row[index]


def _count(connection: Any, query: str, room_id: str) -> int:
    result = connection.execute(query, (room_id,)).fetchone()
    value = _row(result, "count", 0) if result is not None else None
    try:
        count = int(value)
    except (TypeError, ValueError):
        raise RetryableJobError("LIFECYCLE_SURFACE_COUNT_INVALID") from None
    if count < 0:
        raise RetryableJobError("LIFECYCLE_SURFACE_COUNT_INVALID")
    return count


def _surface_count(connection: Any, surface: str, room_id: str) -> int:
    # The pilot has no cache adapter, so its local cache surface is structurally
    # empty. Provider copies are different: any media asset, Agent run, or
    # non-local derived-text provider is durable evidence that an external
    # copy may exist. Without a reviewed deletion/no-persistence capability,
    # that potential count must keep the saga retryable instead of certifying
    # a false zero-copy receipt.
    if surface == "caches":
        return 0
    queries = {
        "events": "SELECT count(*) AS count FROM room_event WHERE room_id=%s",
        "media": "SELECT count(*) AS count FROM media_asset WHERE room_id=%s",
        "derivatives": "SELECT count(*) AS count FROM media_derivative d JOIN media_asset m ON m.media_id=d.media_id WHERE m.room_id=%s",
        "artifacts": "SELECT (SELECT count(*) FROM derived_text_artifact WHERE room_id=%s)+(SELECT count(*) FROM extraction_artifacts WHERE room_id=%s)+(SELECT count(*) FROM analytics_review_detail WHERE room_id=%s) AS count",
        "projections": "SELECT (SELECT count(*) FROM analysis_projection_snapshots WHERE room_id=%s)+(SELECT count(*) FROM analysis_projection_patches WHERE room_id=%s)+(SELECT count(*) FROM analysis_projection_outbox WHERE room_id=%s)+(SELECT count(*) FROM analysis_room_heads WHERE room_id=%s)+(SELECT count(*) FROM student_analytics_promotion WHERE room_id=%s) AS count",
        "agent_runs": "SELECT count(*) AS count FROM agent_run WHERE room_id=%s",
        "provider_copies": "SELECT (SELECT count(*) FROM media_asset WHERE room_id=%s)+(SELECT count(*) FROM agent_run WHERE room_id=%s)+(SELECT count(*) FROM derived_text_artifact WHERE room_id=%s AND provider NOT IN ('learner-authored','teacher-correction')) AS count",
    }
    if surface in {"artifacts", "projections", "provider_copies"}:
        parameters = ((room_id,) * 3 if surface in {"artifacts", "provider_copies"}
                      else (room_id,) * 5)
        result = connection.execute(queries[surface], parameters).fetchone()
        value = _row(result, "count", 0) if result is not None else None
        try:
            return int(value)
        except (TypeError, ValueError):
            raise RetryableJobError("LIFECYCLE_SURFACE_COUNT_INVALID") from None
    return _count(connection, queries[surface], room_id)


def _delete_surface(connection: Any, surface: str, room_id: str) -> None:
    if surface == "derivatives":
        connection.execute("DELETE FROM media_derivative d USING media_asset m WHERE d.media_id=m.media_id AND m.room_id=%s", (room_id,))
    elif surface == "artifacts":
        connection.execute("DELETE FROM extraction_artifacts WHERE room_id=%s", (room_id,))
        connection.execute("DELETE FROM analytics_review_detail WHERE room_id=%s", (room_id,))
        connection.execute("DELETE FROM derived_text_artifact WHERE room_id=%s", (room_id,))
    elif surface == "projections":
        connection.execute("DELETE FROM analysis_projection_outbox WHERE room_id=%s", (room_id,))
        connection.execute("DELETE FROM analysis_room_heads WHERE room_id=%s", (room_id,))
        connection.execute("DELETE FROM analysis_projection_patches WHERE room_id=%s", (room_id,))
        connection.execute("DELETE FROM analysis_projection_snapshots WHERE room_id=%s", (room_id,))
        connection.execute("DELETE FROM student_analytics_promotion WHERE room_id=%s", (room_id,))
    elif surface == "agent_runs":
        connection.execute("DELETE FROM agent_run WHERE room_id=%s", (room_id,))
    elif surface == "events":
        # Events are the parent surface and are only removed by deleting the
        # room in the final transaction below.
        return


def _manifest(connection: Any, deletion_id: str, surface: str) -> dict[str, Any]:
    result = connection.execute(
        "SELECT deletion_job_id,surface,expected_item_count,status FROM deletion_surface_manifest WHERE deletion_job_id=%s AND surface=%s FOR UPDATE",
        (deletion_id, surface),
    )
    row = result.fetchone()
    if row is None:
        raise TerminalJobError("LIFECYCLE_MANIFEST_MISSING")
    values = {"deletion_job_id": _row(row, "deletion_job_id", 0), "surface": _row(row, "surface", 1), "expected_item_count": _row(row, "expected_item_count", 2), "status": _row(row, "status", 3)}
    try:
        values["expected_item_count"] = int(values["expected_item_count"])
    except (TypeError, ValueError):
        raise TerminalJobError("LIFECYCLE_MANIFEST_INVALID") from None
    if values["expected_item_count"] < 0 or values["surface"] != surface or values["status"] not in {"frozen", "running", "verified", "dead"}:
        raise TerminalJobError("LIFECYCLE_MANIFEST_INVALID")
    return values


def _verify_all_manifests(connection: Any, deletion_id: str) -> bool:
    rows = connection.execute("SELECT surface,status FROM deletion_surface_manifest WHERE deletion_job_id=%s FOR UPDATE", (deletion_id,)).fetchall()
    statuses = {str(_row(item, "surface", 0)): str(_row(item, "status", 1)) for item in rows}
    return set(statuses) == set(SURFACES) and all(statuses.get(surface) == "verified" for surface in SURFACES)


def _valid_receipt(row: Any) -> bool:
    """Validate the content-free completion proof before settling a retry."""
    if row is None:
        return False
    version = _row(row, "receipt_version", 0)
    if isinstance(version, bool) or version != 1:
        return False
    surfaces = _row(row, "surfaces_verified", 1)
    if not isinstance(surfaces, (list, tuple)):
        return False
    normalized = [str(item) for item in surfaces]
    return len(normalized) == len(SURFACES) and set(normalized) == set(SURFACES)


def _verify_media_surface(deps: WorkerDeps, claim: Any, deletion_id: str) -> None:
    """Ask the server to verify and clear the media surface it owns."""
    if deps.internal_http is None:
        raise RetryableJobError("MEDIA_SURFACE_PENDING")
    body = {
        "jobId": claim.job_id,
        "jobType": claim.job_type,
        "roomId": claim.room_id,
        "sourceEventId": claim.source_event_id,
        "dedupeKey": claim.dedupe_key,
        "deletionJobId": deletion_id,
        "surface": "media",
        "correlationId": claim.correlation_id,
        "claimGeneration": claim.claim_generation,
        "claimToken": claim.claim_token,
        "workerId": claim.worker_id,
    }
    try:
        response = deps.internal_http.post(
            "/internal/lifecycle/media-surface", "internal.lifecycle.mediaSurface", body, claim,
        )
    except InternalHttpError as error:
        if error.code in {"INTERNAL_HTTP_TIMEOUT", "INTERNAL_HTTP_TRANSPORT", "INTERNAL_HTTP_STATUS"}:
            raise RetryableJobError("MEDIA_SURFACE_PENDING") from error
        raise TerminalJobError("MEDIA_SURFACE_REJECTED") from error
    result = response.body
    if not isinstance(result, dict):
        raise TerminalJobError("INTERNAL_HTTP_RESPONSE_SCHEMA")
    status = result.get("status")
    if status in {"completed", "already_verified"}:
        return
    if status == "retryable":
        raise RetryableJobError("MEDIA_SURFACE_PENDING")
    if status == "rejected" and result.get("code") == "JOB_CLAIM_STALE":
        raise StaleClaim("JOB_CLAIM_STALE")
    raise TerminalJobError("MEDIA_SURFACE_REJECTED")


def delete_surface_handler(deps: WorkerDeps, job: WorkerJob) -> HandlerOutcome:
    if deps.claim is None:
        raise TerminalJobError("LIFECYCLE_CLAIM_MISSING")
    deletion_id, surface = _payload(job)
    claim = deps.claim.as_job_claim()
    with _transaction(deps.db):
        # The NULL-room claim is checked before resolving any room reference.
        deps.job_claims.require_current(deps.db, claim)
        deletion = deps.db.execute(
            "SELECT deletion_job_id,correlation_id,room_id,status FROM deletion_job WHERE deletion_job_id=%s FOR UPDATE",
            (deletion_id,),
        ).fetchone()
        if deletion is None or str(_row(deletion, "correlation_id", 1)) != job.correlation_id:
            raise TerminalJobError("LIFECYCLE_JOB_IDENTITY_INVALID")
        room_id = _row(deletion, "room_id", 2)
        deletion_status = str(_row(deletion, "status", 3))
        manifest = _manifest(deps.db, deletion_id, surface)
        if deletion_status == "dead":
            raise TerminalJobError("LIFECYCLE_JOB_NOT_ACTIVE")
        if deletion_status == "completed":
            receipt = deps.db.execute(
                "SELECT receipt_version,surfaces_verified FROM deletion_receipt WHERE deletion_job_id=%s FOR UPDATE",
                (deletion_id,),
            ).fetchone()
            if not _valid_receipt(receipt) or not _verify_all_manifests(deps.db, deletion_id):
                raise TerminalJobError("LIFECYCLE_RECEIPT_INVALID")
            deps.job_claims.complete_business(deps.db, claim, "LIFECYCLE_SURFACE_COMPLETED")
            return HandlerOutcome.SUCCESS
        # Expose that at least one surface is actively being processed.  The
        # transition is monotonic with respect to completed/dead terminal
        # states; a concurrent retry cannot resurrect a finished saga.
        deps.db.execute(
            """UPDATE deletion_job SET status='running'
                WHERE deletion_job_id=%s AND status IN ('queued','retryable')""",
            (deletion_id,),
        )
        if manifest["status"] == "dead":
            raise TerminalJobError("LIFECYCLE_SURFACE_NOT_ACTIVE")
        if manifest["status"] == "verified":
            deps.job_claims.complete_business(deps.db, claim, "LIFECYCLE_SURFACE_COMPLETED")
            return HandlerOutcome.SUCCESS
        if room_id is None:
            raise RetryableJobError("LIFECYCLE_ROOM_REFERENCE_MISSING")
        room_id = _uuid(room_id, "LIFECYCLE_JOB_IDENTITY_INVALID")
        lock_room_in_transaction(deps.db, room_id)
        room = deps.db.execute("SELECT room_id FROM classroom_room WHERE room_id=%s FOR UPDATE", (room_id,)).fetchone()
        if room is None:
            raise RetryableJobError("LIFECYCLE_ROOM_REFERENCE_MISSING")
        prior = DELETE_ORDER[:DELETE_ORDER.index(surface)]
        states = deps.db.execute("SELECT surface,status FROM deletion_surface_manifest WHERE deletion_job_id=%s", (deletion_id,)).fetchall()
        state_by_surface = {str(_row(item, "surface", 0)): str(_row(item, "status", 1)) for item in states}
        if any(state_by_surface.get(item) != "verified" for item in prior):
            raise RetryableJobError("LIFECYCLE_DEPENDENCY_PENDING")
        current_count = _surface_count(deps.db, surface, room_id)
        expected = manifest["expected_item_count"]
        if surface == "media" and (expected > 0 or current_count > 0):
            # The media surface is owned by TypeScript - the grants, write
            # fences and object keys all live there - so it is verified through
            # its signed route rather than by a SQL sweep here. The route
            # refuses to mark it verified until every in-flight media job is
            # quiescent and a configured eraser has proven the stored objects
            # gone, so a room whose media cannot be reached stays retryable
            # instead of receiving a receipt that asserts a deletion nobody
            # performed.
            _verify_media_surface(deps, claim, deletion_id)
            manifest = _manifest(deps.db, deletion_id, surface)
            if manifest["status"] != "verified":
                raise RetryableJobError("MEDIA_SURFACE_PENDING")
            deps.job_claims.complete_business(deps.db, claim, "LIFECYCLE_SURFACE_COMPLETED")
            return HandlerOutcome.SUCCESS
        if surface == "provider_copies":
            # No reviewed provider-copy capability exists in this checkout. A
            # frozen non-zero count cannot be certified merely because a local
            # SQL sweep happens to be empty.
            if expected > 0 or current_count > 0:
                raise RetryableJobError("PROVIDER_COPY_DEPENDENCY_PENDING")
        elif current_count != expected:
            raise RetryableJobError("LIFECYCLE_SURFACE_COUNT_CHANGED")
        if surface == "events":
            if current_count != expected:
                raise RetryableJobError("LIFECYCLE_SURFACE_COUNT_CHANGED")
            # The current manifest is still frozen/running here; only prior
            # surfaces may be required before the final room deletion.
            if any(state_by_surface.get(item) != "verified" for item in DELETE_ORDER[:-1]):
                raise RetryableJobError("LIFECYCLE_DEPENDENCY_PENDING")
            deleted = deps.db.execute("DELETE FROM classroom_room WHERE room_id=%s", (room_id,))
            if getattr(deleted, "rowcount", 1) != 1:
                raise RetryableJobError("LIFECYCLE_ROOM_REFERENCE_MISSING")
        else:
            if expected > 0 and current_count > 0:
                _delete_surface(deps.db, surface, room_id)
                current_count = _surface_count(deps.db, surface, room_id)
            if current_count != 0:
                raise RetryableJobError("LIFECYCLE_SURFACE_NOT_EMPTY")
        deps.db.execute("UPDATE deletion_surface_manifest SET status='verified',verified_at=now() WHERE deletion_job_id=%s AND surface=%s", (deletion_id, surface))
        if surface == "events":
            if not _verify_all_manifests(deps.db, deletion_id):
                raise RetryableJobError("LIFECYCLE_DEPENDENCY_PENDING")
            verified = list(sorted(SURFACES))
            deps.db.execute("INSERT INTO deletion_receipt(deletion_job_id,receipt_version,surfaces_verified,completed_at) VALUES(%s,1,%s,now()) ON CONFLICT(deletion_job_id) DO NOTHING", (deletion_id, _jsonb(verified)))
            receipt = deps.db.execute(
                "SELECT receipt_version,surfaces_verified FROM deletion_receipt WHERE deletion_job_id=%s FOR UPDATE",
                (deletion_id,),
            ).fetchone()
            if not _valid_receipt(receipt):
                raise TerminalJobError("LIFECYCLE_RECEIPT_INVALID")
            deps.db.execute("UPDATE deletion_job SET status='completed',completed_at=now(),room_id=NULL WHERE deletion_job_id=%s", (deletion_id,))
        deps.job_claims.complete_business(deps.db, claim, "LIFECYCLE_SURFACE_COMPLETED")
    return HandlerOutcome.SUCCESS


def register_lifecycle_handlers(registry: Any) -> Any:
    registry.register(JOB_TYPE, delete_surface_handler)
    return registry


__all__ = ["JOB_TYPE", "SURFACES", "delete_surface_handler", "register_lifecycle_handlers"]
