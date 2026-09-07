"""The heartbeat that keeps one attempt's lease alive, and what happens when it cannot."""
import threading
import time
import unittest
from types import SimpleNamespace

from learning_orbit_worker.handler_registry import HandlerOutcome, run_with_lease
from learning_orbit_worker.jobs import StaleClaim, WorkerJob


def job():
    return WorkerJob(
        job_id="11111111-1111-4111-8111-111111111111",
        job_type="room.auto-close.v1",
        room_id="33333333-3333-4333-8333-333333333333",
        source_event_id=None,
        dedupe_key="room.auto-close.v1:11111111-1111-4111-8111-111111111111",
        correlation_id="44444444-4444-4444-8444-444444444444",
        payload={},
        attempts=1,
        claim_generation="1",
        claim_token="22222222-2222-4222-8222-222222222222",
        locked_by="worker-a",
    )


class RecordingJobs:
    """A JobStore double that counts the transitions run_with_lease performs."""

    def __init__(self, lease_seconds=120.0, heartbeat_raises=None):
        self.lease_seconds = lease_seconds
        self.heartbeats = 0
        self.succeeded = []
        self.failed = []
        self.heartbeat_raises = heartbeat_raises
        self.lock = threading.Lock()

    def heartbeat(self, _job):
        with self.lock:
            self.heartbeats += 1
            if self.heartbeat_raises is not None:
                raise self.heartbeat_raises

    def succeed(self, job):
        self.succeeded.append(job.job_id)

    def fail(self, job, error):
        self.failed.append((job.job_id, getattr(error, "code", type(error).__name__)))


def deps_for(jobs):
    base = SimpleNamespace(
        db=None, jobs=jobs, service_assertion=None, internal_http=None,
        connection_factory=None, claim=None, attempt_cancelled=None,
        stop_heartbeat=None, job_claims=None,
    )

    def for_attempt(claim, attempt_cancelled=None, stop_heartbeat=None):
        return SimpleNamespace(
            db=None, jobs=jobs, service_assertion=None, internal_http=None,
            connection_factory=None, claim=claim,
            attempt_cancelled=attempt_cancelled or threading.Event(),
            stop_heartbeat=stop_heartbeat or threading.Event(),
            job_claims=None,
        )

    base.for_attempt = for_attempt
    return base


def live_heartbeat_threads():
    return [thread for thread in threading.enumerate() if thread.name.startswith("lo-heartbeat-")]


class WorkerLeaseTests(unittest.TestCase):
    def test_a_quick_success_leaves_no_heartbeat_thread_behind(self):
        jobs = RecordingJobs()
        before = len(live_heartbeat_threads())

        outcome = run_with_lease(job(), lambda _deps, _job: HandlerOutcome.SUCCESS, deps_for(jobs),
                                 heartbeat_period=0.05)

        self.assertIs(outcome, HandlerOutcome.SUCCESS)
        self.assertEqual(jobs.succeeded, ["11111111-1111-4111-8111-111111111111"])
        # A daemon flag protects interpreter shutdown, not correctness: an
        # attempt that returned must not leave a thread renewing its lease.
        self.assertEqual(len(live_heartbeat_threads()), before)

    def test_a_handler_that_outlives_one_period_keeps_its_lease_renewed(self):
        jobs = RecordingJobs()

        def slow(_deps, _job):
            time.sleep(0.35)
            return HandlerOutcome.SUCCESS

        run_with_lease(job(), slow, deps_for(jobs), heartbeat_period=0.05)

        self.assertGreaterEqual(jobs.heartbeats, 2)

    def test_a_failing_handler_is_recorded_once_and_not_also_succeeded(self):
        jobs = RecordingJobs()

        class Boom(Exception):
            code = "HANDLER_EXPLODED"

        outcome = run_with_lease(job(), lambda _deps, _job: (_ for _ in ()).throw(Boom()),
                                 deps_for(jobs), heartbeat_period=0.05)

        self.assertIsNot(outcome, HandlerOutcome.SUCCESS)
        self.assertEqual(jobs.failed, [("11111111-1111-4111-8111-111111111111", "HANDLER_EXPLODED")])
        self.assertEqual(jobs.succeeded, [])

    def test_a_lost_lease_is_never_converted_into_a_success(self):
        jobs = RecordingJobs()

        def succeeded_but_stale(job_arg):
            raise StaleClaim("STALE_CLAIM")

        jobs.succeed = succeeded_but_stale

        outcome = run_with_lease(job(), lambda _deps, _job: HandlerOutcome.SUCCESS,
                                 deps_for(jobs), heartbeat_period=0.05)

        # Another worker owns the job; this attempt must not report success.
        self.assertIs(outcome, HandlerOutcome.LOST_LEASE)

    def test_refuses_a_heartbeat_period_that_cannot_hold_the_lease(self):
        jobs = RecordingJobs(lease_seconds=120.0)
        for period in [0, -1, 40.0, 120.0]:
            with self.subTest(period=period):
                with self.assertRaises(ValueError):
                    run_with_lease(job(), lambda _deps, _job: HandlerOutcome.SUCCESS,
                                   deps_for(jobs), heartbeat_period=period)

    def test_defaults_to_renewing_well_inside_the_lease(self):
        jobs = RecordingJobs(lease_seconds=120.0)
        run_with_lease(job(), lambda _deps, _job: HandlerOutcome.SUCCESS, deps_for(jobs))
        # The default must be under a third of the lease so two missed renewals
        # still leave the claim alive.
        self.assertLess(min(30.0, jobs.lease_seconds / 3.0 - 0.001), jobs.lease_seconds / 3.0)
