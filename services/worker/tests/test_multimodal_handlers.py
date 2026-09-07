"""Deriving text from media that was already scanned and promoted."""
import json
import unittest
from uuid import uuid4

from learning_orbit_worker.core_handlers import RetryableJobError, TerminalJobError
from learning_orbit_worker.handler_registry import HandlerOutcome, HandlerRegistry, WorkerDeps
from learning_orbit_worker.multimodal_handlers import (
    multimodal_derive_handler,
    register_multimodal_handlers,
)
from learning_orbit_worker.providers.multimodal import (
    AsrResult,
    DeterministicMultimodalProvider,
    OcrResult,
)

ROOM = str(uuid4())
MEDIA = str(uuid4())
EVENT = str(uuid4())
MESSAGE = str(uuid4())


class FakeCursor:
    def __init__(self, rows):
        self._rows = rows
        self.rowcount = len(rows)
        self.description = None

    def fetchone(self):
        return self._rows[0] if self._rows else None


class FakeConnection:
    def __init__(self, *, media=None, event=True, room=ROOM, state="ready", kind="audio"):
        self.media = media if media is not None else {
            "media_id": MEDIA, "room_id": room, "kind": kind, "state": state,
            "sha256": "a" * 64, "alt_text": "學生上傳的觀察圖",
        }
        self.event = event
        self.inserted = []

    def execute(self, sql, params=()):
        if "FROM media_asset" in sql:
            return FakeCursor([self.media] if self.media else [])
        if "FROM room_event" in sql:
            if not self.event:
                return FakeCursor([])
            return FakeCursor([{
                "event_id": EVENT, "room_id": ROOM, "room_seq": 7,
                "ingest_time": "2026-09-07T10:00:00Z", "event_time": "2026-09-07T10:00:00Z",
                "payload": {"messageId": MESSAGE, "mediaIds": [MEDIA]},
            }])
        if sql.startswith("INSERT INTO derived_text_artifact"):
            self.inserted.append(params)
            return FakeCursor([])
        raise AssertionError("unexpected query: " + sql[:60])


class Job:
    def __init__(self, modality="audio", payload=None):
        self.payload = payload if payload is not None else {
            "mediaId": MEDIA, "sourceEventId": EVENT, "modality": modality,
        }
        self.room_id = ROOM
        self.job_id = str(uuid4())


def deps(connection, provider=None):
    value = WorkerDeps.__new__(WorkerDeps)
    object.__setattr__(value, "db", connection)
    object.__setattr__(value, "multimodal_provider", provider)
    return value


class DerivationTest(unittest.TestCase):
    def test_transcribes_audio_into_an_unreviewed_hidden_artifact(self) -> None:
        connection = FakeConnection(kind="audio")
        outcome = multimodal_derive_handler(deps(connection, DeterministicMultimodalProvider()), Job("audio"))
        self.assertIs(outcome, HandlerOutcome.SUCCESS)
        self.assertEqual(len(connection.inserted), 1)
        row = connection.inserted[0]
        self.assertEqual(row[6], "audio")
        self.assertEqual(row[7], "asr")
        self.assertIn("分解者", row[8])
        # Derived text is never shown to anyone until a teacher reviews it.
        self.assertEqual(row[16], "unreviewed")
        self.assertEqual(row[17], "hidden")

    def test_recognizes_an_image_and_keeps_its_boxes_as_spans(self) -> None:
        connection = FakeConnection(kind="image")
        multimodal_derive_handler(deps(connection, DeterministicMultimodalProvider()), Job("image"))
        row = connection.inserted[0]
        self.assertEqual(row[7], "ocr")
        spans = json.loads(row[15])
        self.assertEqual(spans, [{"box": [0, 0, 240, 48]}])

    def test_the_same_derivation_twice_writes_the_same_artifact_id(self) -> None:
        first = FakeConnection()
        second = FakeConnection()
        provider = DeterministicMultimodalProvider()
        multimodal_derive_handler(deps(first, provider), Job("audio"))
        multimodal_derive_handler(deps(second, provider), Job("audio"))
        # The id is a digest of event, media, model and text, so a retry that
        # derived the same thing lands on the same row.
        self.assertEqual(first.inserted[0][0], second.inserted[0][0])

    def test_different_text_becomes_a_different_artifact_rather_than_a_silent_replacement(self) -> None:
        a = FakeConnection()
        b = FakeConnection()
        multimodal_derive_handler(deps(a, DeterministicMultimodalProvider()), Job("audio"))
        multimodal_derive_handler(
            deps(b, DeterministicMultimodalProvider(asr=AsrResult("完全不同的轉錄", 0.5))), Job("audio"),
        )
        self.assertNotEqual(a.inserted[0][0], b.inserted[0][0])


