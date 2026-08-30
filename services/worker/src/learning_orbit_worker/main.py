"""Worker composition root and supervisor loop."""

from __future__ import annotations

import argparse
import os
import signal
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Event
from typing import Any, Callable, Mapping
from urllib.parse import urlparse

from .core_handlers import register_core_handlers
from .analytics_handlers import register_analytics_handlers
from .handler_registry import HandlerOutcome, HandlerRegistry, WorkerDeps, run_with_lease
from .internal_http import InternalServiceClient
from .jobs import JobStore
from .projection_store import ProjectionStore
from .pipeline_handlers import register_pipeline_handlers
from .lifecycle import register_lifecycle_handlers
from .service_assertion import ServiceAssertionSigner


@dataclass(frozen=True, slots=True)
class WorkerConfig:
    database_url: str
    worker_id: str
    private_key_file: Path
    assertion_issuer: str
    assertion_key_id: str
    internal_base_origin: str
    poll_seconds: float = 1.0
    claim_size: int = 1

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "WorkerConfig":
        env = os.environ if env is None else env
        database_url = env.get("TEST_DATABASE_URL") or env.get("DATABASE_URL")
        worker_id = env.get("LO_WORKER_ID")
        if not database_url:
            raise ValueError("WORKER_DATABASE_URL_REQUIRED")
        if not worker_id:
            raise ValueError("WORKER_ID_REQUIRED")
        private_key_text = env.get("LO_WORKER_ASSERTION_PRIVATE_KEY_FILE")
        if not private_key_text:
            raise ValueError("WORKER_ASSERTION_PRIVATE_KEY_FILE_REQUIRED")
        private_key_file = Path(private_key_text)
        if not private_key_file.is_absolute():
            raise ValueError("WORKER_ASSERTION_PRIVATE_KEY_FILE_INVALID")
        assertion_issuer = env.get("LO_SERVICE_ASSERTION_ISSUER")
        if not assertion_issuer:
            raise ValueError("WORKER_ASSERTION_ISSUER_REQUIRED")
        assertion_key_id = env.get("LO_SERVICE_ASSERTION_KEY_ID")
        if not assertion_key_id:
            raise ValueError("WORKER_ASSERTION_KEY_ID_REQUIRED")
        internal_base_origin = env.get("LO_INTERNAL_BASE_ORIGIN")
        if not internal_base_origin:
            raise ValueError("WORKER_INTERNAL_BASE_ORIGIN_REQUIRED")
        parsed_origin = urlparse(internal_base_origin)
        if (
            parsed_origin.scheme not in {"http", "https"}
            or not parsed_origin.hostname
            or parsed_origin.username is not None
            or parsed_origin.password is not None
            or parsed_origin.path not in {"", "/"}
            or parsed_origin.params
            or parsed_origin.query
            or parsed_origin.fragment
            or (parsed_origin.scheme == "http" and parsed_origin.hostname not in {"127.0.0.1", "localhost", "::1"})
        ):
            raise ValueError("INTERNAL_HTTP_ORIGIN_INVALID")
        claim_size = int(env.get("LO_WORKER_CLAIM_SIZE", "1"))
        if claim_size != 1:
            raise ValueError("WORKER_CLAIM_SIZE_MUST_BE_ONE")
        poll = float(env.get("LO_WORKER_POLL_SECONDS", "1"))
        if poll <= 0 or poll > 60:
            raise ValueError("WORKER_POLL_INTERVAL_INVALID")
        return cls(
            database_url, worker_id, private_key_file, assertion_issuer,
            assertion_key_id, internal_base_origin, poll, claim_size,
        )


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


def build_supervisor(
    config: WorkerConfig | None = None,
    *,
    connect: Callable[..., Any] | None = None,
    signer_factory: Callable[..., Any] = ServiceAssertionSigner,
    client_factory: Callable[..., Any] = InternalServiceClient,
) -> WorkerSupervisor:
    config = config or WorkerConfig.from_env()
    if connect is None:
        try:
            import psycopg
        except ImportError as error:
            raise RuntimeError("WORKER_PSYCOPG_MISSING") from error
        connect = psycopg.connect
    connection = connect(config.database_url, autocommit=True)
    try:
        signer = signer_factory(
            config.assertion_issuer,
            config.assertion_key_id,
            config.private_key_file,
        )
        internal_http = client_factory(config.internal_base_origin, signer)
        jobs = JobStore(connection, config.worker_id)
        deps = WorkerDeps(
            connection,
            jobs,
            service_assertion=signer,
            internal_http=internal_http,
            projection_store=ProjectionStore(connection),
        )
        return WorkerSupervisor(
            connection,
            config.worker_id,
            deps=deps,
            poll_seconds=config.poll_seconds,
        )
    except BaseException:
        close = getattr(connection, "close", None)
        if callable(close):
            close()
        raise


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
