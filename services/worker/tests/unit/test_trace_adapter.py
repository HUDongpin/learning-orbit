import unittest
from learning_orbit_worker.extractors import MessageLineageIndex, to_chat_event
from learning_orbit_worker.reference.learning_orbit_algorithms_v1 import StreamingInteractionNetwork
from learning_orbit_worker.trace_adapter import (
    TRACE_STUDENT_INTERPRETATION_ZH_HANT,
    _metrics,
    _normalize_view,
    project_trace,
    scoped_node_id,
)


def room_event(seq, event_id, actor, text, reply=None, mentions=(), kind="human", role=None, sources=()):
    payload = {"messageId": event_id, "text": text, "replyTo": reply, "mentions": list(mentions)}
    if sources: payload["sourceEventIds"] = list(sources)
    return {"eventId":event_id,"roomId":"room","roomSeq":seq,"type":"message.added","actorId":actor,"actorKind":kind,"actorRole":role,"revision":1,"operation":"add","eventTime":f"2026-08-28T09:{seq:02d}:00Z","ingestTime":f"2026-08-28T09:{seq:02d}:01Z","causationId":event_id,"correlationId":"corr","payload":payload}


class TraceAdapterTests(unittest.TestCase):
    def test_metrics_fail_closed_instead_of_fabricating_zero_or_clamping(self):
        valid = _metrics({"metrics": {
            "participationBalance": 0.25,
            "weightedReciprocity": 0.5,
            "agentShare": 0.0,
            "semanticCoverage": 1.0,
        }})
        self.assertEqual(valid, {
            "participationBalance": 0.25,
            "reciprocity": 0.5,
            "agentShare": 0.0,
            "semanticCoverage": 1.0,
        })
        invalid_metrics = (
            {},
            {"participationBalance": float("nan"), "weightedReciprocity": 0, "agentShare": 0, "semanticCoverage": 0},
            {"participationBalance": -0.1, "weightedReciprocity": 0, "agentShare": 0, "semanticCoverage": 0},
            {"participationBalance": 1.1, "weightedReciprocity": 0, "agentShare": 0, "semanticCoverage": 0},
            {"participationBalance": True, "weightedReciprocity": 0, "agentShare": 0, "semanticCoverage": 0},
            {"participationBalance": 0, "weightedReciprocity": 0.25, "reciprocity": 0.5, "agentShare": 0, "semanticCoverage": 0},
        )
        for metrics in invalid_metrics:
            with self.subTest(metrics=metrics), self.assertRaisesRegex(ValueError, "INVALID_TRACE_METRICS"):
                _metrics({"metrics": metrics})

    def test_teacher_edge_channels_and_weight_are_preserved_or_rejected_without_clamping(self):
        edge = {
            "edgeId": "edge-a",
            "sourceId": "learner-a",
            "targetId": "learner-b",
            "layer": "communication",
            "weight": 2.5,
            "channels": {"positive": 2.0, "challenge": 0.5, "uncertain": 0.0},
            "evidenceIds": ["evidence-a"],
        }
        reference = {
            "nodes": [
                {"nodeId": "learner-a", "actorKind": "human", "label": "A"},
                {"nodeId": "learner-b", "actorKind": "human", "label": "B"},
            ],
            "edges": [edge],
            "metrics": {
                "participationBalance": 0.5,
                "weightedReciprocity": 0.25,
                "agentShare": 0.0,
                "semanticCoverage": 0.5,
            },
            "warnings": [],
        }
        evidence = {"evidence-a": {
            "eventId": "00000000-0000-4000-8000-000000000003",
            "start": 0,
            "end": 1,
        }}
        normalized = _normalize_view(reference, "observed", evidence, "00000000-0000-4000-8000-000000000001")
        self.assertEqual(normalized["edges"][0]["weight"], 2.5)
        self.assertEqual(normalized["edges"][0]["channels"], edge["channels"])

        invalid_edges = (
            {**edge, "channels": {"positive": 1.0, "challenge": 0.0}},
            {**edge, "channels": {"positive": float("nan"), "challenge": 0.0, "uncertain": 0.0}},
            {**edge, "channels": {"positive": -1.0, "challenge": 0.0, "uncertain": 0.0}},
            {**edge, "channels": {"positive": True, "challenge": 0.0, "uncertain": 0.0}},
            {key: value for key, value in edge.items() if key != "weight"},
            {**edge, "weight": float("nan")},
            {**edge, "weight": -1.0},
            {**edge, "weight": True},
        )
        for invalid in invalid_edges:
            with self.subTest(edge=invalid), self.assertRaisesRegex(ValueError, "INVALID_TRACE_EDGE"):
                _normalize_view({**reference, "edges": [invalid]}, "observed", evidence, "00000000-0000-4000-8000-000000000001")

    def test_three_views_and_safe_student_bundle(self):
        events = [room_event(1,"m001","yaqing","我先把太陽連到生產者。"), room_event(2,"m002","zilang","@雅晴 我同意能量從太陽進來。","m001",("yaqing",)), room_event(3,"m004","haoran","分解者讓物質回到土壤。"), room_event(4,"m005","nova","你們會用哪一條觀察來反駁？","m004",(),"agent","socratic_facilitator",("m004",)), room_event(5,"m006","meilin","@浩然 因為能量會散失成熱，我承接這個觀點。","m005",("haoran",))]
        index = MessageLineageIndex(); net = StreamingInteractionNetwork()
        for raw in events:
            net.apply(to_chat_event(raw, lineage=index))
        snap = net.snapshot(now="2026-08-28T09:05:00Z").to_dict()
        identities = {
            "yaqing": ("探索者 A", "learner", "00000000-0000-4000-8000-000000000101"),
            "zilang": ("探索者 B", "learner", "00000000-0000-4000-8000-000000000102"),
            "meilin": ("探索者 C", "learner", "00000000-0000-4000-8000-000000000103"),
            "haoran": ("探索者 D", "learner", "00000000-0000-4000-8000-000000000104"),
            "nova": ("Nova Agent", "agent", "00000000-0000-4000-8000-000000000199"),
            "ROOM": ("共學聊天室", "room", "00000000-0000-4000-8000-000000000001"),
        }
        pseudonyms = {
            actor: {"nodeId": f"p-{actor:0>16}"[-18:], "label": label, "kind": kind}
            for actor, (label, kind, _actor_id) in identities.items()
        }
        # The adapter expects scoped IDs; use a deterministic test key.
        pseudonyms = {k:{"nodeId":scoped_node_id(b"key", "room", "epoch", k), "label":v["label"], "kind":v["kind"]} for k,v in pseudonyms.items()}
        metadata={"roomId":"room","analysisEpoch":"epoch","algorithmVersion":"trace-v1","parameterHash":"a"*64,"projectionVersion":1,"baseVersion":0,"completeThroughRoomSeq":5,"watermarkEventTime":"2026-08-28T09:05:00Z","requiresReplay":False,"warnings":[],"teacherActorMapping":{
            actor: ({"roomId": actor_id, "pseudonym": label, "kind": kind}
                    if kind == "room" else {"actorId": actor_id, "pseudonym": label, "kind": kind})
            for actor, (label, kind, actor_id) in identities.items()
        }}
        evidence={eid:{"eventId":eid,"start":0,"end":1} for eid in ("m001","m002","m004","m005","m006")}
        teacher, student = project_trace({"recent_10m":snap,"session_45m":snap},{"recent_10m":{"windowStartEventTime":"2026-08-28T08:55:00Z","windowEndEventTime":"2026-08-28T09:05:00Z"},"session_45m":{"windowStartEventTime":"2026-08-28T08:20:00Z","windowEndEventTime":"2026-08-28T09:05:00Z"}},metadata,pseudonyms,evidence,4)
        self.assertEqual(set(teacher["payload"]["windows"]), {"recent_10m","session_45m"})
        self.assertEqual(set(teacher["payload"]["windows"]["recent_10m"]["views"]), {"observed","human_only","lineage_adjusted"})
        self.assertEqual(student["payload"]["interpretation"], TRACE_STUDENT_INTERPRETATION_ZH_HANT)
        text = str(student)
        self.assertNotIn("yaqing", text)
        teacher_labels = {
            node["label"]
            for node in teacher["payload"]["windows"]["recent_10m"]["views"]["observed"]["nodes"]
        }
        self.assertNotIn("yaqing", teacher_labels)
        self.assertTrue(teacher_labels <= {value[0] for value in identities.values()})
        self.assertEqual(
            teacher["payload"]["actorMapping"]["ROOM"],
            {"roomId": "00000000-0000-4000-8000-000000000001", "pseudonym": "共學聊天室", "kind": "room"},
        )

    def test_student_observed_view_is_learner_only_even_when_reference_has_agent_and_room(self):
        """Student bundles must satisfy the closed, group-safe branch.

        The teacher observed view may retain the virtual ROOM and Nova Agent
        nodes, but the generated StudentView schema deliberately permits only
        pseudonymous learner nodes and learner-to-learner communication/
        uptake edges.  This regression catches accidental leakage when the
        adapter receives a realistic actor index (rather than a fixture where
        every node is mislabeled as a learner).
        """
        metadata = {
            "roomId": "00000000-0000-4000-8000-000000000001",
            "analysisEpoch": "00000000-0000-4000-8000-000000000002",
            "algorithmVersion": "trace-v1",
            "parameterHash": "a" * 64,
            "projectionVersion": 1,
            "baseVersion": 0,
            "completeThroughRoomSeq": 2,
            "watermarkEventTime": "2026-08-28T09:05:00Z",
            "requiresReplay": False,
            "warnings": [],
            "teacherActorMapping": {
                "learner-a": {"actorId": "00000000-0000-4000-8000-000000000101", "pseudonym": "探索者 A", "kind": "learner"},
                "nova": {"actorId": "00000000-0000-4000-8000-000000000199", "pseudonym": "Nova Agent", "kind": "agent"},
                "ROOM": {"roomId": "00000000-0000-4000-8000-000000000001", "pseudonym": "共學聊天室", "kind": "room"},
            },
        }
        reference = {
            "nodes": [
                {"nodeId": "learner-a", "actorKind": "human", "label": "A"},
                {"nodeId": "nova", "actorKind": "agent", "label": "Nova Agent"},
                {"nodeId": "ROOM", "actorKind": "room", "label": "共學聊天室"},
            ],
            "edges": [
                {
                    "edgeId": "edge-a",
                    "sourceId": "learner-a", "targetId": "ROOM",
                    "layer": "communication", "weight": 1,
                    "channels": {"positive": 1, "challenge": 0, "uncertain": 0},
                    "evidenceIds": ["ev-a"],
                },
                {
                    "edgeId": "edge-b",
                    "sourceId": "nova", "targetId": "learner-a",
                    "layer": "facilitation", "weight": 1,
                    "channels": {"positive": 1, "challenge": 0, "uncertain": 0},
                    "evidenceIds": ["ev-b"],
                },
            ],
            "metrics": {
                "participationBalance": 1,
                "weightedReciprocity": 0,
                "agentShare": 0.5,
                "semanticCoverage": 0,
            },
            "warnings": [],
        }
        pseudonyms = {
            "learner-a": {"nodeId": scoped_node_id(b"test-key", metadata["roomId"], metadata["analysisEpoch"], "learner-a"), "label": "探索者 A", "kind": "learner"},
            "nova": {"nodeId": scoped_node_id(b"test-key", metadata["roomId"], metadata["analysisEpoch"], "nova"), "label": "Nova Agent", "kind": "agent"},
            "ROOM": {"nodeId": scoped_node_id(b"test-key", metadata["roomId"], metadata["analysisEpoch"], "ROOM"), "label": "共學聊天室", "kind": "room"},
        }
        evidence = {
            "ev-a": {"eventId": "00000000-0000-4000-8000-000000000003", "start": 0, "end": 1},
            "ev-b": {"eventId": "00000000-0000-4000-8000-000000000004", "start": 0, "end": 1},
        }
        teacher, student = project_trace(
            {"recent_10m": reference, "session_45m": reference},
            {"recent_10m": {"windowStartEventTime": metadata["watermarkEventTime"], "windowEndEventTime": metadata["watermarkEventTime"]},
             "session_45m": {"windowStartEventTime": metadata["watermarkEventTime"], "windowEndEventTime": metadata["watermarkEventTime"]}},
            metadata, pseudonyms, evidence, 4,
        )
        observed = student["payload"]["windows"]["recent_10m"]["views"]["observed"]
        self.assertTrue(all(node["kind"] == "learner" for node in observed["nodes"]))
        self.assertTrue(all(edge["sourceNodeId"] != edge["targetNodeId"] for edge in observed["edges"]))
        self.assertTrue(all(
            edge["sourceNodeId"] in {node["nodeId"] for node in observed["nodes"]}
            and edge["targetNodeId"] in {node["nodeId"] for node in observed["nodes"]}
            for edge in observed["edges"]
        ))
        # Teacher output retains the structural Agent/ROOM evidence.
        teacher_nodes = teacher["payload"]["windows"]["recent_10m"]["views"]["observed"]["nodes"]
        self.assertIn("agent", {node["kind"] for node in teacher_nodes})
