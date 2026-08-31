import unittest
from types import SimpleNamespace

from learning_orbit_worker.core_handlers import TerminalJobError
from learning_orbit_worker.handler_registry import HandlerOutcome
from learning_orbit_worker.jobs import WorkerJob
from learning_orbit_worker.lifecycle import _delete_surface, _surface_count, delete_surface_handler, register_lifecycle_handlers
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

    def test_cache_is_explicit_zero_but_provider_surface_counts_potential_external_records(self):
        class ShouldNotQuery:
            def execute(self, *_args):
                raise AssertionError("capability surface must not issue a parameterless query with room args")

        self.assertEqual(_surface_count(ShouldNotQuery(), "caches", DELETION), 0)

        class Result:
            @staticmethod
            def fetchone():
                return (2,)

        class RecordingConnection:
            def __init__(self):
                self.calls = []

            def execute(self, sql, values):
                self.calls.append((sql, values))
                return Result()

        connection = RecordingConnection()
        self.assertEqual(_surface_count(connection, "provider_copies", DELETION), 2)
        sql, values = connection.calls[-1]
        self.assertIn("media_asset", sql)
        self.assertIn("agent_run", sql)
        self.assertIn("provider NOT IN ('learner-authored','teacher-correction')", sql)
        self.assertEqual(values, (DELETION,) * 3)

    def test_relational_surface_probes_cover_review_and_projection_metadata(self):
        class Result:
            @staticmethod
            def fetchone():
                return (3,)

        class RecordingConnection:
            def __init__(self):
                self.calls = []

            def execute(self, sql, values):
                self.calls.append((sql, values))
                return Result()

        connection = RecordingConnection()
        self.assertEqual(_surface_count(connection, "artifacts", DELETION), 3)
        artifact_sql, artifact_values = connection.calls[-1]
        self.assertIn("analytics_review_detail", artifact_sql)
        self.assertIn("extraction_artifacts", artifact_sql)
        self.assertEqual(artifact_values, (DELETION,) * 3)

        self.assertEqual(_surface_count(connection, "projections", DELETION), 3)
        projection_sql, projection_values = connection.calls[-1]
        self.assertIn("analysis_room_heads", projection_sql)
        self.assertIn("student_analytics_promotion", projection_sql)
        self.assertEqual(projection_values, (DELETION,) * 5)

    def test_artifact_deletion_removes_teacher_review_detail_before_artifacts(self):
        class RecordingConnection:
            def __init__(self):
                self.calls = []

            def execute(self, sql, values):
                self.calls.append((sql, values))

        connection = RecordingConnection()
        _delete_surface(connection, "artifacts", DELETION)
        self.assertEqual(len(connection.calls), 3)
        self.assertIn("DELETE FROM extraction_artifacts", connection.calls[0][0])
        self.assertIn("DELETE FROM analytics_review_detail", connection.calls[1][0])
        self.assertIn("DELETE FROM derived_text_artifact", connection.calls[2][0])
        self.assertTrue(all(values == (DELETION,) for _, values in connection.calls))


if __name__ == "__main__":
    unittest.main()
