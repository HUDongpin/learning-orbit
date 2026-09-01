import unittest
from datetime import datetime, timezone

from learning_orbit_worker.projector import (
    advance_watermark,
    make_semantic_noop_patch,
    next_patch_metadata,
    project_future_then_normal_fixture,
    sequence_decision,
)


class ProjectionVersionTests(unittest.TestCase):
    def test_patch_is_exact_successor(self):
        self.assertEqual(
            next_patch_metadata(base_version=4),
            {"baseVersion": 4, "projectionVersion": 5},
        )

    def test_room_seq_gap_does_not_advance(self):
        self.assertEqual(sequence_decision(3, 1), "room_seq_gap")
        self.assertEqual(sequence_decision(2, 1), "next")
        self.assertEqual(sequence_decision(1, 1), "duplicate")

    def test_semantic_noop_patch_has_explicit_reason(self):
        patch = make_semantic_noop_patch(
            event_type="room.paused",
            analysis_epoch="00000000-0000-4000-8000-000000000901",
            algorithm_version="echo-cm-reference-v1.1+adapter-v1",
            parameter_hash="b" * 64,
            base_version=4,
            room_seq=9,
        )
        self.assertEqual(patch["projectionVersion"], 5)
        self.assertEqual(patch["completeThroughRoomSeq"], 9)
        self.assertEqual(patch["reasonCodes"], ["semantic_noop:room.paused"])
        self.assertEqual(patch["changeScore"], 0.0)

    def test_future_client_time_is_clamped_before_reference_algorithms(self):
        result = project_future_then_normal_fixture()
        self.assertEqual(result.future_effective_time, result.future_ingest_time)
        self.assertIn("client_time_future_clamped", result.future_warnings)
        self.assertFalse(result.normal_event_marked_late)
        self.assertIn("normal-event", result.final_evidence_ids)

    def test_advance_watermark_marks_old_event_late(self):
        utc = timezone.utc
        result = advance_watermark(
            datetime(2026, 8, 28, 9, 0, 0, tzinfo=utc),
            datetime(2026, 8, 28, 9, 0, 12, tzinfo=utc),
            datetime(2026, 8, 28, 9, 0, 10, tzinfo=utc),
            datetime(2026, 8, 28, 9, 0, 5, tzinfo=utc),
        )
        self.assertTrue(result.too_late)


if __name__ == "__main__":
    unittest.main()
