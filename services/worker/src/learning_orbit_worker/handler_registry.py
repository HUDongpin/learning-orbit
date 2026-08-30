"""Single dispatch authority and lease-scoped handler dependencies."""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import Enum
from threading import Event, Thread
from typing import Any, Callable, Mapping, Protocol

from .jobs import JobClaim, JobClaims, JobStore, StaleClaim, WorkerJob


class HandlerOutcome(str, Enum):
    SUCCESS = "success"
    TERMINAL_CANCELLED = "terminal_cancelled"
    LOST_LEASE = "lost_lease"

    # Lower-case aliases mirror the JSON/TypeScript vocabulary in the plan.
    success = SUCCESS
    terminal_cancelled = TERMINAL_CANCELLED
    lost_lease = LOST_LEASE


class Handler(Protocol):
    def __call__(self, deps: "WorkerDeps", job: WorkerJob) -> HandlerOutcome: ...


@dataclass(frozen=True, slots=True)
class WorkerClaim:
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
        if key not in {"job_id", "job_type", "room_id", "source_event_id", "dedupe_key", "correlation_id", "claim_generation", "claim_token", "worker_id"}:
            raise KeyError(key)
        return getattr(self, key)

    @classmethod
    def from_job(cls, job: WorkerJob | Mapping[str, Any]) -> "WorkerClaim":
        if isinstance(job, WorkerJob):
            return cls(job.job_id, job.job_type, job.room_id, job.source_event_id, job.dedupe_key, job.correlation_id, job.claim_generation, job.claim_token, job.locked_by)
        return cls(
            str(job["job_id"]), str(job["job_type"]), job.get("room_id"), job.get("source_event_id"),
            str(job["dedupe_key"]), str(job["correlation_id"]), str(job["claim_generation"]),
            str(job["claim_token"]), str(job["locked_by"]),
        )

    def as_job_claim(self) -> JobClaim:
        return JobClaim(self.job_id, self.job_type, self.room_id, self.source_event_id, self.dedupe_key, self.correlation_id, self.claim_generation, self.claim_token, self.worker_id)


@dataclass(frozen=True, slots=True)
class WorkerDeps:
    """Immutable shared ports plus per-attempt cancellation state."""

    db: Any
    jobs: JobStore
    service_assertion: Any = None
    internal_http: Any = None
    connection_factory: Callable[[], Any] | None = None
    claim: WorkerClaim | None = None
    attempt_cancelled: Event | None = None
    stop_heartbeat: Event | None = None
    job_claims: JobClaims | None = None
    projection_store: Any = None
    # Optional capability seams.  The composition root must inject reviewed
    # implementations; absent capabilities are never treated as success.
    media_processor: Any = None
    agent_executor: Any = None

    def __post_init__(self) -> None:
        if self.job_claims is None:
            object.__setattr__(self, "job_claims", getattr(self.jobs, "job_claims", JobClaims()))
        if self.connection_factory is None and hasattr(self.db, "info"):
            try:
                import psycopg
                dsn = self.db.info.dsn
                object.__setattr__(self, "connection_factory", lambda: psycopg.connect(dsn, autocommit=True))
            except Exception:
                # Unit doubles and restricted environments can omit a second
                # connection; the heartbeat still remains fenced by CAS.
                pass

    @property
    def cancelled(self) -> bool:
        return bool(self.attempt_cancelled and self.attempt_cancelled.is_set())

    def for_attempt(self, claim: WorkerClaim, attempt_cancelled: Event | None = None, stop_heartbeat: Event | None = None) -> "WorkerDeps":
        return replace(
            self,
            claim=claim,
            attempt_cancelled=attempt_cancelled or Event(),
            stop_heartbeat=stop_heartbeat or Event(),
            jobs=JobStore(self.db, claim.worker_id, lease_seconds=self.jobs.lease_seconds),
            job_claims=self.job_claims or JobClaims(),
        )


