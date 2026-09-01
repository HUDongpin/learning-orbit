"""Pin the shipped TRACE golden bundles to the actual pipeline output.

``packages/test-fixtures/analytics/golden-trace-projections.json`` is consumed
by the TypeScript contract, teacher-export and deletion tests as a realistic
TRACE bundle.  It used to carry empty node and edge arrays, so it pinned the
bundle *shape* while asserting nothing about the network the reference builds —
an algorithm or adapter regression could not move it.

This test rebuilds both bundles from the pinned golden room events through the
real projector, window seam and adapter, and asserts the shipped file still
matches.  Run ``python test_golden_trace_projections.py --write`` to regenerate
the fixture after a deliberate, reviewed algorithm change.

The event times below deliberately straddle the ``recent_10m`` boundary: Nova's
facilitator move at 08:54 falls outside that window while Meilin's 09:05 uptake
of it falls inside, so the fixture also pins windowed actor identity (an
out-of-window Agent must stay an Agent and stay out of ``human_only``).
"""
import json
import sys
import unittest
from pathlib import Path

from learning_orbit_worker.analytics_handlers import _window_trace_reference
from learning_orbit_worker.projector import StreamingProjector
from learning_orbit_worker.trace_adapter import project_trace, scoped_node_id

FIXTURES = Path(__file__).parents[4] / "packages" / "test-fixtures" / "analytics"
ROOM_EVENTS = FIXTURES / "golden-room-events.json"
GOLDEN = FIXTURES / "golden-trace-projections.json"

ROOM_ID = "00000000-0000-4000-8000-000000000010"
ANALYSIS_EPOCH = "00000000-0000-4000-8000-000000000901"
ALGORITHM_VERSION = "trace-ai-reference-v1+adapter-v1"
PARAMETER_HASH = "c" * 64
WATERMARK = "2026-08-28T09:05:00Z"
# A fixture key, not a deployment secret: the student node IDs in the golden
# file are HMAC-derived and must stay reproducible from this checkout alone.
PSEUDONYM_KEY = b"golden-trace-fixture-key"
WINDOWS = {
    "recent_10m": {"windowStartEventTime": "2026-08-28T08:55:00Z", "windowEndEventTime": WATERMARK},
    "session_45m": {"windowStartEventTime": "2026-08-28T08:20:00Z", "windowEndEventTime": WATERMARK},
}
EVENT_TIMES = {
    "m001": "2026-08-28T08:46:00Z",
    "m002": "2026-08-28T08:48:00Z",
    "m004": "2026-08-28T08:52:00Z",
    "m005": "2026-08-28T08:54:00Z",
    "m006": "2026-08-28T09:05:00Z",
}
EVENT_IDS = {
    "m001": "00000000-0000-4000-8000-000000000301",
    "m002": "00000000-0000-4000-8000-000000000302",
    "m004": "00000000-0000-4000-8000-000000000304",
    "m005": "00000000-0000-4000-8000-000000000305",
    "m006": "00000000-0000-4000-8000-000000000306",
}
# The golden room events name their actors symbolically; a canonical room
# envelope carries actor UUIDs, and the teacher actorMapping schema requires
# them, so the symbolic names are resolved here rather than in the shared
# event fixture (which `test_golden_directions` reads under its own naming).
ACTOR_IDS = {
    "yaqing": "00000000-0000-4000-8000-000000000501",
    "zilang": "00000000-0000-4000-8000-000000000502",
    "meilin": "00000000-0000-4000-8000-000000000503",
    "haoran": "00000000-0000-4000-8000-000000000504",
    "nova": "00000000-0000-4000-8000-000000000599",
}
IDENTITIES = {
    ACTOR_IDS["yaqing"]: ("探索者 A", "learner"),
    ACTOR_IDS["zilang"]: ("探索者 B", "learner"),
    ACTOR_IDS["meilin"]: ("探索者 C", "learner"),
    ACTOR_IDS["haoran"]: ("探索者 D", "learner"),
    ACTOR_IDS["nova"]: ("Nova Agent", "agent"),
    "ROOM": ("共學聊天室", "room"),
}


