"""Durable PostgreSQL worker jobs.

This module deliberately executes the canonical SQL files owned by the Node
service.  The worker does not keep a Python copy of claim/settle queries: SQL
is read from the repository at import time and only the DB driver's parameter
markers are adapted for psycopg.
"""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Iterable, Mapping
import re
from uuid import UUID


class StaleClaim(RuntimeError):
    """The persisted lease tuple no longer belongs to this attempt."""


class CompletionMissing(RuntimeError):
    """A handler attempted success without a durable business receipt."""


class CompletionConflict(RuntimeError):
    """A receipt exists but does not match the current claim."""


class JobInvariantError(RuntimeError):
    """A row violated the closed WorkerJob ABI."""


class JobClaims:
    """Worker-side equivalent of the server JobClaimAuthority."""

    def require_current(self, connection: Any, job: WorkerJob | JobClaim) -> None:
        cursor = connection.execute(
            """SELECT 1 FROM worker_job WHERE job_id=%s AND job_type=%s
               AND room_id IS NOT DISTINCT FROM %s::uuid
               AND source_event_id IS NOT DISTINCT FROM %s::uuid
               AND dedupe_key=%s AND correlation_id=%s::uuid
               AND claim_generation=%s::bigint AND claim_token=%s::uuid
               AND locked_by=%s AND status='running' FOR UPDATE""",
            _claim_predicate(job),
        )
        if getattr(cursor, "rowcount", 0) != 1:
            raise StaleClaim("JOB_CLAIM_STALE")

    def complete_business(self, connection: Any, job: WorkerJob | JobClaim, completion_code: str) -> None:
        if not re.fullmatch(r"[A-Z0-9_]{1,64}", completion_code):
            raise ValueError("JOB_COMPLETION_CODE_INVALID")
        self.require_current(connection, job)
        connection.execute(
            """INSERT INTO worker_job_completion(job_id,claim_generation,claim_token_hash,completion_code)
               VALUES(%s,%s::bigint,encode(digest(%s::text,'sha256'),'hex'),%s)
               ON CONFLICT(job_id,claim_generation) DO NOTHING""",
            (job.job_id, job.claim_generation, job.claim_token, completion_code),
        )
        marker = connection.execute(
            "SELECT claim_token_hash, completion_code FROM worker_job_completion WHERE job_id=%s AND claim_generation=%s::bigint FOR UPDATE",
            (job.job_id, job.claim_generation),
        ).fetchone()
        expected = sha256(str(job.claim_token).encode()).hexdigest()
        marker_hash = marker[0] if marker and not isinstance(marker, Mapping) else (marker or {}).get("claim_token_hash")
        marker_code = marker[1] if marker and not isinstance(marker, Mapping) else (marker or {}).get("completion_code")
        if marker_hash != expected or marker_code != completion_code:
            raise CompletionConflict("JOB_COMPLETION_CONFLICT")


@dataclass(frozen=True, slots=True)
class WorkerJob:
    job_id: str
    job_type: str
    room_id: str | None
    source_event_id: str | None
    dedupe_key: str
    payload: Any
    attempts: int
    correlation_id: str
    locked_by: str
    claim_generation: str
    claim_token: str
    # Nullable for non-analytics jobs.  Analytics migration 003 requires both
    # values to be present and ties them to the room-local ordering tuple.
    analytics_order_seq: int | None = None
    analytics_order_kind: int | None = None

    @property
    def claim(self) -> "JobClaim":
        return JobClaim(
            job_id=self.job_id,
            job_type=self.job_type,
            room_id=self.room_id,
            source_event_id=self.source_event_id,
            dedupe_key=self.dedupe_key,
            correlation_id=self.correlation_id,
            claim_generation=self.claim_generation,
            claim_token=self.claim_token,
            worker_id=self.locked_by,
        )

    def __getitem__(self, key: str) -> Any:
        """Mapping-compatible access for fixture code using the frozen ABI."""
        aliases = {
            "job_id": "job_id", "job_type": "job_type", "room_id": "room_id",
            "source_event_id": "source_event_id", "dedupe_key": "dedupe_key",
            "payload": "payload", "attempts": "attempts", "correlation_id": "correlation_id",
            "locked_by": "locked_by", "claim_generation": "claim_generation", "claim_token": "claim_token",
            "analytics_order_seq": "analytics_order_seq", "analytics_order_kind": "analytics_order_kind",
        }
        if key not in aliases:
            raise KeyError(key)
        return getattr(self, aliases[key])

    def to_dict(self) -> dict[str, Any]:
        return {field: getattr(self, field) for field in (
            "job_id", "job_type", "room_id", "source_event_id", "dedupe_key",
            "payload", "attempts", "correlation_id", "locked_by", "claim_generation", "claim_token",
            "analytics_order_seq", "analytics_order_kind",
        )}


