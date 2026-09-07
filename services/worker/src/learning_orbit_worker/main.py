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

from .observability import OtlpHttpSpanSink, Telemetry, create_telemetry, telemetry_from_env
from .core_handlers import register_core_handlers
from .analytics_handlers import register_analytics_handlers
from .handler_registry import HandlerOutcome, HandlerRegistry, WorkerDeps, run_with_lease
from .internal_http import InternalServiceClient
from .jobs import JobStore
from .projection_store import ProjectionStore
from .pipeline_handlers import register_pipeline_handlers
from .lifecycle import register_lifecycle_handlers
from .multimodal_handlers import register_multimodal_handlers
from .service_assertion import ServiceAssertionSigner
from .agent.executor import DurableAgentExecutor
from .media.processor import MediaProcessor
from .media.scan import ClamAvScanner
from .media.sigv4 import S3Credentials
from .media.store import PrivateObjectStore
from .media.transcode import FfmpegTranscoder


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


# A dropped connection, a restarted database or a serialization failure are
# expected in a long-running worker. A programming fault is not, and reporting
# one as if it were routine would hide it.
TRANSIENT_ERROR_NAMES = frozenset({
    "OperationalError", "InterfaceError", "ConnectionException",
    "ConnectionError", "ConnectionResetError", "BrokenPipeError",
    "TimeoutError", "OSError", "AdminShutdown", "CannotConnectNow",
    "SerializationFailure", "DeadlockDetected", "LockNotAvailable",
})
PERMANENT_ERROR_NAMES = frozenset({
    "ProgrammingError", "IntegrityError", "DataError", "InternalError",
    "NotSupportedError", "ValueError", "TypeError", "KeyError",
    "AttributeError", "ImportError", "LookupError",
})

BASE_BACKOFF_SECONDS = 0.5
MAX_BACKOFF_SECONDS = 30.0
MAX_CONSECUTIVE_FAILURES = 5


class WorkerSupervisorUnavailable(RuntimeError):
    """The loop failed repeatedly with no successful iteration between."""


def classify_worker_error(error: BaseException) -> str:
    """Classify a failure that escaped one supervisor iteration.

    Classification walks the exception's own class hierarchy by name so the
    worker does not have to import psycopg to reason about a psycopg error, and
    so a driver-specific subclass (SerializationFailure under OperationalError)
    is classified by the family it actually belongs to.

    An unrecognised failure is `permanent`: calling it transient would let a
    real defect retry quietly forever.
    """
    names = {cls.__name__ for cls in type(error).__mro__}
    if names & TRANSIENT_ERROR_NAMES:
        return "transient"
    if names & PERMANENT_ERROR_NAMES:
        return "permanent"
    return "permanent"


def supervisor_backoff_seconds(consecutive_failures: int) -> float:
    """Exponential backoff, capped, so a database outage is not a hot loop."""
    if consecutive_failures < 1:
        return 0.0
    return min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * (2 ** (consecutive_failures - 1)))


