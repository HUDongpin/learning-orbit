import os
import unittest
import uuid

try:
    import psycopg
except ImportError:  # pragma: no cover
    psycopg = None

from learning_orbit_worker.jobs import CompletionMissing, JobStore


@unittest.skipUnless(psycopg and os.environ.get("TEST_DATABASE_URL"), "TEST_DATABASE_URL not configured")
class JobStoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = psycopg.connect(os.environ["TEST_DATABASE_URL"], autocommit=True)
    @classmethod
    def tearDownClass(cls):
        cls.db.execute("TRUNCATE worker_job_completion, worker_job CASCADE")
        cls.db.close()
    def setUp(self):
        self.db.execute("TRUNCATE worker_job_completion, worker_job CASCADE")
    def test_claim_success_and_receipt(self):
        key = f"probe:{uuid.uuid4()}"
        self.db.execute("INSERT INTO worker_job(job_type,dedupe_key,payload) VALUES('probe.v1',%s,'{}')", (key,))
        store = JobStore(self.db, "worker-a")
        job = store.claim(1)[0]
        self.assertEqual(job.claim_generation, "1")
        with self.assertRaises(CompletionMissing): store.succeed(job)
        self.db.execute("INSERT INTO worker_job_completion(job_id,claim_generation,claim_token_hash,completion_code) VALUES(%s,%s,encode(digest(%s::text,'sha256'),'hex'),'PROBE_COMPLETED')", (job.job_id, job.claim_generation, job.claim_token))
        store.succeed(job)
        self.assertEqual(self.db.execute("SELECT status FROM worker_job WHERE job_id=%s", (job.job_id,)).fetchone()[0], "succeeded")

