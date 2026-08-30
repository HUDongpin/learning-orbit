import unittest
from types import SimpleNamespace
from unittest.mock import patch

from learning_orbit_worker.analytics_handlers import (
    analytics_consume_handler,
    analytics_replay_handler,
)
from learning_orbit_worker.handler_registry import HandlerOutcome
from learning_orbit_worker.jobs import WorkerJob


ROOM = "00000000-0000-4000-8000-000000000010"
EVENT = "00000000-0000-4000-8000-000000000101"


class _Cursor:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class _Db:
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if "FROM room_event" in sql:
            return _Cursor((ROOM, 1, "message.added"))
        return _Cursor((0,))


class _Claims:
    def __init__(self):
        self.codes = []

    def complete_business(self, _db, _claim, code):
        self.codes.append(code)


class AnalyticsHandlerTests(unittest.TestCase):
    def job(self, kind="analytics.consume.v1", payload=None):
        return WorkerJob(
            job_id="00000000-0000-4000-8000-000000000201", job_type=kind,
            room_id=ROOM, source_event_id=EVENT,
            dedupe_key=f"{kind}:{ROOM}:1", payload=payload or {"eventId": EVENT, "roomSeq": 1},
            attempts=1, correlation_id="00000000-0000-4000-8000-000000000301",
            locked_by="worker-a", claim_generation="1", claim_token="00000000-0000-4000-8000-000000000401",
        )

    def test_consume_runs_deterministic_materialization_before_receipt(self):
        db, claims = _Db(), _Claims()
        deps = SimpleNamespace(db=db, claim=SimpleNamespace(as_job_claim=lambda: object()), job_claims=claims,
                               projection_store=SimpleNamespace(checkpoint=lambda _room: 0))
        with patch("learning_orbit_worker.analytics_handlers._materialize") as materialize:
            result = analytics_consume_handler(deps, self.job())
        self.assertIs(result, HandlerOutcome.SUCCESS)
        materialize.assert_called_once_with(deps, ROOM, 1, unittest.mock.ANY)
        self.assertEqual(claims.codes, ["ANALYTICS_CONSUMED"])

    def test_replay_uses_same_materializer_and_is_idempotent_at_claim_boundary(self):
        db, claims = _Db(), _Claims()
        deps = SimpleNamespace(db=db, claim=SimpleNamespace(as_job_claim=lambda: object()), job_claims=claims,
                               projection_store=SimpleNamespace(checkpoint=lambda _room: 1))
        job = self.job("analytics.replay-room.v1", {"reason": "late_event", "requestedThroughRoomSeq": 1})
        with patch("learning_orbit_worker.analytics_handlers._materialize") as materialize:
            result = analytics_replay_handler(deps, job)
        self.assertIs(result, HandlerOutcome.SUCCESS)
        materialize.assert_called_once_with(deps, ROOM, 1, unittest.mock.ANY)
        self.assertEqual(claims.codes, ["ANALYTICS_REPLAYED"])

    def test_consume_rejects_cross_room_event_before_materialization(self):
        db, claims = _Db(), _Claims()
        db.execute = lambda _sql, _params=(): _Cursor(("another-room", 1, "message.added"))
        deps = SimpleNamespace(db=db, claim=SimpleNamespace(as_job_claim=lambda: object()), job_claims=claims,
                               projection_store=SimpleNamespace(checkpoint=lambda _room: 0))
        with self.assertRaisesRegex(ValueError, "ANALYTICS_EVENT_NOT_FOUND"):
            analytics_consume_handler(deps, self.job())
        self.assertEqual(claims.codes, [])


if __name__ == "__main__":
    unittest.main()