class WorkerSupervisor:
    def __init__(self, connection: Any, worker_id: str, *, registry: HandlerRegistry | None = None, deps: WorkerDeps | None = None, poll_seconds: float = 1.0, telemetry: Telemetry | None = None) -> None:
        self.registry = registry or register_multimodal_handlers(register_lifecycle_handlers(register_pipeline_handlers(register_analytics_handlers(register_core_handlers(HandlerRegistry())))))
        self.jobs = JobStore(connection, worker_id)
        self.deps = deps or WorkerDeps(connection, self.jobs, projection_store=ProjectionStore(connection))
        self.poll_seconds = poll_seconds
        self.telemetry = telemetry or create_telemetry()
        self.span_sink: OtlpHttpSpanSink | None = None
        self.consecutive_failures = 0

    def run_once(self) -> HandlerOutcome | None:
        jobs = self.jobs.claim(1)
        if not jobs:
            return None
        job = jobs[0]
        # The correlation id comes from the claimed row, never from a new
        # identifier minted here, so the worker's spans join the same trace as
        # the command that created the job.
        started = time.monotonic()
        self.telemetry.record("worker.claim", {
            "jobId": job.job_id, "roomId": job.room_id,
            "correlationId": job.correlation_id, "attempts": job.attempts,
        })
        outcome = run_with_lease(job, self.registry.get(job.job_type), self.deps)
        self.telemetry.record(
            "worker.job",
            {
                "jobId": job.job_id, "roomId": job.room_id,
                "correlationId": job.correlation_id,
                "failureCode": getattr(outcome, "completion_code", None) or "COMPLETED",
            },
            duration_ms=(time.monotonic() - started) * 1000.0,
        )
        return outcome

    def run_forever(self, stop: Event | None = None) -> None:
        """Claim and run jobs until stopped, surviving transient failure.

        A failure that escapes `run_once` is outside job handling - claiming,
        or the connection itself - because `run_with_lease` already owns a
        handler's own failure. Previously any such failure ended the loop
        silently, so a single database blip stopped the worker while its
        process stayed alive and healthy-looking.
        """
        stop = stop or Event()
        self.consecutive_failures = 0
        while not stop.is_set():
            try:
                outcome = self.run_once()
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException as error:  # noqa: BLE001 - the loop must survive
                self.consecutive_failures += 1
                classification = classify_worker_error(error)
                self.telemetry.record("worker.supervisor.iteration_failed", {
                    "failureCode": f"SUPERVISOR_{classification.upper()}_FAILURE",
                })
                if self.consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                    # Repeated failure with no successful iteration between is
                    # not something this loop can recover from. Surface it so a
                    # process manager restarts the whole worker rather than
                    # leaving it retrying an unrecoverable state forever.
                    raise WorkerSupervisorUnavailable(
                        f"SUPERVISOR_{classification.upper()}_FAILURE",
                    ) from error
                stop.wait(supervisor_backoff_seconds(self.consecutive_failures))
                continue
            self.consecutive_failures = 0
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
        # The media processor exists only when the private store is fully
        # configured. A partly supplied store is always a mistake, and a
        # processor that could not read the object would report failures that
        # look like bad uploads.
        media_processor = build_media_processor(connection, internal_http)
        deps = WorkerDeps(
            connection,
            jobs,
            service_assertion=signer,
            internal_http=internal_http,
            projection_store=ProjectionStore(connection),
            # The executor is injected here and nowhere else. Without it the
            # handler refuses every agent job, which is correct but means Nova
            # never answers; with a fixture in its place students would get
            # canned text they could not tell from a real answer.
            agent_executor=DurableAgentExecutor(connection, internal_http),
            **({"media_processor": media_processor} if media_processor else {}),
        )
        telemetry, span_sink = telemetry_from_env()
        supervisor = WorkerSupervisor(
            connection,
            config.worker_id,
            deps=deps,
            poll_seconds=config.poll_seconds,
            telemetry=telemetry,
        )
        supervisor.span_sink = span_sink
        return supervisor
    except BaseException:
        close = getattr(connection, "close", None)
        if callable(close):
            close()
        raise


def build_media_processor(connection: Any, internal_http: Any, env: Mapping[str, str] | None = None) -> Any:
    """Compose the media processor, or return None when there is no store.

    Absent is a supported state: `media.process.v1` then refuses every job with
    a stated reason rather than reporting an upload as processed. Partly
    supplied is not, because it is always a mistake.
    """
    env = os.environ if env is None else env
    parts = {
        name: env.get(f"LO_STORAGE_{name.upper()}", "")
        for name in ("endpoint", "bucket", "access_key_id", "secret_access_key")
    }
    supplied = [value for value in parts.values() if value]
    if not supplied:
        return None
    if len(supplied) != 4:
        raise ValueError("LO_STORAGE_TRANSPORT_INCOMPLETE")
    store = PrivateObjectStore(
        parts["endpoint"], parts["bucket"],
        S3Credentials(parts["access_key_id"], parts["secret_access_key"],
                      env.get("LO_STORAGE_REGION") or "us-east-1"),
    )
    scanner = ClamAvScanner(
        env.get("LO_CLAMAV_HOST") or "127.0.0.1",
        int(env.get("LO_CLAMAV_PORT") or "3310"),
    )
    return MediaProcessor(connection, store, internal_http, scanner=scanner, transcoder=FfmpegTranscoder())


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
        if supervisor.span_sink is not None:
            supervisor.span_sink.flush()
        close = getattr(supervisor.jobs.db, "close", None)
        if callable(close):
            close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
