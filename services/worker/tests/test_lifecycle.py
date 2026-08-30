import unittest
from types import SimpleNamespace

from learning_orbit_worker.core_handlers import TerminalJobError
from learning_orbit_worker.handler_registry import HandlerOutcome
from learning_orbit_worker.jobs import WorkerJob
from learning_orbit_worker.lifecycle import _surface_count, delete_surface_handler, register_lifecycle_handlers
from learning_orbit_worker.handler_registry import HandlerRegistry


DELETION = "00000000-0000-4000-8000-000000000101"
CORRELATION = "00000000-0000-4000-8000-000000000102"


def job(payload, *, dedupe=None, room_id=None, source=None):
    return WorkerJob(
        job_id="00000000-0000-4000-8000-000000000103", job_type="room.delete-surface.v1",
        room_id=room_id, source_event_id=source,
        dedupe_key=dedupe or f"room.delete-surface.v1:{DELETION}:events",
        payload=payload, attempts=1, correlation_id=CORRELATION, locked_by="worker-a",
        claim_generation="1", claim_token="00000000-0000-4000-8000-000000000104",
    )


class LifecycleHandlerTests(unittest.TestCase):
    def test_registry_exposes_source_less_delete_surface_family(self):
        registry = register_lifecycle_handlers(HandlerRegistry())
        self.assertIn("room.delete-surface.v1", registry.names())

    def test_rejects_non_null_room_or_source_claim(self):
        deps = SimpleNamespace(claim=object())
        with self.assertRaisesRegex(TerminalJobError, "IDENTITY"):
            delete_surface_handler(deps, job({"deletionJobId": DELETION, "surface": "events"}, room_id=DELETION))
        with self.assertRaisesRegex(TerminalJobError, "IDENTITY"):
            delete_surface_handler(deps, job({"deletionJobId": DELETION, "surface": "events"}, source=DELETION))

    def test_rejects_payload_dedupe_and_surface_drift_before_database_access(self):
        class ShouldNotQuery:
            def execute(self, *_args):
                raise AssertionError("database access before claim validation")
        deps = SimpleNamespace(claim=object(), db=ShouldNotQuery())
        cases = [
            ({"deletionJobId": DELETION}, None),
            ({"deletionJobId": DELETION, "surface": "unknown"}, None),
            ({"deletionJobId": DELETION, "surface": "events", "extra": 1}, None),
            ({"deletionJobId": DELETION, "surface": "events"}, "wrong"),
        ]
        for payload, dedupe in cases:
            with self.subTest(payload=payload, dedupe=dedupe):
                with self.assertRaises(TerminalJobError):
                    delete_surface_handler(deps, job(payload, dedupe=dedupe or "room.delete-surface.v1:wrong"))

    def test_missing_claim_is_terminal(self):
        with self.assertRaisesRegex(TerminalJobError, "CLAIM"):
            delete_surface_handler(SimpleNamespace(claim=None), job({"deletionJobId": DELETION, "surface": "events"}))

    def test_capability_surfaces_have_explicit_zero_probe(self):
        class ShouldNotQuery:
            def execute(self, *_args):
                raise AssertionError("capability surface must not issue a parameterless query with room args")

        self.assertEqual(_surface_count(ShouldNotQuery(), "caches", DELETION), 0)
        self.assertEqual(_surface_count(ShouldNotQuery(), "provider_copies", DELETION), 0)


if __name__ == "__main__":
    unittest.main()