@dataclass(frozen=True, slots=True)
class JobClaim:
    job_id: str
    job_type: str
    room_id: str | None
    source_event_id: str | None
    dedupe_key: str
    correlation_id: str
    claim_generation: str
    claim_token: str
    worker_id: str

    def __getitem__(self, key: str) -> Any:
        names = {"job_id", "job_type", "room_id", "source_event_id", "dedupe_key", "correlation_id", "claim_generation", "claim_token", "worker_id"}
        if key not in names:
            raise KeyError(key)
        return getattr(self, key)


_ROOT = Path(__file__).resolve().parents[4]
_SQL_DIR = _ROOT / "apps" / "server" / "src" / "db" / "sql"
CLAIM_SQL = (_SQL_DIR / "claim_worker_job.sql").read_text(encoding="utf-8")
SETTLE_SQL = (_SQL_DIR / "settle_worker_job_claims.sql").read_text(encoding="utf-8")


def _psycopg_sql(sql: str) -> str:
    """Convert PostgreSQL's ``$n`` placeholders to psycopg's ``%s``.

    The source bytes are left untouched (and are hashable in parity tests);
    this conversion happens only immediately before a psycopg execution.
    """

    return re.sub(r"\$[0-9]+", "%s", sql)


def _rows_as_dicts(cursor: Any) -> list[dict[str, Any]]:
    rows = cursor.fetchall()
    description = getattr(cursor, "description", None)
    if description is None:
        return []
    names = [column.name if hasattr(column, "name") else column[0] for column in description]
    return [dict(zip(names, row, strict=False)) if not isinstance(row, Mapping) else dict(row) for row in rows]


def _execute(connection: Any, sql: str, params: Iterable[Any] = ()) -> Any:
    return connection.execute(_psycopg_sql(sql), tuple(params))


def _transaction(connection: Any):
    """Return psycopg's transaction context, while accepting test doubles."""

    transaction = getattr(connection, "transaction", None)
    if callable(transaction):
        return transaction()
    # A tiny fallback for DB doubles implementing explicit SQL only.
    class _Tx:
        def __enter__(self):
            try:
                connection.execute("BEGIN")
            except Exception:
                pass
            return self

        def __exit__(self, typ, value, tb):
            try:
                connection.execute("ROLLBACK" if typ else "COMMIT")
            except Exception:
                pass
            return False

    return _Tx()


