import unittest
from learning_orbit_worker.handler_registry import HandlerOutcome, WorkerClaim, WorkerDeps
from learning_orbit_worker.jobs import WorkerJob
from learning_orbit_worker.pipeline_handlers import (
    agent_execute_handler, media_process_handler, media_reconcile_upload_handler,
)
from learning_orbit_worker.projection_store import (
    ProjectionStore,
    _compact_patch_payload,
    _content_hash,
    _existing_patch_matches,
)
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

    def test_patch_inherit_metadata_and_hash_are_closed(self):
        store = ProjectionStore(object())
        snapshot = {"roomId": ROOM, "analysisEpoch": ROOM, "projectionKey": "echo.teacher_shadow", "projectionVersion": 1, "baseVersion": 0, "completeThroughRoomSeq": 0, "algorithmVersion": "v1", "parameterHash": "a" * 64, "watermarkEventTime": "2026-08-30T00:00:00Z", "requiresReplay": False, "payload": {}}
        patch = {"analysisEpoch": ROOM, "algorithmVersion": "v1", "parameterHash": "a" * 64, "projectionVersion": 1, "baseVersion": 0, "completeThroughRoomSeq": 0, "requiresReplay": False, "warnings": [], "nodesAdded": [], "nodesUpdated": [], "nodesHidden": [], "edgesAdded": [], "edgesUpdated": [], "edgesHidden": [], "positionUpdates": [], "changeScore": 0.0, "reasonCodes": [], "evidenceRefs": []}
        with self.assertRaises(ValueError): store.persist(snapshot=snapshot, payload_hash="a" * 64, patch={**patch, "roomId": "00000000-0000-4000-8000-000000000099"}, patch_hash="b" * 64)
        with self.assertRaises(ValueError): store.persist(snapshot=snapshot, payload_hash="a" * 64, patch=patch, patch_hash=None)
        with self.assertRaises(ValueError): store.persist(snapshot=snapshot, payload_hash="a" * 64, patch={**patch, "changeScore": True}, patch_hash="b" * 64)

        stored_patch = _compact_patch_payload(snapshot["projectionKey"], patch)
        stored_hash = _content_hash(stored_patch)
        row = {
            "room_id": snapshot["roomId"],
            "projection_key": snapshot["projectionKey"],
            "analysis_epoch": patch["analysisEpoch"],
            "version": patch["projectionVersion"],
            "base_version": patch["baseVersion"],
            "complete_through_seq": patch["completeThroughRoomSeq"],
            "algorithm_version": patch["algorithmVersion"],
            "parameter_hash": patch["parameterHash"],
            "payload": stored_patch,
            "content_sha256": stored_hash,
        }
        self.assertTrue(_existing_patch_matches(row, snapshot, patch, stored_patch, stored_hash))
        for field, wrong_value in (
            ("room_id", "00000000-0000-4000-8000-000000000099"),
            ("projection_key", "echo.student_approved"),
            ("analysis_epoch", "00000000-0000-4000-8000-000000000099"),
            ("version", 2),
            ("base_version", 1),
            ("complete_through_seq", 1),
            ("algorithm_version", "v2"),
            ("parameter_hash", "b" * 64),
            ("payload", {**stored_patch, "requiresReplay": True}),
            ("content_sha256", "b" * 64),
        ):
            with self.subTest(field=field):
                self.assertFalse(_existing_patch_matches(
                    {**row, field: wrong_value}, snapshot, patch, stored_patch, stored_hash,
                ))
