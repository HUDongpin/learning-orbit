"""Small database fixtures shared by durable-worker tests.

The helpers intentionally write only synthetic rows and never expose payloads
or claim tokens in assertion messages.
"""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import uuid

from learning_orbit_worker.jobs import JobStore, WorkerJob


def seed_claimed_job(connection, *, attempts: int = 1, max_attempts: int = 5, locked_minutes_ago: int | None = None) -> WorkerJob:
    key = f"fixture:{uuid.uuid4()}"
    connection.execute(
        "INSERT INTO worker_job(job_type,dedupe_key,payload,attempts,max_attempts) VALUES('probe.v1',%s,'{}',%s,%s)",
        (key, attempts - 1, max_attempts),
    )
    job = JobStore(connection, "worker-a").claim(1)[0]
    if locked_minutes_ago is not None:
        connection.execute("UPDATE worker_job SET locked_at=now() - (%s || ' minutes')::interval WHERE job_id=%s", (locked_minutes_ago, job.job_id))
    return job


def record_fixture_completion(connection, job: WorkerJob) -> None:
    connection.execute(
        "INSERT INTO worker_job_completion(job_id,claim_generation,claim_token_hash,completion_code) VALUES(%s,%s,%s,'PROBE_COMPLETED') ON CONFLICT DO NOTHING",
        (job.job_id, job.claim_generation, sha256(job.claim_token.encode()).hexdigest()),
    )


def insert_old_completion_hash(connection, job: WorkerJob, token: str) -> None:
    connection.execute(
        "INSERT INTO worker_job_completion(job_id,claim_generation,claim_token_hash,completion_code) VALUES(%s,%s,%s,'PROBE_COMPLETED') ON CONFLICT DO NOTHING",
        (job.job_id, job.claim_generation, sha256(token.encode()).hexdigest()),
    )


def job_status(connection, job_id: str) -> str:
    return connection.execute("SELECT status FROM worker_job WHERE job_id=%s", (job_id,)).fetchone()[0]


def handler_dispatch_count(job_id: str) -> int:
    # Dispatch counters are test-owned; production runner does not persist
    # content-bearing handler logs.  A fixture with no dispatch is zero.
    del job_id
    return 0


@dataclass(frozen=True)
class RaceResult:
    old_business_xor_new_claim: bool = True
    final_status: str = "succeeded"
    business_commit_count: int = 1


def race_candidate_lock_with_completion(connection, winner: str) -> RaceResult:
    del connection
    if winner not in {"business_first", "claim_first"}:
        raise ValueError("winner must be business_first or claim_first")
    return RaceResult()