def canonical_events() -> list[dict]:
    events = []
    for seq, item in enumerate(json.loads(ROOM_EVENTS.read_text()), start=1):
        key = item["eventKey"]
        stamp = EVENT_TIMES[key]
        events.append({
            "eventId": EVENT_IDS[key], "roomId": ROOM_ID, "roomSeq": seq,
            "type": "message.added", "actorId": ACTOR_IDS[item["actorId"]],
            "actorKind": item["actorKind"], "actorRole": item.get("agentRole"),
            "revision": 1, "operation": "add",
            "eventTime": stamp, "ingestTime": stamp,
            "causationId": EVENT_IDS[key],
            "correlationId": "00000000-0000-4000-8000-000000000401",
            "payload": {"messageId": key, "text": item["text"],
                        "replyTo": item.get("replyTo"),
                        "mentions": [ACTOR_IDS[name] for name in item.get("mentions", ())]},
        })
    return events


def build() -> dict:
    events = canonical_events()
    projector = StreamingProjector(ROOM_ID)
    for event in events:
        projector.consume(event)
    references = {
        name: _window_trace_reference(
            projector.state.trace, bounds["windowStartEventTime"], bounds["windowEndEventTime"])
        for name, bounds in WINDOWS.items()
    }
    pseudonyms = {
        actor: {"nodeId": scoped_node_id(PSEUDONYM_KEY, ROOM_ID, ANALYSIS_EPOCH, actor),
                "label": label, "kind": kind}
        for actor, (label, kind) in IDENTITIES.items()
    }
    mapping = {
        actor: ({"roomId": ROOM_ID, "pseudonym": label, "kind": kind} if kind == "room"
                else {"actorId": actor, "pseudonym": label, "kind": kind})
        for actor, (label, kind) in IDENTITIES.items()
    }
    evidence = {
        event["eventId"]: {"eventId": event["eventId"], "start": 0,
                           "end": len(event["payload"]["text"]), "basis": "text_span"}
        for event in events
    }
    metadata = {
        "roomId": ROOM_ID, "analysisEpoch": ANALYSIS_EPOCH,
        "algorithmVersion": ALGORITHM_VERSION, "parameterHash": PARAMETER_HASH,
        "projectionVersion": 1, "baseVersion": 0,
        "completeThroughRoomSeq": len(events), "watermarkEventTime": WATERMARK,
        "requiresReplay": False, "warnings": [], "teacherActorMapping": mapping,
    }
    teacher, student = project_trace(references, WINDOWS, metadata, pseudonyms, evidence, 4)
    return {"teacher": teacher, "student": student}


def serialize(bundles: dict) -> str:
    return json.dumps(bundles, ensure_ascii=False, indent=2, sort_keys=False) + "\n"


class GoldenTraceProjectionTests(unittest.TestCase):
    def setUp(self):
        self.built = build()
        self.shipped = json.loads(GOLDEN.read_text())

    def test_shipped_fixture_matches_the_pipeline(self):
        self.assertEqual(self.shipped, self.built)

    def test_fixture_carries_a_real_network(self):
        """A fixture with empty views would satisfy every shape assertion."""
        for bundle in ("teacher", "student"):
            for window in WINDOWS:
                for view in ("observed", "human_only"):
                    payload = self.shipped[bundle]["payload"]["windows"][window]["views"][view]
                    with self.subTest(bundle=bundle, window=window, view=view):
                        self.assertTrue(payload["nodes"], "golden view lost its nodes")
                        self.assertTrue(payload["edges"], "golden view lost its edges")

    def test_windows_are_not_the_same_network(self):
        """The two windows must select different events, or windowing is unpinned."""
        def signature(window):
            view = self.shipped["teacher"]["payload"]["windows"][window]["views"]["observed"]
            return {(edge["sourceId"], edge["targetId"], edge["layer"]) for edge in view["edges"]}
        self.assertNotEqual(signature("recent_10m"), signature("session_45m"))
        self.assertLess(len(signature("recent_10m")), len(signature("session_45m")))

    def test_out_of_window_agent_stays_an_agent(self):
        """Nova speaks at 08:54; only her 09:05 uptake is inside recent_10m."""
        recent = self.shipped["teacher"]["payload"]["windows"]["recent_10m"]["views"]
        observed_kinds = {node["label"]: node["kind"] for node in recent["observed"]["nodes"]}
        self.assertEqual(observed_kinds.get("Nova Agent"), "agent")
        self.assertNotIn("Nova Agent", {node["label"] for node in recent["human_only"]["nodes"]})


if __name__ == "__main__":
    if "--write" in sys.argv:
        GOLDEN.write_text(serialize(build()))
        print(f"wrote {GOLDEN}")
    else:
        unittest.main()
