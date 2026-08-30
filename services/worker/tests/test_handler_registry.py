import unittest
from threading import Event

from learning_orbit_worker.handler_registry import HandlerOutcome, HandlerRegistry, WorkerClaim


class RegistryTests(unittest.TestCase):
    def test_duplicate_and_unknown_are_rejected(self):
        registry = HandlerRegistry()
        registry.register("probe.v1", lambda _deps, _job: HandlerOutcome.SUCCESS)
        with self.assertRaisesRegex(ValueError, "DUPLICATE"):
            registry.register("probe.v1", lambda _deps, _job: HandlerOutcome.SUCCESS)
        with self.assertRaisesRegex(KeyError, "UNKNOWN"):
            registry.get("other.v1")

    def test_claim_preserves_locked_subject(self):
        claim = WorkerClaim.from_job({
            "job_id": "j", "job_type": "probe.v1", "room_id": None,
            "source_event_id": None, "dedupe_key": "d", "correlation_id": "c",
            "claim_generation": "1", "claim_token": "t", "locked_by": "worker-a",
        })
        self.assertEqual(claim.worker_id, "worker-a")
        self.assertIs(HandlerOutcome.success, HandlerOutcome.SUCCESS)

