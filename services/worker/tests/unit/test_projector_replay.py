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