class RefusalTest(unittest.TestCase):
    def test_media_that_was_never_scanned_is_not_sent_anywhere(self) -> None:
        for state in ("pending", "uploaded", "processing"):
            connection = FakeConnection(state=state)
            with self.assertRaises(RetryableJobError) as raised:
                multimodal_derive_handler(deps(connection, DeterministicMultimodalProvider()), Job("audio"))
            self.assertIn("MULTIMODAL_MEDIA_NOT_READY", str(raised.exception))
            self.assertEqual(connection.inserted, [])

    def test_media_that_failed_scanning_is_terminal_not_retried(self) -> None:
        connection = FakeConnection(state="rejected")
        with self.assertRaises(TerminalJobError) as raised:
            multimodal_derive_handler(deps(connection, DeterministicMultimodalProvider()), Job("audio"))
        self.assertIn("MULTIMODAL_MEDIA_NOT_DERIVABLE", str(raised.exception))

    def test_media_belonging_to_another_room_is_refused(self) -> None:
        connection = FakeConnection(room=str(uuid4()))
        with self.assertRaises(TerminalJobError) as raised:
            multimodal_derive_handler(deps(connection, DeterministicMultimodalProvider()), Job("audio"))
        self.assertIn("MULTIMODAL_MEDIA_ROOM_MISMATCH", str(raised.exception))

    def test_an_absent_provider_is_never_an_empty_transcript(self) -> None:
        connection = FakeConnection()
        with self.assertRaises(RetryableJobError) as raised:
            multimodal_derive_handler(deps(connection, None), Job("audio"))
        self.assertIn("MULTIMODAL_PROVIDER_UNAVAILABLE", str(raised.exception))
        self.assertEqual(connection.inserted, [])

    def test_a_provider_failure_never_carries_its_message(self) -> None:
        class Failing(DeterministicMultimodalProvider):
            def transcribe(self, media):
                raise RuntimeError("provider echoed: 分解者让养分回到土壤")

        with self.assertRaises(RetryableJobError) as raised:
            multimodal_derive_handler(deps(FakeConnection(), Failing()), Job("audio"))
        self.assertIn("MULTIMODAL_PROVIDER_RUNTIMEERROR", str(raised.exception))
        self.assertNotIn("分解者", str(raised.exception))

    def test_empty_derived_text_is_refused_rather_than_stored(self) -> None:
        connection = FakeConnection()
        provider = DeterministicMultimodalProvider(asr=AsrResult("   ", 0.4))
        with self.assertRaises(TerminalJobError):
            multimodal_derive_handler(deps(connection, provider), Job("audio"))
        self.assertEqual(connection.inserted, [])

    def test_a_payload_with_an_unreviewed_modality_is_refused(self) -> None:
        for payload in (
            {"mediaId": MEDIA, "sourceEventId": EVENT, "modality": "video"},
            {"mediaId": MEDIA, "sourceEventId": EVENT, "modality": "text"},
            {"mediaId": MEDIA, "sourceEventId": EVENT},
            {"mediaId": MEDIA, "sourceEventId": EVENT, "modality": "audio", "extra": 1},
        ):
            with self.assertRaises(TerminalJobError):
                multimodal_derive_handler(deps(FakeConnection(), DeterministicMultimodalProvider()), Job(payload=payload))

    def test_a_missing_source_event_is_refused(self) -> None:
        connection = FakeConnection(event=False)
        with self.assertRaises(TerminalJobError) as raised:
            multimodal_derive_handler(deps(connection, DeterministicMultimodalProvider()), Job("audio"))
        self.assertIn("MULTIMODAL_SOURCE_EVENT_ABSENT", str(raised.exception))


class RegistrationTest(unittest.TestCase):
    def test_the_job_family_is_dispatched(self) -> None:
        registry = register_multimodal_handlers(HandlerRegistry())
        self.assertIs(registry.get("multimodal.derive.v1"), multimodal_derive_handler)


if __name__ == "__main__":
    unittest.main()
