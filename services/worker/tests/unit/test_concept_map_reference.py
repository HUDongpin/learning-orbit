"""Regression tests for the reference-version-1.1 concept map defect fixes.

Each test reproduces the exact failure the fix was written for.  The scenarios
are kept in reference terms (ChatEvent in, snapshot out) so they stay valid if
the surrounding worker plumbing changes.
"""
import unittest

from learning_orbit_worker.reference.learning_orbit_algorithms_v1 import (
    CandidateProposition,
    ChatEvent,
    EvidenceRef,
    StreamingConceptMap,
)


class _SharedPredicateExtractor:
    """One predicate over different heads, so contributions can share an edge.

    The shipped ecosystem fixture gives every pattern a distinct predicate, so
    it cannot produce a colliding edge key.  ``PropositionExtractor`` is a
    public Protocol and ``run_benchmark`` already feeds a single predicate
    across many concept pairs, so the collision is reachable by design.
    """

    def __init__(self, heads):
        self._heads = heads

    def extract(self, event, context=()):
        head = self._heads.get(event.event_id)
        if head is None:
            return ()
        return (
            CandidateProposition(
                head=head, link_phrase="relates to", tail="t",
                relation_family="causal", stance="support", confidence=0.8,
                evidence=(EvidenceRef(
                    evidence_id="ev-" + event.event_id, event_id=event.event_id,
                ),),
            ),
        )


SUN = "The sun provides energy to producers."
FEED = "Producers feed consumers."
SOIL = "Soil provides nutrients to producers."

# theta_on is cleared at t=0 (activity 0.95) and the edge stays held by the
# theta_off band until ~2993s, so 1500 is inside the hysteresis window.
HELD = 1500.0


def event(event_id, text, at, *, operation="add", retracts=None, revision=1):
    return ChatEvent(
        event_id=event_id, session_id="room-1", event_time=float(at),
        ingest_time=float(at), actor_id="actor-1", actor_kind="human",
        modality="text", text=text, revision=revision, operation=operation,
        retracts=retracts,
    )


class MergeRekeyTests(unittest.TestCase):
    """cm-merge-rekey: an alias change must not evict unrelated edges."""

    def _two_held_edges(self):
        concept_map = StreamingConceptMap()
        concept_map.apply(event("e1", SUN, 0))
        concept_map.apply(event("e2", FEED, 0))
        self.assertEqual(len(concept_map.snapshot(now=0)["edges"]), 2)
        held = concept_map.snapshot(now=HELD)
        self.assertEqual(len(held["edges"]), 2)
        self.assertEqual(held["archivedEdgeIds"], [])
        return concept_map

    def test_unrelated_merge_keeps_edges_held_by_hysteresis(self):
        concept_map = self._two_held_edges()
        self.assertTrue(concept_map.merge_concepts("dirt", "soil"))
        after = concept_map.snapshot(now=HELD)
        self.assertEqual(len(after["edges"]), 2)
        self.assertEqual(after["archivedEdgeIds"], [])

    def test_unrelated_undo_merge_keeps_edges_held_by_hysteresis(self):
        concept_map = self._two_held_edges()
        concept_map.merge_concepts("dirt", "soil")
        self.assertTrue(concept_map.undo_merge("dirt"))
        after = concept_map.snapshot(now=HELD)
        self.assertEqual(len(after["edges"]), 2)
        self.assertEqual(after["archivedEdgeIds"], [])

    def test_relevant_merge_still_rekeys_the_edge(self):
        concept_map = StreamingConceptMap()
        concept_map.apply(event("e1", SOIL, 0))
        before = concept_map.snapshot(now=0)["edges"][0]
        self.assertEqual(before["head"], "soil")
        concept_map.merge_concepts("soil", "earth")
        after = concept_map.snapshot(now=0)["edges"]
        self.assertEqual(len(after), 1)
        self.assertEqual(after[0]["head"], "earth")
        self.assertNotEqual(after[0]["edgeId"], before["edgeId"])
        # The re-keyed edge inherits visibility rather than being re-archived.
        self.assertEqual(concept_map.snapshot(now=0)["archivedEdgeIds"], [])

    def test_edges_that_decay_out_are_still_archived(self):
        concept_map = StreamingConceptMap()
        concept_map.apply(event("e1", SUN, 0))
        concept_map.snapshot(now=0)
        gone = concept_map.snapshot(now=4000)
        self.assertEqual(gone["edges"], [])
        self.assertEqual(len(gone["archivedEdgeIds"]), 1)


