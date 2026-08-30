"""Synthetic PostgreSQL acceptance for the analytics worker spine.

The test is intentionally opt-in: it needs the local test database and an
explicit pseudonym key.  It never contacts a provider and only writes rows
under a freshly generated room that is removed in ``finally``.
"""
from __future__ import annotations

import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

from jsonschema import Draft202012Validator

try:
    import psycopg
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover - the dependency is optional locally
    psycopg = None
    Jsonb = None

from learning_orbit_worker.analytics_handlers import (
    analytics_consume_handler,
    analytics_replay_handler,
)
from learning_orbit_worker.handler_registry import WorkerDeps, run_with_lease
from learning_orbit_worker.jobs import JobStore
from learning_orbit_worker.projection_store import ProjectionStore
from learning_orbit_worker.replay_jobs import enqueue_analytics_replay


DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
PSEUDONYM_KEY = os.environ.get("LO_ANALYTICS_PSEUDONYM_KEY")


@unittest.skipUnless(
    psycopg is not None and DATABASE_URL and PSEUDONYM_KEY and len(PSEUDONYM_KEY) >= 16,
    "TEST_DATABASE_URL and a 16+ byte LO_ANALYTICS_PSEUDONYM_KEY are required",
)
class AnalyticsPostgresIntegrationTests(unittest.TestCase):
    def test_consume_patch_replay_and_heads_are_materialized_atomically(self):
        assert psycopg is not None and DATABASE_URL is not None
        connection = psycopg.connect(DATABASE_URL, autocommit=False)
        room_id = uuid.uuid4()
        teacher_id = uuid.uuid4()
        nova_id = uuid.uuid4()
        actors = [uuid.uuid4() for _ in range(4)]
        worker_id = f"analytics-integration-{room_id}"
        room_events: list[uuid.UUID] = []
        now = datetime(2026, 8, 30, 12, 0, tzinfo=timezone.utc)
        try:
            policy = connection.execute(
                "SELECT policy_id FROM pilot_retention_policy "
                "WHERE approved_at <= now() AND expires_at > now() "
                "ORDER BY approved_at DESC LIMIT 1"
            ).fetchone()
            if not policy:
                self.skipTest("test database has no approved retention policy")
            policy_id = policy[0]
            connection.execute(
                "INSERT INTO teacher_account(teacher_id,email) VALUES(%s,%s)",
                (teacher_id, f"{teacher_id}@example.test"),
            )
            connection.execute(
                "INSERT INTO classroom_room(room_id,room_code_hash,nova_actor_id,teacher_id,topic,status,retention_policy_id,next_room_seq) "
                "VALUES(%s,decode(%s,'hex'),%s,%s,%s,'open',%s,1)",
                (room_id, uuid.uuid4().hex, nova_id, teacher_id, "生態系統", policy_id),
            )
            for seat, actor_id in enumerate(actors, start=1):
                connection.execute(
                    "INSERT INTO room_member(room_member_id,actor_id,room_id,seat_index,pseudonym,code_hash) "
                    "VALUES(%s,%s,%s,%s,%s,decode(%s,'hex'))",
                    (uuid.uuid4(), actor_id, room_id, seat,
                     f"探索者 {chr(64 + seat)}", uuid.uuid4().hex),
                )

            def append_event(seq: int, actor_id: uuid.UUID, text: str) -> uuid.UUID:
                event_id = uuid.uuid4()
                correlation_id = uuid.uuid4()
                message_id = uuid.uuid4()
                event_time = now + timedelta(seconds=seq)
                payload = {
                    "messageId": str(message_id), "text": text,
                    "replyTo": None, "mentions": [], "mediaIds": [],
                }
                connection.execute(
                    "INSERT INTO room_event(event_id,room_id,room_seq,schema_version,type,actor_id,actor_kind,actor_role,revision,operation,event_time,ingest_time,causation_id,correlation_id,payload) "
                    "VALUES(%s,%s,%s,1,'message.added',%s,'human','student',1,'add',%s,%s,%s,%s,%s)",
                    (event_id, room_id, seq, actor_id, event_time, event_time,
                     event_id, correlation_id, Jsonb(payload)),
                )
                connection.execute(
                    "INSERT INTO worker_job(job_type,room_id,source_event_id,dedupe_key,correlation_id,payload,analytics_order_seq,analytics_order_kind) "
                    "VALUES('analytics.consume.v1',%s,%s,%s,%s,%s,%s,0)",
                    (room_id, event_id, f"analytics.consume.v1:{room_id}:{seq}",
                     correlation_id, Jsonb({"eventId": str(event_id), "roomSeq": seq,
                                           "eventType": "message.added"}), seq),
                )
                room_events.append(event_id)
                return event_id

            store = JobStore(connection, worker_id)
            deps = WorkerDeps(connection, store, projection_store=ProjectionStore(connection))
            append_event(1, actors[0], "太陽提供能量給生產者。")
            connection.commit()
            first = store.claim(1)
            self.assertEqual(len(first), 1)
            self.assertEqual(run_with_lease(first[0], analytics_consume_handler, deps).value, "success")

            append_event(2, actors[1], "分解者讓物質回到土壤。")
            connection.commit()
            second = store.claim(1)
            self.assertEqual(len(second), 1)
            self.assertEqual(run_with_lease(second[0], analytics_consume_handler, deps).value, "success")

            self.assertEqual(
                connection.execute("SELECT count(*) FROM analysis_room_heads WHERE room_id=%s", (room_id,)).fetchone()[0],
                4,
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM analysis_projection_snapshots WHERE room_id=%s", (room_id,)).fetchone()[0],
                8,
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM analysis_projection_patches WHERE room_id=%s", (room_id,)).fetchone()[0],
                4,
            )
            # Validate the exact nested wire branches before the fixture is
            # cleaned up.  The worker's outer envelope parser alone would not
            # catch an Agent/ROOM node accidentally entering the student TRACE
            # branch, or a malformed ECHO edge/evidence span.
            schema_root = Path(__file__).parents[3] / "packages" / "contracts" / "schemas"
            echo_validator = Draft202012Validator(json.loads((schema_root / "echo-concept-projection.v1.json").read_text()))
            trace_validator = Draft202012Validator(json.loads((schema_root / "trace-projection.v1.json").read_text()))
            projection_rows = connection.execute(
                "SELECT room_id,projection_key,analysis_epoch,version,complete_through_seq,"
                "watermark_event_time,requires_replay,algorithm_version,parameter_hash,payload "
                "FROM analysis_projection_snapshots WHERE room_id=%s",
                (room_id,),
            ).fetchall()
            for row in projection_rows:
                envelope = {
                    "schemaVersion": 1,
                    "roomId": str(row[0]),
                    "projectionKey": row[1],
                    "analysisEpoch": str(row[2]),
                    "algorithmVersion": row[7],
                    "parameterHash": row[8],
                    "projectionVersion": int(row[3]),
                    "baseVersion": int(row[3]) - 1,
                    "completeThroughRoomSeq": int(row[4]),
                    "watermarkEventTime": row[5].isoformat().replace("+00:00", "Z"),
                    "requiresReplay": row[6],
                    "evidenceStatus": "requires_replay" if row[6] else "active",
                    "reviewStatus": "approved" if row[1] == "trace.student_bundle" else "unreviewed",
                    "displayStatus": "student_approved" if row[1] == "echo.student_approved" else "student_aggregate" if row[1] == "trace.student_bundle" else "teacher_shadow",
                    "warnings": [],
                    "payload": row[9],
                }
                if row[1].startswith("echo."):
                    echo_validator.validate(envelope)
                else:
                    trace_validator.validate(envelope)
            patch_rows = connection.execute(
                "SELECT projection_key,version,base_version,payload->>'requiresReplay' FROM analysis_projection_patches "
                "WHERE room_id=%s ORDER BY projection_key,version",
                (room_id,),
            ).fetchall()
            self.assertEqual(patch_rows, [
                ("echo.student_approved", 1, 0, "false"),
                ("echo.student_approved", 2, 1, "false"),
                ("echo.teacher_shadow", 1, 0, "false"),
                ("echo.teacher_shadow", 2, 1, "false"),
            ])
            self.assertEqual(
                connection.execute(
                    "SELECT last_room_seq FROM analysis_consumer_checkpoints "
                    "WHERE room_id=%s AND consumer_name='analytics'", (room_id,)
                ).fetchone()[0],
                2,
            )

            replay_correlation = uuid.uuid4()
            replay_id = enqueue_analytics_replay(
                connection, room_id=str(room_id), source_event_id=None,
                requested_through_room_seq=2, reason="operator_rebuild",
                dedupe_token=str(uuid.uuid4()), correlation_id=str(replay_correlation),
            )
            connection.commit()
            replay = store.claim(1)
            self.assertEqual(len(replay), 1)
            self.assertEqual(run_with_lease(replay[0], analytics_replay_handler, deps).value, "success")

            self.assertEqual(
                connection.execute("SELECT count(*) FROM analysis_room_heads WHERE room_id=%s", (room_id,)).fetchone()[0],
                4,
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM analysis_projection_snapshots WHERE room_id=%s", (room_id,)).fetchone()[0],
                12,
            )
            self.assertEqual(
                connection.execute("SELECT count(DISTINCT analysis_epoch) FROM analysis_projection_snapshots WHERE room_id=%s", (room_id,)).fetchone()[0],
                2,
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM analysis_projection_outbox WHERE room_id=%s", (room_id,)).fetchone()[0],
                12,
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM worker_job WHERE room_id=%s AND status='succeeded'", (room_id,)).fetchone()[0],
                3,
            )
            # A normal consume after replay must continue the installed replay
            # epoch rather than silently reverting to the room's initial UUID.
            replay_epoch = connection.execute(
                "SELECT analysis_epoch FROM analysis_room_heads WHERE room_id=%s AND projection_key='echo.teacher_shadow'",
                (room_id,),
            ).fetchone()[0]
            append_event(3, actors[2], "能量沿食物鏈傳遞給消費者。")
            connection.commit()
            third = store.claim(1)
            self.assertEqual(len(third), 1)
            self.assertEqual(run_with_lease(third[0], analytics_consume_handler, deps).value, "success")
            epochs = connection.execute(
                "SELECT DISTINCT analysis_epoch FROM analysis_room_heads WHERE room_id=%s",
                (room_id,),
            ).fetchall()
            self.assertEqual({row[0] for row in epochs}, {replay_epoch})
            self.assertEqual(
                connection.execute("SELECT max(version) FROM analysis_room_heads WHERE room_id=%s", (room_id,)).fetchone()[0],
                2,
            )
        finally:
            connection.rollback()
            connection.execute("DELETE FROM classroom_room WHERE room_id=%s", (room_id,))
            connection.execute("DELETE FROM teacher_account WHERE teacher_id=%s", (teacher_id,))
            connection.commit()
            connection.close()


if __name__ == "__main__":
    unittest.main()
