"""Windowed TRACE references must keep room-level actor identity.

``_window_trace_reference`` replays only the history inside one event-time
window.  Actor kind is recorded by ``StreamingInteractionNetwork.apply``, so an
actor whose own events all fall outside the window used to arrive as a bare
edge endpoint with no recorded kind, and the reference snapshot defaulted it to
``human``.  A Nova message older than the ten-minute window that a learner
still replies to therefore typed the Agent as a learner in ``recent_10m``:
``human_only`` gained an Agent node and its incident edges — which
``validate_internal_views`` cannot catch, because it reads that same wrong
kind — and the teacher actor mapping then contradicted the view and aborted
every projection for the room.
"""
import unittest

from learning_orbit_worker.analytics_handlers import _window_trace_reference
from learning_orbit_worker.projector import StreamingProjector
from learning_orbit_worker.trace_adapter import project_trace, scoped_node_id

ROOM = "00000000-0000-4000-8000-0000000000aa"
EPOCH = "00000000-0000-4000-8000-0000000000bb"
KEY = b"windowing-regression-key"
IDENTITIES = {
    "a-mei": ("探索者 A", "learner"),
    "a-hao": ("探索者 B", "learner"),
    "nova": ("Nova Agent", "agent"),
    "ROOM": ("共學聊天室", "room"),
}


def room_event(seq, message_id, actor, text, minute, reply=None, kind="human", role=None):
    stamp = f"2026-08-28T09:{minute:02d}:00Z"
    return {"eventId": f"00000000-0000-4000-8000-{seq:012d}", "roomId": ROOM, "roomSeq": seq,
            "type": "message.added", "actorId": actor, "actorKind": kind, "actorRole": role,
            "revision": 1, "operation": "add", "eventTime": stamp,
            "ingestTime": f"2026-08-28T09:{minute:02d}:01Z", "causationId": f"c{seq}",
            "correlationId": "corr",
            "payload": {"messageId": message_id, "text": text, "replyTo": reply, "mentions": []}}


# Nova speaks at 09:02 and stays silent; the learners take that move up at
# 09:16 and 09:20, inside a ten-minute window that excludes Nova's own event.
EVENTS = [
    room_event(1, "m1", "a-mei", "生產者把太陽能轉成能量。", 0),
    room_event(2, "m2", "nova", "還有誰想補充？", 2, "m1", "agent", "socratic_facilitator"),
    room_event(3, "m3", "a-mei", "根據 Nova 的整理，分解者也很重要。", 16, "m2"),
    room_event(4, "m4", "a-hao", "我同意，因為分解者把能量還給土壤。", 20, "m3"),
]
RECENT = {"windowStartEventTime": "2026-08-28T09:10:01Z", "windowEndEventTime": "2026-08-28T09:20:01Z"}
SESSION = {"windowStartEventTime": "2026-08-28T08:35:01Z", "windowEndEventTime": "2026-08-28T09:20:01Z"}


def project() -> StreamingProjector:
    projector = StreamingProjector(ROOM)
    for event in EVENTS:
        projector.consume(event)
    return projector


def kinds(view):
    return {node["nodeId"]: node["actorKind"] for node in view["nodes"]}


def endpoints(view):
    return {(edge["sourceId"], edge["targetId"], edge["layer"]) for edge in view["edges"]}


class TraceWindowingTests(unittest.TestCase):
    def setUp(self):
        network = project().state.trace
        self.recent = _window_trace_reference(
            network, RECENT["windowStartEventTime"], RECENT["windowEndEventTime"])["views"]
        self.session = _window_trace_reference(
            network, SESSION["windowStartEventTime"], SESSION["windowEndEventTime"])["views"]

    def test_out_of_window_agent_keeps_its_actor_kind(self):
        self.assertEqual(kinds(self.recent["observed"]).get("nova"), "agent")
        self.assertEqual(kinds(self.session["observed"]).get("nova"), "agent")

    def test_human_only_excludes_an_out_of_window_agent_and_its_edges(self):
        human_only = self.recent["human_only"]
        self.assertNotIn("nova", kinds(human_only))
        self.assertTrue(all(kind in {"human", "learner"} for kind in kinds(human_only).values()))
        self.assertFalse(any("nova" in (source, target) for source, target, _ in endpoints(human_only)))
        # The learner-to-learner structure inside the window must survive; an
        # empty view would satisfy the assertions above for the wrong reason.
        self.assertEqual(
            endpoints(human_only),
            {("a-hao", "a-mei", "communication"), ("a-mei", "a-hao", "uptake")},
        )

    def test_window_still_filters_events_by_event_time(self):
        # Only the in-window events contribute.  m1's broadcast at 09:00 is
        # outside the recent window and inside the session window.
        self.assertNotIn(("a-mei", "ROOM", "communication"), endpoints(self.recent["observed"]))
        self.assertIn(("a-mei", "ROOM", "communication"), endpoints(self.session["observed"]))
        # Nova's own facilitator reply at 09:02 is likewise out of the recent
        # window, while the facilitation edge the 09:16 uptake produced stays.
        self.assertIn(("nova", "a-mei", "facilitation"), endpoints(self.recent["observed"]))
        self.assertIn(("a-mei", "nova", "communication"), endpoints(self.recent["observed"]))

    def test_projection_survives_an_out_of_window_agent(self):
        pseudonyms = {
            actor: {"nodeId": scoped_node_id(KEY, ROOM, EPOCH, actor), "label": label, "kind": kind}
            for actor, (label, kind) in IDENTITIES.items()
        }
        mapping = {
            actor: ({"roomId": ROOM, "pseudonym": label, "kind": kind} if kind == "room"
                    else {"actorId": actor, "pseudonym": label, "kind": kind})
            for actor, (label, kind) in IDENTITIES.items()
        }
        evidence = {
            event["eventId"]: {"eventId": event["eventId"], "start": 0,
                               "end": len(event["payload"]["text"]), "basis": "text_span"}
            for event in EVENTS
        }
        metadata = {"roomId": ROOM, "analysisEpoch": EPOCH, "algorithmVersion": "trace-v1",
                    "parameterHash": "a" * 64, "projectionVersion": 1, "baseVersion": 0,
                    "completeThroughRoomSeq": len(EVENTS),
                    "watermarkEventTime": RECENT["windowEndEventTime"],
                    "requiresReplay": False, "warnings": [], "teacherActorMapping": mapping}
        # Before the fix this raised INVALID_TRACE_ACTOR_MAPPING, which aborted
        # _materialize and dead-lettered the room's analytics.consume job.
        teacher, student = project_trace(
            {"recent_10m": {"views": self.recent}, "session_45m": {"views": self.session}},
            {"recent_10m": RECENT, "session_45m": SESSION},
            metadata, pseudonyms, evidence, 4,
        )
        recent = teacher["payload"]["windows"]["recent_10m"]["views"]
        self.assertIn("agent", {node["kind"] for node in recent["observed"]["nodes"]})
        self.assertEqual({node["kind"] for node in recent["human_only"]["nodes"]}, {"learner"})
        student_recent = student["payload"]["windows"]["recent_10m"]["views"]["observed"]
        self.assertEqual({node["kind"] for node in student_recent["nodes"]}, {"learner"})
        self.assertNotIn("Nova Agent", {node["label"] for node in student_recent["nodes"]})


if __name__ == "__main__":
    unittest.main()