class RetractTombstoneTests(unittest.TestCase):
    """cm-retract-tombstone: a retraction may outrun the event it targets."""

    def test_retract_before_target_suppresses_the_late_arrival(self):
        concept_map = StreamingConceptMap()
        retract = concept_map.apply(
            event("r1", "", 100, operation="retract", retracts="e9")
        )
        self.assertEqual(retract.removed_edges, ())
        target = concept_map.apply(event("e9", SUN, 100.5))
        self.assertEqual(target.reason, "retracted_before_arrival")
        self.assertEqual(target.added_edges, ())
        self.assertEqual(concept_map.snapshot(now=100.5)["edges"], [])

    def test_tombstone_also_suppresses_a_later_revision(self):
        concept_map = StreamingConceptMap()
        concept_map.apply(event("r1", "", 100, operation="retract", retracts="e9"))
        concept_map.apply(event("e9", SUN, 100.5))
        concept_map.apply(event("e9", SUN, 101, revision=2))
        self.assertEqual(concept_map.snapshot(now=101)["edges"], [])

    def test_ordinary_retract_order_is_unchanged(self):
        concept_map = StreamingConceptMap()
        concept_map.apply(event("e1", SUN, 100))
        self.assertEqual(len(concept_map.snapshot(now=100)["edges"]), 1)
        concept_map.apply(event("r1", "", 101, operation="retract", retracts="e1"))
        self.assertEqual(concept_map.snapshot(now=101)["edges"], [])

    def test_unretracted_events_are_untouched(self):
        concept_map = StreamingConceptMap()
        concept_map.apply(event("r1", "", 100, operation="retract", retracts="e9"))
        concept_map.apply(event("e1", SUN, 100.5))
        self.assertEqual(len(concept_map.snapshot(now=100.5)["edges"]), 1)

    def test_replay_reproduces_the_tombstone(self):
        concept_map = StreamingConceptMap()
        concept_map.apply(event("r1", "", 100, operation="retract", retracts="e9"))
        concept_map.apply(event("e9", SUN, 100.5))
        online = concept_map.snapshot(now=100.5)
        self.assertEqual(concept_map.replay(now=100.5), online)


class RekeyIdentityTests(unittest.TestCase):
    """Regressions found reviewing the cm-merge-rekey fix itself."""

    @staticmethod
    def _map(heads):
        return StreamingConceptMap(
            _SharedPredicateExtractor(heads),
            half_life=100.0, theta_on=0.6, theta_off=0.3,
        )

    def test_split_alias_carries_state_to_every_successor(self):
        """A shared edge id has many successors; none may be stranded."""
        for order in (("e1", "e2"), ("e2", "e1")):
            with self.subTest(order=order):
                concept_map = self._map({"e1": "alpha", "e2": "beta"})
                for event_id in order:
                    concept_map.apply(event(event_id, "", 0))
                concept_map.merge_concepts("alpha", "gamma")
                concept_map.merge_concepts("beta", "gamma")
                concept_map.snapshot(now=0)
                self.assertEqual(len(concept_map.snapshot(now=100)["edges"]), 1)
                concept_map.undo_merge("beta")
                after = concept_map.snapshot(now=100)
                # Both halves are still above theta_off, so both stay visible
                # regardless of which contribution was inserted first.
                self.assertEqual(
                    sorted(edge["head"] for edge in after["edges"]),
                    ["beta", "gamma"],
                )
                self.assertEqual(after["archivedEdgeIds"], [])

    def test_retracted_contribution_does_not_define_edge_identity(self):
        """An inactive contribution must not redirect a live edge's hysteresis."""
        concept_map = self._map({"e1": "alpha", "e2": "beta"})
        concept_map.apply(event("e1", "", 0))
        concept_map.merge_concepts("beta", "alpha")
        concept_map.apply(event("e2", "", 0))
        concept_map.apply(event("r1", "", 1, operation="retract", retracts="e2"))
        concept_map.snapshot(now=0)
        self.assertEqual(len(concept_map.snapshot(now=100)["edges"]), 1)
        # Re-aliases only the retracted contribution.
        concept_map.merge_concepts("beta", "zeta")
        after = concept_map.snapshot(now=100)
        self.assertEqual([edge["head"] for edge in after["edges"]], ["alpha"])
        # No fabricated id for an edge that was never visible.
        self.assertEqual(after["archivedEdgeIds"], [])


if __name__ == "__main__":
    unittest.main()