class HandlerRegistry:
    def __init__(self) -> None:
        self._handlers: dict[str, Handler] = {}

    def register(self, job_type: str, handler: Handler) -> None:
        if not job_type or job_type in self._handlers:
            raise ValueError("WORKER_HANDLER_DUPLICATE")
        if not callable(handler):
            raise TypeError("WORKER_HANDLER_INVALID")
        self._handlers[job_type] = handler

    def get(self, job_type: str) -> Handler:
        try:
            return self._handlers[job_type]
        except KeyError as error:
            raise KeyError("WORKER_HANDLER_UNKNOWN") from error

    def dispatch(self, job: WorkerJob, deps: WorkerDeps) -> HandlerOutcome:
        return self.get(job.job_type)(deps, job)

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._handlers))


def _heartbeat_loop(job: WorkerJob, deps: WorkerDeps, stop: Event, cancelled: Event, interval: float) -> None:
    connection = None
    heartbeat_jobs = deps.jobs
    try:
        if deps.connection_factory is not None:
            connection = deps.connection_factory()
            heartbeat_jobs = JobStore(connection, job.locked_by, lease_seconds=deps.jobs.lease_seconds)
        while not stop.wait(interval):
            try:
                heartbeat_jobs.heartbeat(job)
            except StaleClaim:
                cancelled.set()
                return
            except Exception:
                # A transient heartbeat error is fail-closed: the attempt is
                # cancelled and the lease will be fenced by the next CAS.
                cancelled.set()
                return
    finally:
        close = getattr(connection, "close", None)
        if callable(close):
            close()


def run_with_lease(
    job: WorkerJob,
    handler: Handler,
    base_deps: WorkerDeps,
    *,
    heartbeat_period: float | None = None,
) -> HandlerOutcome:
    """Run one synchronous handler with an isolated heartbeat supervisor."""

    claim = WorkerClaim.from_job(job)
    cancelled = Event()
    stop = Event()
    deps = base_deps.for_attempt(claim, cancelled, stop)
    lease = float(deps.jobs.lease_seconds)
    interval = heartbeat_period if heartbeat_period is not None else min(30.0, lease / 3.0 - 0.001)
    if interval <= 0 or interval >= lease / 3.0:
        raise ValueError("WORKER_HEARTBEAT_PERIOD_INVALID")
    thread = Thread(target=_heartbeat_loop, args=(job, deps, stop, cancelled, interval), name=f"lo-heartbeat-{job.job_id}", daemon=True)
    thread.start()
    outcome = HandlerOutcome.LOST_LEASE
    try:
        try:
            outcome = HandlerOutcome(handler(deps, job))
        except StaleClaim:
            outcome = HandlerOutcome.LOST_LEASE
        except Exception as error:
            if cancelled.is_set():
                outcome = HandlerOutcome.LOST_LEASE
            else:
                try:
                    deps.jobs.fail(job, error)
                except StaleClaim:
                    outcome = HandlerOutcome.LOST_LEASE
                else:
                    outcome = HandlerOutcome.TERMINAL_CANCELLED if getattr(error, "terminal", False) else HandlerOutcome.LOST_LEASE
        if outcome is HandlerOutcome.SUCCESS:
            if cancelled.is_set():
                return HandlerOutcome.LOST_LEASE
            try:
                deps.jobs.succeed(job)
            except StaleClaim:
                return HandlerOutcome.LOST_LEASE
        elif outcome is HandlerOutcome.TERMINAL_CANCELLED:
            # Handler atomically performed the terminal cancellation; no second
            # transition is attempted here.
            return outcome
        return outcome
    finally:
        stop.set()
        thread.join(timeout=max(1.0, interval))
        if thread.is_alive():
            # Never leave a heartbeat running after an attempt returns.  The
            # daemon flag only protects interpreter shutdown, not correctness.
            raise RuntimeError("WORKER_HEARTBEAT_THREAD_LEAK")


__all__ = ["Handler", "HandlerOutcome", "HandlerRegistry", "WorkerClaim", "WorkerDeps", "run_with_lease"]
