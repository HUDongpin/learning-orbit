import unittest
from learning_orbit_worker.extractors import canonical_json, extract_echo
from learning_orbit_worker.reference.learning_orbit_algorithms_v1 import ChatEvent


class ExtractorTests(unittest.TestCase):
    def test_canonical_output_is_stable(self):
        event = ChatEvent("e1", "r1", "2026-08-28T09:00:00Z", "2026-08-28T09:00:01Z", "s1", "human", "text", "池塘中的太陽讓生產者獲得能量。")
        one, two = extract_echo(event), extract_echo(event)
        self.assertEqual(one["outputSha256"], two["outputSha256"])
        self.assertEqual(canonical_json(one["output"]), canonical_json(two["output"]))
        self.assertEqual(len(one["output"]["candidates"]), 1)

    @staticmethod
    def _candidates(text):
        event = ChatEvent("e1", "r1", "2026-08-28T09:00:00Z", "2026-08-28T09:00:01Z", "s1", "human", "text", text)
        return [
            (item["head"], item["linkPhrase"], item["tail"])
            for item in extract_echo(event)["output"]["candidates"]
        ]

    def test_verb_slot_no_longer_matches_the_consumers_noun(self):
        """extractor-p3-verb-boundary: 'consume' inside 'consumers' matched."""
        repeated = "Producers feed consumers. Producers feed consumers. Producers feed consumers."
        self.assertEqual(self._candidates(repeated), [("producers", "feed", "consumers")])

    def test_verb_slot_no_longer_matches_words_ending_in_the_verb(self):
        """A trailing boundary alone still let 'heat'/'meat'/'great' through."""
        for text in (
            "Consumers release heat, and producers capture energy.",
            "Consumers had a great chat with producers.",
            "Consumers prefer meat over what producers sell.",
            "Consumers defeat producers in the game.",
            "consumers overeat producers",
        ):
            with self.subTest(text=text):
                self.assertNotIn(
                    ("consumers", "consume", "producers"), self._candidates(text)
                )

    def test_consumption_relations_still_extract(self):
        for text in (
            "Consumers eat producers.",
            "Consumers consume producers.",
            "The consumer eats the producer.",
            "消費者吃生產者。",
        ):
            with self.subTest(text=text):
                self.assertIn(("consumers", "consume", "producers"), self._candidates(text))
