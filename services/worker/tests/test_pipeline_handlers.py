import unittest
from learning_orbit_worker.handler_registry import HandlerOutcome, WorkerClaim, WorkerDeps
from learning_orbit_worker.jobs import WorkerJob
from learning_orbit_worker.pipeline_handlers import (
    agent_execute_handler, media_process_handler, media_reconcile_upload_handler,
)
from learning_orbit_worker.projection_store import ProjectionStore
from learning_orbit_worker.core_handlers import RetryableJobError

ROOM = "00000000-0000-4000-8000-000000000001"
CLAIM = WorkerClaim("00000000-0000-4000-8000-000000000002", "media.reconcile-upload.v1", ROOM, None, "media.reconcile-upload.v1:00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004", "1", "00000000-0000-4000-8000-000000000005", "worker")

def job(job_type, payload):
    return WorkerJob(CLAIM.job_id, job_type, ROOM, None, CLAIM.dedupe_key, payload, 1, CLAIM.correlation_id, CLAIM.worker_id, CLAIM.claim_generation, CLAIM.claim_token)

class PipelineHandlerTests(unittest.TestCase):
    def test_missing_capabilities_never_report_success(self):
        deps = WorkerDeps(object(), object(), claim=CLAIM)
        with self.assertRaises(RetryableJobError): media_process_handler(deps, job("media.process.v1", {"mediaId": ROOM}))
        with self.assertRaises(RetryableJobError): media_reconcile_upload_handler(deps, job("media.reconcile-upload.v1", {"mediaId": ROOM}))
        with self.assertRaises(RetryableJobError): agent_execute_handler(deps, job("agent.execute.v1", {}))

    def test_projection_store_rejects_float_and_bad_metadata(self):
        store = ProjectionStore(object())
        snapshot = {"roomId": ROOM, "analysisEpoch": ROOM, "projectionKey": "echo.teacher_shadow", "projectionVersion": 1, "baseVersion": 0, "completeThroughRoomSeq": 0, "algorithmVersion": "v1", "parameterHash": "a" * 64, "watermarkEventTime": "2026-08-30T00:00:00Z", "requiresReplay": False, "payload": {}}
        with self.assertRaises(ValueError): store.persist(snapshot={**snapshot, "projectionVersion": 1.5}, payload_hash="a")
        with self.assertRaises(ValueError): store.persist(snapshot={**snapshot, "roomId": "not-a-uuid"}, payload_hash="a")
        with self.assertRaises(ValueError): store.persist(snapshot=snapshot, payload_hash="a", patch={"projectionVersion": 2, "baseVersion": 0}, patch_hash="b")