def _job_from_row(row: Mapping[str, Any]) -> WorkerJob:
    required = (
        "job_id", "job_type", "room_id", "source_event_id", "dedupe_key",
        "payload", "attempts", "correlation_id", "locked_by",
        "claim_generation", "claim_token",
    )
    if any(key not in row for key in required) or not row["locked_by"] or not row["claim_token"]:
        raise JobInvariantError("WORKER_JOB_CLAIM_INVARIANT")
    def strict_int(value: Any, code: str, *, minimum: int = 0) -> int:
        # PostgreSQL returns integers for bigint/smallint, while a few test
        # doubles expose canonical decimal strings.  Never call int() on an
        # arbitrary float/bool: silent truncation would change the ordering
        # barrier or retry budget.
        if isinstance(value, bool):
            raise JobInvariantError(code)
        if isinstance(value, int):
            parsed = value
        elif isinstance(value, str) and re.fullmatch(r"(?:0|[1-9][0-9]*)", value):
            parsed = int(value)
        else:
            raise JobInvariantError(code)
        if parsed < minimum:
            raise JobInvariantError(code)
        return parsed

    order_seq = row.get("analytics_order_seq")
    order_kind = row.get("analytics_order_kind")
    if order_seq is not None:
        order_seq = strict_int(order_seq, "WORKER_JOB_ANALYTICS_ORDER_INVARIANT")
    if order_kind is not None:
        order_kind = strict_int(order_kind, "WORKER_JOB_ANALYTICS_ORDER_INVARIANT")
        if order_kind not in (0, 1):
            raise JobInvariantError("WORKER_JOB_ANALYTICS_ORDER_INVARIANT")
    if (order_seq is None) != (order_kind is None):
        raise JobInvariantError("WORKER_JOB_ANALYTICS_ORDER_INVARIANT")
    job_type = str(row["job_type"])
    if job_type == "analytics.consume.v1":
        if order_seq is None or order_kind != 0 or order_seq < 1:
            raise JobInvariantError("WORKER_JOB_ANALYTICS_ORDER_INVARIANT")
    elif job_type == "analytics.replay-room.v1":
        if order_seq is None or order_kind != 1:
            raise JobInvariantError("WORKER_JOB_ANALYTICS_ORDER_INVARIANT")
    elif order_seq is not None or order_kind is not None:
        raise JobInvariantError("WORKER_JOB_ANALYTICS_ORDER_INVARIANT")
    attempts = strict_int(row["attempts"], "WORKER_JOB_ATTEMPTS_INVARIANT", minimum=0)
    claim_generation = strict_int(row["claim_generation"], "WORKER_JOB_CLAIM_GENERATION_INVARIANT", minimum=1)
    return WorkerJob(
        job_id=str(row["job_id"]), job_type=job_type,
        room_id=None if row["room_id"] is None else str(row["room_id"]),
        source_event_id=None if row["source_event_id"] is None else str(row["source_event_id"]),
        dedupe_key=str(row["dedupe_key"]), payload=row["payload"],
        attempts=attempts, correlation_id=str(row["correlation_id"]),
        locked_by=str(row["locked_by"]), claim_generation=str(claim_generation),
        claim_token=str(row["claim_token"]), analytics_order_seq=order_seq,
        analytics_order_kind=order_kind,
    )


def _claim_predicate(job: WorkerJob | JobClaim) -> tuple[Any, ...]:
    worker_id = getattr(job, "locked_by", None)
    if worker_id is None:
        worker_id = getattr(job, "worker_id", None)
    if not worker_id:
        raise JobInvariantError("WORKER_JOB_CLAIM_INVARIANT")
    return (
        job.job_id, job.job_type, job.room_id, job.source_event_id, job.dedupe_key,
        job.correlation_id, job.claim_generation, job.claim_token, worker_id,
    )


