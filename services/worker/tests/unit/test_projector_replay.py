import unittest
from datetime import datetime, timezone
from learning_orbit_worker.projector import StreamingProjector
from learning_orbit_worker.replay import online_batch_parity


def event(seq, event_id=None, text=""):
    event_id = event_id or f"e{seq}"
    return {"eventId":event_id,"roomId":"room","roomSeq":seq,"type":"message.added" if text else "room.paused","actorId":"s1","actorKind":"human","actorRole":"student","revision":1,"operation":"add","eventTime":f"2026-08-28T09:0{seq}:00Z","ingestTime":f"2026-08-28T09:0{seq}:01Z","causationId":event_id,"correlationId":"c","payload":{"messageId":event_id,"text":text,"replyTo":None,"mentions":[]}}


class ProjectorTests(unittest.TestCase):
    def test_out_of_order_buffer_drains_by_room_sequence(self):
        projector = StreamingProjector("room")
        self.assertTrue(projector.consume(event(2, text="later"))["blocked"])
        result = projector.consume(event(1, text="first"))
        self.assertEqual(result["completeThroughRoomSeq"], 2)

    def test_semantic_noop_still_advances_cursor(self):
        projector = StreamingProjector("room")
        self.assertTrue(projector.consume(event(1))["applied"])
        self.assertEqual(projector.state.complete_through_room_seq, 1)

    def test_batch_parity(self):
        self.assertTrue(online_batch_parity([event(1, text="太陽提供能量給生產者。"), event(2, text="生產者供給消費者")], "room"))

    def test_replay_admits_an_event_the_online_gate_dropped(self):
        """A rebuild that only replays ``consume`` reproduces the dropped event.

        The online path applies a five-second lateness gate against the
        watermark.  Rebuilding an epoch by feeding history back through
        ``consume`` therefore drops exactly the same event again, which is why
        a replay has to go through ``replay``.
        """
        def message(seq, event_id, text, event_time, ingest_time):
            return {"eventId": event_id, "roomId": "room", "roomSeq": seq,
                    "type": "message.added", "actorId": "s1", "actorKind": "human",
                    "actorRole": "student", "revision": 1, "operation": "add",
                    "eventTime": event_time, "ingestTime": ingest_time,
                    "causationId": event_id, "correlationId": "c",
                    "payload": {"messageId": event_id, "text": text,
                                "replyTo": None, "mentions": []}}

        history = [
            message(1, "e1", "太陽提供能量給生產者。",
                    "2026-08-28T09:00:00Z", "2026-08-28T09:00:00Z"),
            message(2, "e2", "生產者供給消費者。",
                    "2026-08-28T09:05:00Z", "2026-08-28T09:05:00Z"),
            # Ordered by roomSeq, but its event time is minutes behind the
            # watermark the previous event advanced.
            message(3, "e3", "分解者回收養分回到土壤。",
                    "2026-08-28T09:00:30Z", "2026-08-28T09:05:30Z"),
        ]

        def nodes(projector):
            snapshot = projector.state.echo.snapshot()
            payload = snapshot.to_dict() if hasattr(snapshot, "to_dict") else snapshot
            return sorted(node.get("label", node.get("id")) for node in payload.get("nodes", []))

        online = StreamingProjector("room")
        for item in history:
            online.consume(item)
        self.assertTrue(online.state.requires_replay)
        gated = nodes(online)
        self.assertNotIn("decomposers", gated)

        rebuilt_by_consume = StreamingProjector("room")
        for item in history:
            rebuilt_by_consume.consume(item)
        self.assertEqual(nodes(rebuilt_by_consume), gated)

        online.replay()
        self.assertFalse(online.state.requires_replay)
        self.assertIn("decomposers", nodes(online))

    def test_future_client_timestamp_is_clamped_in_projector(self):
        future = event(1, text="太陽提供能量給生產者")
        future["eventTime"] = "2027-08-28T09:00:00Z"
        future["ingestTime"] = "2026-08-28T09:00:00Z"
        normal = event(2, text="能量沿食物鏈傳遞")
        normal["eventTime"] = "2026-08-28T09:00:01Z"
        normal["ingestTime"] = "2026-08-28T09:00:01Z"
        projector = StreamingProjector("room")
        projector.consume(future)
        result = projector.consume(normal)
        self.assertFalse(result["requiresReplay"])
        self.assertIn("client_time_future_clamped", projector.state.warnings)
        expected = datetime(2026, 8, 28, 9, 0, 1, tzinfo=timezone.utc).timestamp()
        self.assertLessEqual(projector.state.echo.watermark, expected)
