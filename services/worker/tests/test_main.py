import unittest
from pathlib import Path

from learning_orbit_worker.main import (
    WorkerConfig,
    WorkerSupervisor,
    WorkerSupervisorUnavailable,
    build_supervisor,
    classify_worker_error,
    supervisor_backoff_seconds,
)
from learning_orbit_worker.observability import InMemoryTelemetry, create_telemetry


class _Connection:
    def __init__(self):
        self.close_calls = 0

    def close(self):
        self.close_calls += 1


class WorkerCompositionTests(unittest.TestCase):
    def valid_env(self, private_key_file="/tmp/worker.pem"):
        return {
            "DATABASE_URL": "postgres://local.invalid/pilot_test",
            "LO_WORKER_ID": "pilot-worker-1",
            "LO_WORKER_ASSERTION_PRIVATE_KEY_FILE": private_key_file,
            "LO_SERVICE_ASSERTION_ISSUER": "learning-orbit-local-pilot",
            "LO_SERVICE_ASSERTION_KEY_ID": "pilot-key-1",
            "LO_INTERNAL_BASE_ORIGIN": "http://127.0.0.1:3001",
            "LO_WORKER_CLAIM_SIZE": "1",
            "LO_WORKER_POLL_SECONDS": "0.25",
        }

    def test_config_requires_the_complete_internal_service_identity(self):
        config = WorkerConfig.from_env(self.valid_env())
        self.assertEqual(config.private_key_file, Path("/tmp/worker.pem"))
        self.assertEqual(config.assertion_issuer, "learning-orbit-local-pilot")
        self.assertEqual(config.assertion_key_id, "pilot-key-1")
        self.assertEqual(config.internal_base_origin, "http://127.0.0.1:3001")
        for name, code in [
            ("LO_WORKER_ASSERTION_PRIVATE_KEY_FILE", "WORKER_ASSERTION_PRIVATE_KEY_FILE_REQUIRED"),
            ("LO_SERVICE_ASSERTION_ISSUER", "WORKER_ASSERTION_ISSUER_REQUIRED"),
            ("LO_SERVICE_ASSERTION_KEY_ID", "WORKER_ASSERTION_KEY_ID_REQUIRED"),
            ("LO_INTERNAL_BASE_ORIGIN", "WORKER_INTERNAL_BASE_ORIGIN_REQUIRED"),
        ]:
            with self.subTest(name=name):
                env = self.valid_env()
                del env[name]
                with self.assertRaisesRegex(ValueError, code):
                    WorkerConfig.from_env(env)

    def test_environment_template_documents_required_composition_fields(self):
        template = (Path(__file__).resolve().parents[3] / ".env.example").read_text()
        for name in [
            "LO_WORKER_ASSERTION_PRIVATE_KEY_FILE",
            "LO_SERVICE_ASSERTION_ISSUER",
            "LO_SERVICE_ASSERTION_KEY_ID",
            "LO_INTERNAL_BASE_ORIGIN",
        ]:
            self.assertIn(f"{name}=", template)

    def test_build_supervisor_injects_signer_and_internal_client(self):
        connection = _Connection()
        signer = object()
        internal = object()
        signer_calls = []
        client_calls = []

        def connect(database_url, *, autocommit):
            self.assertEqual(database_url, "postgres://local.invalid/pilot_test")
            self.assertTrue(autocommit)
            return connection

        def signer_factory(issuer, key_id, private_key_file):
            signer_calls.append((issuer, key_id, private_key_file))
            return signer

        def client_factory(base_origin, configured_signer):
            client_calls.append((base_origin, configured_signer))
            return internal

        config = WorkerConfig.from_env(self.valid_env())
        supervisor = build_supervisor(
            config,
            connect=connect,
            signer_factory=signer_factory,
            client_factory=client_factory,
        )
        self.assertIs(supervisor.jobs.db, connection)
        self.assertIs(supervisor.deps.service_assertion, signer)
        self.assertIs(supervisor.deps.internal_http, internal)
        self.assertEqual(signer_calls, [(config.assertion_issuer, config.assertion_key_id, config.private_key_file)])
        self.assertEqual(client_calls, [(config.internal_base_origin, signer)])

    def test_config_rejects_relative_key_paths_and_nonlocal_plain_http(self):
        env = self.valid_env("relative.pem")
        with self.assertRaisesRegex(ValueError, "WORKER_ASSERTION_PRIVATE_KEY_FILE_INVALID"):
            WorkerConfig.from_env(env)
        env = self.valid_env()
        env["LO_INTERNAL_BASE_ORIGIN"] = "http://example.com"
        with self.assertRaisesRegex(ValueError, "INTERNAL_HTTP_ORIGIN_INVALID"):
            WorkerConfig.from_env(env)

    def test_factory_failure_closes_the_database_connection_once(self):
        connection = _Connection()

        def fail_signer(*_args):
            raise ValueError("SERVICE_ASSERTION_KEY_INVALID")

        with self.assertRaisesRegex(ValueError, "SERVICE_ASSERTION_KEY_INVALID"):
            build_supervisor(
                WorkerConfig.from_env(self.valid_env()),
                connect=lambda *_args, **_kwargs: connection,
                signer_factory=fail_signer,
            )
        self.assertEqual(connection.close_calls, 1)


