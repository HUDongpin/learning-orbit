import unittest
from dataclasses import replace
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
CORRELATION = "00000000-0000-4000-8000-000000000301"


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
        if "FROM analytics_replay_request" in sql:
            return _Cursor((ROOM, EVENT, "late_event", 1,
                            "analytics.replay-room.v1:" + "a" * 64, CORRELATION))
        if "SELECT room_id FROM room_event" in sql:
            return _Cursor((ROOM,))
        if "FROM room_event" in sql:
            return _Cursor((ROOM, 1, "message.added", CORRELATION))
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
            dedupe_key=("analytics.consume.v1:" + ROOM + ":1") if kind == "analytics.consume.v1"
            else "analytics.replay-room.v1:" + "a" * 64,
            payload=payload or ({"eventId": EVENT, "roomSeq": 1, "eventType": "message.added"}
                                if kind == "analytics.consume.v1"
                                else {"reason": "late_event", "requestedThroughRoomSeq": 1}),
            attempts=1, correlation_id=CORRELATION,
            locked_by="worker-a", claim_generation="1", claim_token="00000000-0000-4000-8000-000000000401",
            analytics_order_seq=1, analytics_order_kind=0 if kind == "analytics.consume.v1" else 1,
        )

    def test_consume_runs_deterministic_materialization_before_receipt(self):
        db, claims = _Db(), _Claims()
        deps = SimpleNamespace(db=db, claim=SimpleNamespace(as_job_claim=lambda: object()), job_claims=claims,
                               projection_store=SimpleNamespace(checkpoint=lambda _room: 0))
        with patch("learning_orbit_worker.analytics_handlers._materialize") as materialize:
            result = analytics_consume_handler(deps, self.job())
        self.assertIs(result, HandlerOutcome.SUCCESS)
        materialize.assert_called_once_with(deps, ROOM, 1, unittest.mock.ANY, enqueue_replay=True)
        self.assertEqual(claims.codes, ["ANALYTICS_CONSUMED"])

    def test_replay_uses_same_materializer_and_is_idempotent_at_claim_boundary(self):
        db, claims = _Db(), _Claims()
        deps = SimpleNamespace(db=db, claim=SimpleNamespace(as_job_claim=lambda: object()), job_claims=claims,
                               projection_store=SimpleNamespace(checkpoint=lambda _room: 1))
        job = self.job("analytics.replay-room.v1", {"reason": "late_event", "requestedThroughRoomSeq": 1})
        with patch("learning_orbit_worker.analytics_handlers._materialize") as materialize:
            result = analytics_replay_handler(deps, job)
        self.assertIs(result, HandlerOutcome.SUCCESS)
        # replaying=True is the only thing that lifts the online lateness gate
        # for the rebuild. Without it a replay reproduces the projection that
        # dropped the late event and then clears the flag anyway.
        materialize.assert_called_once_with(
            deps, ROOM, 1, unittest.mock.ANY, enqueue_replay=False, replaying=True,
        )
        self.assertEqual(claims.codes, ["ANALYTICS_REPLAYED"])

    def test_consume_rejects_cross_room_event_before_materialization(self):
        db, claims = _Db(), _Claims()
        db.execute = lambda _sql, _params=(): _Cursor(("another-room", 1, "message.added", CORRELATION))
        deps = SimpleNamespace(db=db, claim=SimpleNamespace(as_job_claim=lambda: object()), job_claims=claims,
                               projection_store=SimpleNamespace(checkpoint=lambda _room: 0))
        with self.assertRaisesRegex(ValueError, "ANALYTICS_EVENT_NOT_FOUND"):
            analytics_consume_handler(deps, self.job())
        self.assertEqual(claims.codes, [])

    def test_consume_requires_event_type_exact_payload_and_order_tuple(self):
        db, claims = _Db(), _Claims()
        deps = SimpleNamespace(db=db, claim=SimpleNamespace(as_job_claim=lambda: object()), job_claims=claims,
                               projection_store=SimpleNamespace(checkpoint=lambda _room: 0))
        with self.assertRaisesRegex(ValueError, "PAYLOAD"):
            analytics_consume_handler(deps, self.job(payload={"eventId": EVENT, "roomSeq": 1,
                                                              "eventType": "message.added", "extra": True}))
        with self.assertRaisesRegex(ValueError, "EVENT_NOT_FOUND"):
            analytics_consume_handler(deps, self.job(payload={"eventId": EVENT, "roomSeq": 1,
                                                              "eventType": "message.retracted"}))
        with self.assertRaisesRegex(ValueError, "ORDER"):
            analytics_consume_handler(deps, replace(self.job(), analytics_order_kind=1))

    def test_replay_requires_immutable_authority_and_closed_payload(self):
        db, claims = _Db(), _Claims()
        deps = SimpleNamespace(db=db, claim=SimpleNamespace(as_job_claim=lambda: object()), job_claims=claims,
                               projection_store=SimpleNamespace(checkpoint=lambda _room: 1))
        with self.assertRaisesRegex(ValueError, "PAYLOAD"):
            analytics_replay_handler(deps, self.job("analytics.replay-room.v1", {
                "reason": "late_event", "requestedThroughRoomSeq": 1, "extra": True,
            }))
        with self.assertRaisesRegex(ValueError, "ORDER"):
            analytics_replay_handler(deps, replace(self.job("analytics.replay-room.v1"),
                                                   analytics_order_kind=0))


if __name__ == "__main__":
    unittest.main()
