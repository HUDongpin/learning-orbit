import unittest
from learning_orbit_worker.derived_text import derive_direct_text, maybe_derive_direct_text, derive_media_text


def event(text="太陽提供能量給生產者。", media_ids=()):
    return {"eventId":"e1","roomId":"r1","roomSeq":1,"type":"message.added","actorId":"s1","actorKind":"human","actorRole":"student","revision":1,"operation":"add","eventTime":"2026-08-28T09:00:00Z","ingestTime":"2026-08-28T09:00:01Z","payload":{"messageId":"m1","text":text,"mediaIds":list(media_ids),"replyTo":None,"mentions":[]}}


class DerivedTextTests(unittest.TestCase):
    def test_direct_text_is_immutable_and_hides_display(self):
        artifact = derive_direct_text(event())
        self.assertEqual(artifact.derivation, "direct")
        self.assertEqual(artifact.source_confidence_raw, 1.0)
        self.assertIsNone(artifact.source_confidence_calibrated)
        self.assertEqual(artifact.review_status, "unreviewed")
        self.assertFalse(artifact.spans)
        self.assertEqual(artifact.language_tag, "und")

    def test_media_only_and_agent_have_no_direct_artifact(self):
        self.assertIsNone(maybe_derive_direct_text(event("", ("media-1",))))
        agent = event("Nova 整理")
        agent["actorKind"] = "agent"
        self.assertIsNone(maybe_derive_direct_text(agent))

    def test_empty_direct_text_raises(self):
        with self.assertRaisesRegex(ValueError, "learner-authored"):
            derive_direct_text(event(""))

    def test_correction_requires_and_reuses_lineage(self):
        with self.assertRaisesRegex(ValueError, "predecessor"):
            derive_media_text(event(), "修正", media_id="m", modality="text", derivation="human_correction", provider="teacher", model_version="human-v1", confidence=1)
        corrected = derive_media_text(event(), "修正", media_id="m", modality="text", derivation="human_correction", provider="teacher", model_version="human-v1", confidence=1, supersedes_artifact_id="old", lineage_id="lineage")
        self.assertEqual(corrected.lineage_id, "lineage")
