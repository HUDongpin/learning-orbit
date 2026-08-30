"""Synthetic PostgreSQL lifecycle-saga acceptance tests."""
from __future__ import annotations

import os
import unittest
import uuid

try:
    import psycopg
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover
    psycopg = None
    Jsonb = None

from learning_orbit_worker.core_handlers import RetryableJobError
from learning_orbit_worker.handler_registry import WorkerClaim, WorkerDeps
from learning_orbit_worker.jobs import JobStore
from learning_orbit_worker.lifecycle import DELETE_ORDER, delete_surface_handler


DATABASE_URL = os.environ.get("TEST_DATABASE_URL")


@unittest.skipUnless(psycopg is not None and DATABASE_URL, "TEST_DATABASE_URL is required")
class LifecyclePostgresIntegrationTests(unittest.TestCase):
    def test_zero_surface_completion_and_failure_status_projection(self):
        assert psycopg is not None and DATABASE_URL is not None
        conn = psycopg.connect(DATABASE_URL, autocommit=False)
        room = uuid.uuid4()
        teacher = uuid.uuid4()
        nova = uuid.uuid4()
        deletion = uuid.uuid4()
        correlation = uuid.uuid4()
        worker_id = f"lifecycle-integration-{room}"
        try:
            policy = conn.execute(
                "SELECT policy_id FROM pilot_retention_policy "
                "WHERE policy_version='pilot-default-v1'"
            ).fetchone()
            if not policy:
                self.skipTest("test database has no approved retention policy")
            conn.execute(
                "INSERT INTO teacher_account(teacher_id,email) VALUES(%s,%s)",
                (teacher, f"{teacher}@lifecycle.test"),
            )
            conn.execute(
                """INSERT INTO classroom_room(
                     room_id,room_code_hash,nova_actor_id,teacher_id,topic,status,
                     retention_policy_id,next_room_seq
                   ) VALUES(%s,decode(%s,'hex'),%s,%s,'合成','open',%s,1)""",
                (room, uuid.uuid4().hex, nova, teacher, policy[0]),
            )
            conn.execute(
                """INSERT INTO deletion_job(
                     deletion_job_id,correlation_id,room_id,room_ref_sha256,
                     request_kind,status,owner_teacher_id,requested_by_teacher_id
                   ) VALUES(%s,%s,%s,%s,'teacher','queued',%s,%s)""",
                (deletion, correlation, room, "a" * 64, teacher, teacher),
            )
            for surface in (
                "events", "media", "derivatives", "artifacts", "projections",
                "agent_runs", "caches", "provider_copies",
            ):
                conn.execute(
                    """INSERT INTO deletion_surface_manifest(
                         deletion_job_id,surface,expected_item_count,status,frozen_at
                       ) VALUES(%s,%s,0,'frozen',now())""",
                    (deletion, surface),
                )
            for surface in DELETE_ORDER:
                job_id = uuid.uuid4()
                conn.execute(
                    """INSERT INTO worker_job(
                         job_id,job_type,room_id,source_event_id,dedupe_key,
                         correlation_id,payload
                       ) VALUES(%s,'room.delete-surface.v1',NULL,NULL,%s,%s,%s)""",
                    (
                        job_id,
                        f"room.delete-surface.v1:{deletion}:{surface}",
                        correlation,
                        Jsonb({"deletionJobId": str(deletion), "surface": surface}),
                    ),
                )
            conn.commit()

            store = JobStore(conn, worker_id)
            base = WorkerDeps(conn, store)
            completed_surfaces: set[str] = set()
            for surface in DELETE_ORDER:
                # Keep this acceptance deterministic while the production
                # claim query remains free to retry out-of-order surfaces.
                conn.execute(
                    """UPDATE worker_job SET run_after=now()+interval '1 day'
                        WHERE job_type='room.delete-surface.v1'
                          AND payload->>'deletionJobId'=%s""",
                    (str(deletion),),
                )
                conn.execute(
                    """UPDATE worker_job SET run_after=now()
                        WHERE job_type='room.delete-surface.v1'
                          AND payload->>'deletionJobId'=%s
                          AND payload->>'surface'=%s""",
                    (str(deletion), surface),
                )
                conn.commit()
                claimed = store.claim(1)
                self.assertEqual(len(claimed), 1)
                job = claimed[0]
                deps = base.for_attempt(WorkerClaim.from_job(job))
                self.assertEqual(str(job.payload["surface"]), surface)
                delete_surface_handler(deps, job)
                store.succeed(job)
                completed_surfaces.add(surface)
            self.assertEqual(completed_surfaces, set(DELETE_ORDER))

            deletion_row = conn.execute(
                "SELECT status,room_id FROM deletion_job WHERE deletion_job_id=%s",
                (deletion,),
            ).fetchone()
            receipt = conn.execute(
                "SELECT receipt_version,surfaces_verified FROM deletion_receipt WHERE deletion_job_id=%s",
                (deletion,),
            ).fetchone()
            self.assertEqual(deletion_row, ("completed", None))
            self.assertEqual(receipt[0], 1)
            self.assertEqual(len(receipt[1]), 8)
            self.assertIsNone(conn.execute(
                "SELECT 1 FROM classroom_room WHERE room_id=%s", (room,)
            ).fetchone())
        finally:
            conn.rollback()
            conn.execute(
                "DELETE FROM worker_job WHERE job_type='room.delete-surface.v1' AND payload->>'deletionJobId'=%s",
                (str(deletion),),
            )
            conn.execute("DELETE FROM deletion_job WHERE deletion_job_id=%s", (deletion,))
            conn.execute("DELETE FROM classroom_room WHERE room_id=%s", (room,))
            conn.execute("DELETE FROM teacher_account WHERE teacher_id=%s", (teacher,))
            conn.commit()
            conn.close()

    def test_media_capability_failure_escalates_parent_status(self):
        assert psycopg is not None and DATABASE_URL is not None
        conn = psycopg.connect(DATABASE_URL, autocommit=False)
        room = uuid.uuid4()
        teacher = uuid.uuid4()
        nova = uuid.uuid4()
        deletion = uuid.uuid4()
        correlation = uuid.uuid4()
        worker_id = f"lifecycle-failure-{room}"
        try:
            policy = conn.execute(
                "SELECT policy_id FROM pilot_retention_policy "
                "WHERE policy_version='pilot-default-v1'"
            ).fetchone()
            if not policy:
                self.skipTest("test database has no approved retention policy")
            conn.execute(
                "INSERT INTO teacher_account(teacher_id,email) VALUES(%s,%s)",
                (teacher, f"{teacher}@lifecycle-failure.test"),
            )
            conn.execute(
                """INSERT INTO classroom_room(
                     room_id,room_code_hash,nova_actor_id,teacher_id,topic,status,
                     retention_policy_id,next_room_seq
                   ) VALUES(%s,decode(%s,'hex'),%s,%s,'合成','open',%s,1)""",
                (room, uuid.uuid4().hex, nova, teacher, policy[0]),
            )
            conn.execute(
                """INSERT INTO deletion_job(
                     deletion_job_id,correlation_id,room_id,room_ref_sha256,
                     request_kind,status,owner_teacher_id,requested_by_teacher_id
                   ) VALUES(%s,%s,%s,%s,'teacher','queued',%s,%s)""",
                (deletion, correlation, room, "b" * 64, teacher, teacher),
            )
            for surface in (
                "events", "media", "derivatives", "artifacts", "projections",
                "agent_runs", "caches", "provider_copies",
            ):
                conn.execute(
                    """INSERT INTO deletion_surface_manifest(
                         deletion_job_id,surface,expected_item_count,status,frozen_at
                       ) VALUES(%s,%s,%s,'frozen',now())""",
                    (deletion, surface, 1 if surface == "media" else 0),
                )
            # Isolate the media capability branch; its dependency surface is
            # already proven in this focused failure fixture.
            conn.execute(
                "UPDATE deletion_surface_manifest SET status='verified',verified_at=now() WHERE deletion_job_id=%s AND surface='provider_copies'",
                (deletion,),
            )
            job_id = uuid.uuid4()
            conn.execute(
                """INSERT INTO worker_job(
                     job_id,job_type,room_id,source_event_id,dedupe_key,
                     correlation_id,payload,max_attempts
                   ) VALUES(%s,'room.delete-surface.v1',NULL,NULL,%s,%s,%s,2)""",
                (
                    job_id,
                    f"room.delete-surface.v1:{deletion}:media",
                    correlation,
                    Jsonb({"deletionJobId": str(deletion), "surface": "media"}),
                ),
            )
            conn.commit()
            store = JobStore(conn, worker_id)
            job = store.claim(1)[0]
            deps = WorkerDeps(conn, store).for_attempt(WorkerClaim.from_job(job))
            with self.assertRaises(RetryableJobError) as raised:
                delete_surface_handler(deps, job)
            store.fail(job, raised.exception)
            self.assertEqual(
                conn.execute(
                    "SELECT status FROM deletion_job WHERE deletion_job_id=%s", (deletion,)
                ).fetchone()[0],
                "retryable",
            )
            self.assertEqual(
                conn.execute("SELECT status,last_error FROM worker_job WHERE job_id=%s", (job_id,)).fetchone(),
                ("retryable", "MEDIA_PROVIDER_DEPENDENCY_PENDING"),
            )
        finally:
            conn.rollback()
            conn.execute(
                "DELETE FROM worker_job WHERE job_type='room.delete-surface.v1' AND payload->>'deletionJobId'=%s",
                (str(deletion),),
            )
            conn.execute("DELETE FROM deletion_job WHERE deletion_job_id=%s", (deletion,))
            conn.execute("DELETE FROM classroom_room WHERE room_id=%s", (room,))
            conn.execute("DELETE FROM teacher_account WHERE teacher_id=%s", (teacher,))
            conn.commit()
            conn.close()

    def test_stale_max_attempt_lifecycle_claim_escalates_parent_status(self):
        assert psycopg is not None and DATABASE_URL is not None
        conn = psycopg.connect(DATABASE_URL, autocommit=False)
        room = uuid.uuid4()
        teacher = uuid.uuid4()
        nova = uuid.uuid4()
        deletion = uuid.uuid4()
        correlation = uuid.uuid4()
        worker_id = f"lifecycle-stale-{room}"
        try:
            policy = conn.execute(
                "SELECT policy_id FROM pilot_retention_policy "
                "WHERE policy_version='pilot-default-v1'"
            ).fetchone()
            if not policy:
                self.skipTest("test database has no approved retention policy")
            conn.execute(
                "INSERT INTO teacher_account(teacher_id,email) VALUES(%s,%s)",
                (teacher, f"{teacher}@lifecycle-stale.test"),
            )
            conn.execute(
                """INSERT INTO classroom_room(
                     room_id,room_code_hash,nova_actor_id,teacher_id,topic,status,
                     retention_policy_id,next_room_seq
                   ) VALUES(%s,decode(%s,'hex'),%s,%s,'合成','open',%s,1)""",
                (room, uuid.uuid4().hex, nova, teacher, policy[0]),
            )
            conn.execute(
                """INSERT INTO deletion_job(
                     deletion_job_id,correlation_id,room_id,room_ref_sha256,
                     request_kind,status,owner_teacher_id,requested_by_teacher_id
                   ) VALUES(%s,%s,%s,%s,'teacher','running',%s,%s)""",
                (deletion, correlation, room, "c" * 64, teacher, teacher),
            )
            for surface in (
                "events", "media", "derivatives", "artifacts", "projections",
                "agent_runs", "caches", "provider_copies",
            ):
                conn.execute(
                    """INSERT INTO deletion_surface_manifest(
                         deletion_job_id,surface,expected_item_count,status,frozen_at
                       ) VALUES(%s,%s,0,'frozen',now())""",
                    (deletion, surface),
                )
            job_id = uuid.uuid4()
            conn.execute(
                """INSERT INTO worker_job(
                     job_id,job_type,room_id,source_event_id,dedupe_key,
                     correlation_id,payload,status,attempts,max_attempts,
                     claim_generation,claim_token,locked_at,locked_by
                   ) VALUES(%s,'room.delete-surface.v1',NULL,NULL,%s,%s,%s,
                            'running',1,1,1,gen_random_uuid(),now()-interval '3 minutes',%s)""",
                (
                    job_id,
                    f"room.delete-surface.v1:{deletion}:events",
                    correlation,
                    Jsonb({"deletionJobId": str(deletion), "surface": "events"}),
                    worker_id,
                ),
            )
            conn.commit()
            store = JobStore(conn, worker_id)
            self.assertEqual(store.claim(1), [])
            self.assertEqual(
                conn.execute(
                    "SELECT status FROM worker_job WHERE job_id=%s", (job_id,)
                ).fetchone()[0],
                "dead",
            )
            self.assertEqual(
                conn.execute(
                    "SELECT status FROM deletion_job WHERE deletion_job_id=%s", (deletion,)
                ).fetchone()[0],
                "dead",
            )
        finally:
            conn.rollback()
            conn.execute(
                "DELETE FROM worker_job WHERE job_type='room.delete-surface.v1' AND payload->>'deletionJobId'=%s",
                (str(deletion),),
            )
            conn.execute("DELETE FROM deletion_job WHERE deletion_job_id=%s", (deletion,))
            conn.execute("DELETE FROM classroom_room WHERE room_id=%s", (room,))
            conn.execute("DELETE FROM teacher_account WHERE teacher_id=%s", (teacher,))
            conn.commit()
            conn.close()


if __name__ == "__main__":
    unittest.main()
