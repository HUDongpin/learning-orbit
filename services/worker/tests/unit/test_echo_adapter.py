import unittest

from learning_orbit_worker.echo_adapter import (
    diff_echo_snapshots,
    echo_wire_edge_id,
    project_echo_snapshot,
)
from learning_orbit_worker.projection_store import (
    _content_hash,
    _existing_snapshot_matches,
    _validate_patch,
)


ROOM_ID = "00000000-0000-4000-8000-000000000010"
EPOCH = "00000000-0000-4000-8000-000000000901"
EVENT_ID = "00000000-0000-4000-8000-000000000101"


def metadata(version: int = 1) -> dict:
    return {
        "roomId": ROOM_ID,
        "analysisEpoch": EPOCH,
        "algorithmVersion": "echo-v1",
        "parameterHash": "b" * 64,
        "projectionVersion": version,
        "baseVersion": version - 1,
        "completeThroughRoomSeq": version,
        "watermarkEventTime": "2026-08-31T01:00:00Z",
        "requiresReplay": False,
        "warnings": [],
        "reasonCodes": ["event_applied"],
    }


class EchoAdapterTests(unittest.TestCase):
    def test_empty_promoted_student_projection_remains_unreviewed(self):
        projections = project_echo_snapshot(
            {"nodes": [], "edges": []},
            metadata(),
            {},
        )
        self.assertEqual(projections["student"]["projectionKey"], "echo.student_approved")
        self.assertEqual(projections["student"]["reviewStatus"], "unreviewed")
        self.assertEqual(projections["student"]["displayStatus"], "student_approved")
        self.assertEqual(projections["student"]["payload"], {"nodes": [], "edges": []})

    def test_student_projection_and_patch_strip_teacher_evidence_and_weights(self):
        internal_edge = {
            "head": "sun",
            "predicate": "supports",
            "tail": "producer",
            "relationFamily": "evidence",
            "status": "supported",
            "channels": {"support": 1.0, "challenge": 0.0, "uncertain": 0.0, "question": 0.0},
            "evidenceIds": ["evidence-1"],
        }
        internal = {
            "nodes": [
                {"nodeId": "sun", "label": "太陽", "x": -0.5, "y": 0.0},
                {"nodeId": "producer", "label": "生產者", "x": 0.5, "y": 0.0},
            ],
            "edges": [internal_edge],
        }
        edge_id = echo_wire_edge_id(ROOM_ID, internal_edge)
        projections = project_echo_snapshot(
            internal,
            metadata(),
            {"evidence-1": {"eventId": EVENT_ID, "start": 0, "end": 2}},
            approved_edge_ids={edge_id},
        )
        teacher_edge = projections["teacher"]["payload"]["edges"][0]
        student_edge = projections["student"]["payload"]["edges"][0]
        self.assertEqual(
            set(teacher_edge),
            {
                "edgeId", "head", "predicate", "tail", "relationFamily",
                "evidenceStatus", "reviewStatus", "displayStatus", "channels",
                "activityScore", "evidenceRefs",
            },
        )
        self.assertEqual(
            set(student_edge),
            {
                "edgeId", "head", "predicate", "tail", "relationFamily",
                "evidenceStatus", "reviewStatus", "displayStatus",
            },
        )
        self.assertEqual(projections["student"]["reviewStatus"], "approved")

        student_at_version_two = {**projections["student"], **metadata(2)}
        patch = diff_echo_snapshots(
            {"payload": {"nodes": [], "edges": []}},
            student_at_version_two,
            metadata(2),
        )
        self.assertNotIn("evidenceRefs", patch)
        self.assertNotIn("evidenceRefs", patch["edgesAdded"][0])
        self.assertNotIn("channels", patch["edgesAdded"][0])
        self.assertNotIn("activityScore", patch["edgesAdded"][0])
        _validate_patch(student_at_version_two, patch, _content_hash(patch))
        invalid_warning = {**patch, "warnings": ["w" * 161]}
        with self.assertRaisesRegex(ValueError, "INVALID_PROJECTION_PATCH"):
            _validate_patch(student_at_version_two, invalid_warning, _content_hash(invalid_warning))

    def test_snapshot_retry_identity_includes_persisted_warning_bytes(self):
        snapshot = project_echo_snapshot(
            {"nodes": [], "edges": []},
            {**metadata(), "warnings": ["client_time_future_clamped"]},
            {},
        )["teacher"]
        payload_hash = _content_hash(snapshot["payload"])
        row = {
            "snapshot_id": "00000000-0000-4000-8000-000000000801",
            "room_id": snapshot["roomId"],
            "projection_key": snapshot["projectionKey"],
            "analysis_epoch": snapshot["analysisEpoch"],
            "version": snapshot["projectionVersion"],
            "complete_through_seq": snapshot["completeThroughRoomSeq"],
            "watermark_event_time": snapshot["watermarkEventTime"],
            "requires_replay": snapshot["requiresReplay"],
            "algorithm_version": snapshot["algorithmVersion"],
            "parameter_hash": snapshot["parameterHash"],
            "warnings": snapshot["warnings"],
            "warnings_sha256": _content_hash(snapshot["warnings"]),
            "payload": snapshot["payload"],
            "content_sha256": payload_hash,
        }
        self.assertTrue(_existing_snapshot_matches(row, snapshot, payload_hash))
        self.assertFalse(_existing_snapshot_matches(
            {**row, "warnings": ["different_warning"]}, snapshot, payload_hash,
        ))
        self.assertFalse(_existing_snapshot_matches(
            {**row, "warnings_sha256": "0" * 64}, snapshot, payload_hash,
        ))


if __name__ == "__main__":
    unittest.main()