if __name__ == "__main__":
    unittest.main()


class _FailingJobs:
    """Claim raises a chosen error a fixed number of times, then succeeds."""

    def __init__(self, error, failures):
        self.error = error
        self.remaining = failures
        self.claims = 0

    def claim(self, _limit):
        self.claims += 1
        if self.remaining > 0:
            self.remaining -= 1
            raise self.error
        return []


class _StopAfter:
    """An Event-like object that stops the loop after N waits."""

    def __init__(self, waits):
        self.remaining = waits
        self.slept = []

    def is_set(self):
        return self.remaining <= 0

    def wait(self, seconds):
        self.slept.append(seconds)
        self.remaining -= 1


def _supervisor(jobs, telemetry=None):
    supervisor = WorkerSupervisor.__new__(WorkerSupervisor)
    supervisor.jobs = jobs
    supervisor.registry = None
    supervisor.deps = None
    supervisor.poll_seconds = 0.0
    supervisor.telemetry = telemetry or create_telemetry()
    supervisor.consecutive_failures = 0
    return supervisor


class WorkerSupervisorResilienceTests(unittest.TestCase):
    def test_classifies_driver_and_programming_failures_apart(self):
        class OperationalError(Exception):
            pass

        class SerializationFailure(OperationalError):
            pass

        class ProgrammingError(Exception):
            pass

        for error, expected in [
            (OperationalError("connection reset"), "transient"),
            (SerializationFailure("could not serialize"), "transient"),
            (ConnectionResetError("peer went away"), "transient"),
            (TimeoutError("statement timeout"), "transient"),
            (ProgrammingError("column does not exist"), "permanent"),
            (ValueError("ANALYTICS_JOB_PAYLOAD_INVALID"), "permanent"),
            # An unrecognised failure must not be assumed recoverable, or a
            # real defect retries quietly forever.
            (Exception("something new"), "permanent"),
        ]:
            with self.subTest(error=type(error).__name__):
                self.assertEqual(classify_worker_error(error), expected)

    def test_backoff_grows_and_is_capped(self):
        self.assertEqual(supervisor_backoff_seconds(0), 0.0)
        self.assertEqual(supervisor_backoff_seconds(1), 0.5)
        self.assertEqual(supervisor_backoff_seconds(2), 1.0)
        self.assertEqual(supervisor_backoff_seconds(3), 2.0)
        self.assertEqual(supervisor_backoff_seconds(99), 30.0)

    def test_survives_a_transient_failure_and_keeps_claiming(self):
        class OperationalError(Exception):
            pass

        jobs = _FailingJobs(OperationalError("connection reset"), failures=2)
        sink = InMemoryTelemetry()
        supervisor = _supervisor(jobs, sink.telemetry(now=lambda: 0.0))
        stop = _StopAfter(waits=4)

        supervisor.run_forever(stop)

        # Two failed iterations backed off, then a successful empty claim.
        self.assertGreaterEqual(jobs.claims, 3)
        self.assertEqual(stop.slept[:2], [0.5, 1.0])
        self.assertEqual(supervisor.consecutive_failures, 0)
        self.assertEqual(
            [span["name"] for span in sink.spans],
            ["worker.supervisor.iteration_failed"] * 2,
        )
        self.assertEqual(
            sink.spans[0]["attributes"]["failureCode"],
            "SUPERVISOR_TRANSIENT_FAILURE",
        )

    def test_gives_up_when_nothing_succeeds_between_failures(self):
        jobs = _FailingJobs(ValueError("WORKER_JOB_ROW_INVALID"), failures=99)
        supervisor = _supervisor(jobs)
        with self.assertRaises(WorkerSupervisorUnavailable) as raised:
            supervisor.run_forever(_StopAfter(waits=50))
        self.assertEqual(str(raised.exception), "SUPERVISOR_PERMANENT_FAILURE")
        self.assertEqual(jobs.claims, 5)

    def test_a_stop_request_is_never_swallowed_as_a_failure(self):
        jobs = _FailingJobs(KeyboardInterrupt(), failures=1)
        supervisor = _supervisor(jobs)
        with self.assertRaises(KeyboardInterrupt):
            supervisor.run_forever(_StopAfter(waits=5))
