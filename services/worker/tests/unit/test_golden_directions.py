import json
import unittest
from pathlib import Path
from learning_orbit_worker.extractors import MessageLineageIndex, to_chat_event, extract_trace_evidence
from learning_orbit_worker.reference.learning_orbit_algorithms_v1 import StreamingInteractionNetwork

FIXTURE = Path(__file__).parents[4] / "packages" / "test-fixtures" / "analytics" / "golden-room-events.json"


def make_event(item, seq):
    ids = {"m001":"e001", "m002":"e002", "m004":"e004", "m005":"e005", "m006":"e006"}
    actor_role = item.get("agentRole")
    return {"eventId":ids[item["eventKey"]],"roomId":"room","roomSeq":seq,"type":"message.added","actorId":item["actorId"],"actorKind":item["actorKind"],"actorRole":actor_role,"revision":1,"operation":"add","eventTime":f"2026-08-28T09:0{seq}:00Z","ingestTime":f"2026-08-28T09:0{seq}:01Z","causationId":"c"+str(seq),"correlationId":"corr","payload":{"messageId":item["eventKey"],"text":item["text"],"replyTo":item.get("replyTo"),"mentions":item.get("mentions",[])}}


class GoldenDirectionTests(unittest.TestCase):
    def test_reference_directions(self):
        items = json.loads(FIXTURE.read_text())
        lineage = MessageLineageIndex(); network = StreamingInteractionNetwork()
        events = []
        for seq, item in enumerate(items, 1):
            event = to_chat_event(make_event(item, seq), lineage=lineage)
            events.append(event); network.apply(event, evidence=extract_trace_evidence(event, events[:-1]), derive_event_relations=False)
        edges = {(e["sourceId"],e["targetId"],e["layer"]) for e in network.snapshot(view="observed").to_dict()["edges"]}
        lineage_edges = {(e["sourceId"],e["targetId"],e["layer"]) for e in network.snapshot(view="lineage_adjusted").to_dict()["edges"]}
        self.assertIn(("zilang", "yaqing", "communication"), edges)
        self.assertIn(("yaqing", "zilang", "uptake"), edges)
        self.assertIn(("nova", "haoran", "facilitation"), edges)
        self.assertIn(("haoran", "meilin", "uptake"), lineage_edges)
        self.assertNotIn(("nova", "meilin", "uptake"), lineage_edges)
