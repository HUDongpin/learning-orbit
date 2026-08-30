import unittest

from learning_orbit_worker.echo_adapter import project_echo_snapshot


class EchoAdapterTests(unittest.TestCase):
    def test_empty_promoted_student_projection_is_approved_not_unreviewed(self):
        projections = project_echo_snapshot(
            {"nodes": [], "edges": []},
            {
                "roomId": "00000000-0000-4000-8000-000000000010",
                "analysisEpoch": "00000000-0000-4000-8000-000000000901",
                "algorithmVersion": "echo-v1",
                "parameterHash": "b" * 64,
                "projectionVersion": 1,
                "baseVersion": 0,
                "completeThroughRoomSeq": 0,
                "watermarkEventTime": "2026-08-31T01:00:00Z",
                "requiresReplay": False,
                "warnings": [],
            },
            {},
        )
        self.assertEqual(projections["student"]["projectionKey"], "echo.student_approved")
        self.assertEqual(projections["student"]["reviewStatus"], "approved")
        self.assertEqual(projections["student"]["displayStatus"], "student_approved")
        self.assertEqual(projections["student"]["payload"], {"nodes": [], "edges": []})


if __name__ == "__main__":
    unittest.main()
