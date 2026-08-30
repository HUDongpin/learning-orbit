"""Worker composition root and supervisor loop."""

from __future__ import annotations

import argparse
import os
import signal
import time
from dataclasses import dataclass
from threading import Event
from typing import Any

from .core_handlers import register_core_handlers
from .analytics_handlers import register_analytics_handlers
from .handler_registry import HandlerOutcome, HandlerRegistry, WorkerDeps, run_with_lease
from .jobs import JobStore
from .projection_store import ProjectionStore
from .pipeline_handlers import register_pipeline_handlers
from .lifecycle import register_lifecycle_handlers


@dataclass(frozen=True, slots=True)
class WorkerConfig:
    database_url: str
    worker_id: str
    poll_seconds: float = 1.0
    claim_size: int = 1

    @classmethod
    def from_env(cls) -> "WorkerConfig":
        database_url = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
        worker_id = os.environ.get("LO_WORKER_ID")
        if not database_url:
            raise ValueError("WORKER_DATABASE_URL_REQUIRED")
        if not worker_id:
            raise ValueError("WORKER_ID_REQUIRED")
        claim_size = int(os.environ.get("LO_WORKER_CLAIM_SIZE", "1"))
        if claim_size != 1:
            raise ValueError("WORKER_CLAIM_SIZE_MUST_BE_ONE")
        poll = float(os.environ.get("LO_WORKER_POLL_SECONDS", "1"))
        if poll <= 0 or poll > 60:
            raise ValueError("WORKER_POLL_INTERVAL_INVALID")
        return cls(database_url, worker_id, poll, claim_size)


class WorkerSupervisor:
    def __init__(self, connection: Any, worker_id: str, *, registry: HandlerRegistry | None = None, deps: WorkerDeps | None = None, poll_seconds: float = 1.0) -> None:
        self.registry = registry or register_lifecycle_handlers(register_pipeline_handlers(register_analytics_handlers(register_core_handlers(HandlerRegistry()))))
        self.jobs = JobStore(connection, worker_id)
        self.deps = deps or WorkerDeps(connection, self.jobs, projection_store=ProjectionStore(connection))
        self.poll_seconds = poll_seconds

    def run_once(self) -> HandlerOutcome | None:
        jobs = self.jobs.claim(1)
        if not jobs:
            return None
        job = jobs[0]
        return run_with_lease(job, self.registry.get(job.job_type), self.deps)

    def run_forever(self, stop: Event | None = None) -> None:
        stop = stop or Event()
        while not stop.is_set():
            outcome = self.run_once()
            if outcome is None:
                stop.wait(self.poll_seconds)


def build_supervisor(config: WorkerConfig | None = None) -> WorkerSupervisor:
    config = config or WorkerConfig.from_env()
    try:
        import psycopg
    except ImportError as error:
        raise RuntimeError("WORKER_PSYCOPG_MISSING") from error
    connection = psycopg.connect(config.database_url, autocommit=True)
    return WorkerSupervisor(connection, config.worker_id, poll_seconds=config.poll_seconds)


def main() -> int:
    parser = argparse.ArgumentParser(description="Learning Orbit durable Worker")
    parser.add_argument("--once", action="store_true", help="claim at most one job")
    args = parser.parse_args()
    supervisor = build_supervisor()
    stop = Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    try:
        if args.once:
            supervisor.run_once()
        else:
            supervisor.run_forever(stop)
    finally:
        close = getattr(supervisor.jobs.db, "close", None)
        if callable(close):
            close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
