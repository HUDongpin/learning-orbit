"""A changed reference version must install a new analysis epoch.

``manifest.json`` states that a changed reference hash requires a new reference
version *and* a new analysis epoch.  ``algorithmVersion`` is immutable inside an
epoch, so appending v1.1 snapshots to a chain whose head is v1 would let a
client apply a v1.1 patch onto a v1 snapshot.
"""
import unittest
from uuid import UUID, uuid5

from learning_orbit_worker.analytics_handlers import (
    ANALYSIS_NAMESPACE,
    ECHO_VERSION,
    PARAMETER_HASH,
    PROJECTION_KEYS,
    TRACE_VERSION,
    _algorithm_version,
    _current_or_initial_epoch,
    _patch_baseline,
)


ROOM = "00000000-0000-4000-8000-000000000010"
INSTALLED = "00000000-0000-4000-8000-000000000777"


class _Store:
    """Minimal head reader; the durable store is exercised elsewhere."""

    def __init__(self, heads):
        self._heads = heads

    def head(self, room_id, projection_key):
        del room_id
        return self._heads.get(projection_key)


def _heads(*, algorithm=None, parameter_hash=PARAMETER_HASH, epoch=INSTALLED):
    return {
        key: {
            "analysis_epoch": epoch,
            "algorithm_version": algorithm or _algorithm_version(key),
            "parameter_hash": parameter_hash,
        }
        for key in PROJECTION_KEYS
    }


class AnalysisEpochRotationTests(unittest.TestCase):
    def test_matching_versions_continue_the_installed_epoch(self):
        self.assertEqual(_current_or_initial_epoch(_Store(_heads()), ROOM), INSTALLED)

    def test_a_fresh_room_uses_the_deterministic_initial_epoch(self):
        self.assertEqual(
            _current_or_initial_epoch(_Store({}), ROOM),
            str(uuid5(ANALYSIS_NAMESPACE, ROOM)),
        )

    def test_stale_algorithm_version_rotates_the_epoch(self):
        heads = _heads()
        heads["echo.teacher_shadow"]["algorithm_version"] = "echo-cm-reference-v1+adapter-v1"
        rotated = _current_or_initial_epoch(_Store(heads), ROOM)
        self.assertNotEqual(rotated, INSTALLED)
        self.assertEqual(rotated, str(uuid5(
            ANALYSIS_NAMESPACE,
            f"{ROOM}:{ECHO_VERSION}:{TRACE_VERSION}:{PARAMETER_HASH}",
        )))
        # Deterministic: the same stale head must not rotate twice.
        self.assertEqual(_current_or_initial_epoch(_Store(heads), ROOM), rotated)

    def test_stale_parameter_hash_rotates_the_epoch(self):
        rotated = _current_or_initial_epoch(_Store(_heads(parameter_hash="c" * 64)), ROOM)
        self.assertNotEqual(rotated, INSTALLED)
        UUID(rotated)

    def test_rotated_epoch_is_not_the_initial_epoch(self):
        """Rotation must not silently roll a replayed room back to its first epoch."""
        heads = _heads()
        heads["echo.student_approved"]["algorithm_version"] = "stale"
        self.assertNotEqual(
            _current_or_initial_epoch(_Store(heads), ROOM),
            str(uuid5(ANALYSIS_NAMESPACE, ROOM)),
        )

    def test_incomplete_head_set_still_fails_closed(self):
        heads = _heads()
        heads.pop(PROJECTION_KEYS[0])
        with self.assertRaises(ValueError):
            _current_or_initial_epoch(_Store(heads), ROOM)

    def test_mismatched_epochs_still_fail_closed(self):
        heads = _heads()
        heads[PROJECTION_KEYS[0]]["analysis_epoch"] = "00000000-0000-4000-8000-000000000888"
        with self.assertRaises(ValueError):
            _current_or_initial_epoch(_Store(heads), ROOM)


class PatchBaselineTests(unittest.TestCase):
    """A rotated epoch declares baseVersion 0, so its first patch needs an empty base."""

    PAYLOAD = {"nodes": [{"nodeId": "n1"}], "edges": [{"edgeId": "e1"}]}
    EMPTY = {"payload": {"nodes": [], "edges": []}}

    def test_same_epoch_diffs_against_the_previous_payload(self):
        self.assertEqual(
            _patch_baseline(
                {"payload": self.PAYLOAD}, {"analysis_epoch": INSTALLED}, INSTALLED
            ),
            {"payload": self.PAYLOAD},
        )

    def test_rotated_epoch_diffs_against_an_empty_map(self):
        """Otherwise the delta contradicts the baseVersion 0 it declares."""
        self.assertEqual(
            _patch_baseline(
                {"payload": self.PAYLOAD},
                {"analysis_epoch": "00000000-0000-4000-8000-000000000999"},
                INSTALLED,
            ),
            self.EMPTY,
        )

    def test_missing_head_or_previous_is_an_empty_base(self):
        self.assertEqual(_patch_baseline(None, {"analysis_epoch": INSTALLED}, INSTALLED), self.EMPTY)
        self.assertEqual(_patch_baseline({"payload": self.PAYLOAD}, None, INSTALLED), self.EMPTY)


if __name__ == "__main__":
    unittest.main()