class JobStore:
    """One-worker view over the durable ``worker_job`` table.

    A store intentionally claims exactly one job at a time. Horizontal worker
    processes provide concurrency while keeping each lease attempt isolated.
    """

    def __init__(self, db: Any, worker_id: str, *, lease_seconds: int = 120) -> None:
        if not worker_id or len(worker_id) > 128:
            raise ValueError("WORKER_ID_INVALID")
        if lease_seconds < 30:
            raise ValueError("WORKER_LEASE_TOO_SHORT")
        self.db = db
        self.worker_id = worker_id
        self.lease_seconds = lease_seconds
        self.job_claims = JobClaims()

    def claim(self, limit: int = 1) -> list[WorkerJob]:
        if limit != 1:
            raise ValueError("WORKER_CLAIM_SIZE_MUST_BE_ONE")
        with _transaction(self.db):
            candidate_cursor = _execute(self.db, CLAIM_SQL, (1,))
            candidate_rows = candidate_cursor.fetchall()
            job_ids = [str(row[0] if not isinstance(row, Mapping) else row["job_id"]) for row in candidate_rows]
            if not job_ids:
                return []
            settled_cursor = _execute(self.db, SETTLE_SQL, (job_ids, job_ids, job_ids, self.worker_id))
            return [_job_from_row(row) for row in _rows_as_dicts(settled_cursor)]

    def heartbeat(self, job: WorkerJob | JobClaim) -> None:
        sql = """
            UPDATE worker_job SET locked_at = now(), updated_at = now()
            WHERE job_id = %s AND status = 'running' AND locked_by = %s
              AND claim_generation = %s::bigint AND claim_token = %s::uuid
        """
        with _transaction(self.db):
            cursor = self.db.execute(sql, (job.job_id, self.worker_id, job.claim_generation, job.claim_token))
            if getattr(cursor, "rowcount", 0) != 1:
                raise StaleClaim("STALE_CLAIM")

    def require_current(self, connection: Any, job: WorkerJob | JobClaim) -> None:
        cursor = connection.execute(
            """SELECT 1 FROM worker_job WHERE job_id = %s AND job_type = %s
               AND room_id IS NOT DISTINCT FROM %s::uuid
               AND source_event_id IS NOT DISTINCT FROM %s::uuid
               AND dedupe_key = %s AND correlation_id = %s::uuid
               AND claim_generation = %s::bigint AND claim_token = %s::uuid
               AND locked_by = %s AND status = 'running' FOR UPDATE""",
            _claim_predicate(job),
        )
        if getattr(cursor, "rowcount", 0) != 1:
            raise StaleClaim("STALE_CLAIM")

    def succeed(self, job: WorkerJob | JobClaim) -> None:
        """Set succeeded only when this exact claim has a business receipt."""

        with _transaction(self.db):
            self.require_current(self.db, job)
            marker = self.db.execute(
                """SELECT claim_token_hash FROM worker_job_completion
                   WHERE job_id = %s AND claim_generation = %s::bigint FOR UPDATE""",
                (job.job_id, job.claim_generation),
            ).fetchone()
            expected = sha256(str(job.claim_token).encode("utf-8")).hexdigest()
            marker_hash = marker[0] if marker and not isinstance(marker, Mapping) else (marker or {}).get("claim_token_hash")
            if marker_hash != expected:
                raise CompletionMissing("COMPLETION_MISSING")
            changed = self.db.execute(
                """UPDATE worker_job SET status='succeeded', claim_token=NULL,
                   locked_at=NULL, locked_by=NULL, last_error=NULL, updated_at=now()
                   WHERE job_id = %s AND status='running' AND locked_by=%s
                     AND claim_generation=%s::bigint AND claim_token=%s::uuid""",
                (job.job_id, self.worker_id, job.claim_generation, job.claim_token),
            )
            if getattr(changed, "rowcount", 0) != 1:
                raise StaleClaim("STALE_CLAIM")
            self.db.execute(
                "DELETE FROM worker_job_completion WHERE job_id=%s AND claim_generation=%s::bigint",
                (job.job_id, job.claim_generation),
            )

    def fail(self, job: WorkerJob | JobClaim, error: BaseException | str) -> None:
        """Retry or dead-letter with a stable, content-free error code."""

        with _transaction(self.db):
            self.require_current(self.db, job)
            marker = self.db.execute(
                """SELECT claim_token_hash FROM worker_job_completion
                   WHERE job_id=%s AND claim_generation=%s::bigint FOR UPDATE""",
                (job.job_id, job.claim_generation),
            ).fetchone()
            expected = sha256(str(job.claim_token).encode("utf-8")).hexdigest()
            marker_hash = marker[0] if marker and not isinstance(marker, Mapping) else (marker or {}).get("claim_token_hash")
            if marker_hash == expected:
                # Business work committed; a post-commit notification failure
                # must never turn it into retryable/dead.
                self.db.execute(
                    """UPDATE worker_job SET status='succeeded', claim_token=NULL,
                       locked_at=NULL, locked_by=NULL, last_error=NULL, updated_at=now()
                       WHERE job_id=%s AND status='running'""", (job.job_id,)
                )
                self.db.execute(
                    "DELETE FROM worker_job_completion WHERE job_id=%s AND claim_generation=%s::bigint",
                    (job.job_id, job.claim_generation),
                )
                return
            code = getattr(error, "code", None) or (error if isinstance(error, str) else "JOB_HANDLER_FAILED")
            if not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9_]{1,64}", code):
                code = "JOB_HANDLER_FAILED"
            terminal = bool(getattr(error, "terminal", False))
            status_sql = "'dead'" if terminal else "CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'retryable' END"
            run_after_sql = "run_after" if terminal else "CASE WHEN attempts >= max_attempts THEN run_after ELSE now() + interval '5 seconds' END"
            changed = self.db.execute(
                f"""UPDATE worker_job SET status = {status_sql},
                       run_after = {run_after_sql},
                       claim_token=NULL, locked_at=NULL, locked_by=NULL,
                       last_error=%s, updated_at=now()
                       WHERE job_id=%s AND status='running' AND locked_by=%s
                         AND claim_generation=%s::bigint AND claim_token=%s::uuid
                       RETURNING status""",
                (code, job.job_id, self.worker_id, job.claim_generation, job.claim_token),
            )
            if getattr(changed, "rowcount", 0) != 1:
                raise StaleClaim("STALE_CLAIM")
            changed_row = changed.fetchone() if callable(getattr(changed, "fetchone", None)) else None
            if changed_row is None:
                actual_status = "dead" if terminal else None
            elif isinstance(changed_row, Mapping):
                actual_status = changed_row.get("status")
            else:
                actual_status = changed_row[0]
            self._sync_lifecycle_status(self.db, job, "dead" if actual_status == "dead" else None, code)

    @staticmethod
    def _lifecycle_deletion_id(job: WorkerJob | JobClaim) -> str | None:
        """Extract only the opaque deletion UUID for status synchronization."""
        if getattr(job, "job_type", None) != "room.delete-surface.v1":
            return None
        payload = getattr(job, "payload", None)
        if not isinstance(payload, Mapping):
            return None
        value = payload.get("deletionJobId")
        try:
            return str(UUID(str(value)))
        except (ValueError, TypeError, AttributeError):
            return None

    @classmethod
    def _sync_lifecycle_status(
        cls,
        connection: Any,
        job: WorkerJob | JobClaim,
        terminal_status: str | None,
        _failure_code: str | None,
    ) -> None:
        """Project worker outcome onto the parent deletion saga.

        The parent status is monotonic with respect to terminal states: a
        late retry cannot move a completed/dead saga backwards, while a dead
        surface can always escalate a queued/running/retryable saga.
        """
        deletion_id = cls._lifecycle_deletion_id(job)
        if deletion_id is None:
            return
        if terminal_status == "dead":
            status = "dead"
        else:
            status = "retryable"
        # ``last_error`` is intentionally stored on worker_job, not the
        # content-free deletion_job table.  The status table only carries the
        # stable lifecycle state; governance reads the bounded worker code.
        connection.execute(
            """UPDATE deletion_job
                  SET status=CASE
                    WHEN status IN ('completed','dead') THEN status
                    ELSE %s END
                WHERE deletion_job_id=%s""",
            (status, deletion_id),
        )

    def cancel(self, job: WorkerJob | JobClaim, code: str = "JOB_CANCELLED") -> None:
        if not re.fullmatch(r"[A-Z0-9_]{1,64}", code):
            raise ValueError("JOB_COMPLETION_CODE_INVALID")
        with _transaction(self.db):
            self.require_current(self.db, job)
            changed = self.db.execute(
                """UPDATE worker_job SET status='cancelled', claim_token=NULL,
                   locked_at=NULL, locked_by=NULL, last_error=%s, updated_at=now()
                   WHERE job_id=%s AND status='running' AND locked_by=%s
                     AND claim_generation=%s::bigint AND claim_token=%s::uuid""",
                (code, job.job_id, self.worker_id, job.claim_generation, job.claim_token),
            )
            if getattr(changed, "rowcount", 0) != 1:
                raise StaleClaim("STALE_CLAIM")


def succeed_with_matching_completion(db: Any, job: WorkerJob | JobClaim, worker_id: str) -> None:
    """Functional adapter retained for handlers that use the plan's naming."""
    JobStore(db, worker_id).succeed(job)


def apply_bounded_retry_or_dead_cas(db: Any, job: WorkerJob | JobClaim, worker_id: str, error: BaseException | str) -> None:
    """Functional adapter for the fenced retry/dead transition."""
    JobStore(db, worker_id).fail(job, error)


__all__ = [
    "CLAIM_SQL", "SETTLE_SQL", "CompletionConflict", "CompletionMissing",
    "JobClaim", "JobClaims", "JobInvariantError", "JobStore", "StaleClaim", "WorkerJob",
    "apply_bounded_retry_or_dead_cas", "succeed_with_matching_completion",
]
