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

    def test_no_pattern_matches_a_verb_inside_another_word(self):
        """Every verb slot is bounded, not just pattern 3's."""
        for text in (
            "The sun forgives energy debts to producers.",       # gives
            "Producers read feedback from consumers.",            # feed
            "Producers cannot supportively help consumers.",      # support
            "Producers find consumers insupportable.",            # support
            "Decomposers make nonreturnable nutrients from soil.",  # return
            "Soil has an oversupply of nutrients for producers.",   # supply
            "Energy in unreleased form warms the heat sink.",       # released
        ):
            with self.subTest(text=text):
                self.assertEqual(self._candidates(text), [])

    def test_every_inflection_v1_0_accepted_still_matches(self):
        """The boundaries remove false positives without narrowing recall."""
        expected = {
            ("sun", "provides energy to", "producers"): (
                "The sun provides energy to producers.",
                "The sun provide energy to producers.",
                "The sun provided energy to producers.",
                "The sun gives energy to producers.",
                "The sun has given energy to producers.",
            ),
            ("producers", "feed", "consumers"): (
                "Producers feed consumers.",
                "Producers feeds consumers.",
                "Producers are feeding consumers.",
                "Producers support consumers.",
                "Producers supported consumers.",
                "Producers are supporting consumers.",
            ),
            ("consumers", "consume", "producers"): (
                "Consumers eat producers.",
                "Consumers eats producers.",
                "Consumers have eaten producers.",
                "Consumers are eating producers.",
                "Consumers consume producers.",
                "Consumers have consumed producers.",
            ),
            ("decomposers", "return nutrients to", "soil"): (
                "Decomposers return nutrients to soil.",
                "Decomposers returned nutrients to soil.",
                "Decomposers are returning nutrients to soil.",
                "Decomposers recycle nutrients to soil.",
                "Decomposers recycled nutrients to soil.",
            ),
            ("soil", "provides nutrients to", "producers"): (
                "Soil provides nutrients to producers.",
                "Soil provided nutrients to producers.",
                "Soil supplies nutrients to producers.",
                "Soil supplied nutrients to producers.",
            ),
            ("energy", "is released as", "heat"): (
                "Energy is lost as heat.",
                "Energy is released as heat.",
            ),
        }
        for edge, sentences in expected.items():
            for text in sentences:
                with self.subTest(text=text):
                    self.assertIn(edge, self._candidates(text))

    def test_traditional_chinese_branch_is_untouched(self):
        for text, edge in (
            ("太陽提供生產者能量。", ("sun", "provides energy to", "producers")),
            ("生產者供養消費者。", ("producers", "feed", "consumers")),
            ("消費者吃生產者。", ("consumers", "consume", "producers")),
            ("分解者把養分帶回土壤。", ("decomposers", "return nutrients to", "soil")),
            ("土壤養分給生產者。", ("soil", "provides nutrients to", "producers")),
            ("能量以熱散失。", ("energy", "is released as", "heat")),
        ):
            with self.subTest(text=text):
                self.assertIn(edge, self._candidates(text))

    def test_consumption_relations_still_extract(self):
        for text in (
            "Consumers eat producers.",
            "Consumers consume producers.",
            "The consumer eats the producer.",
            "消費者吃生產者。",
        ):
            with self.subTest(text=text):
                self.assertIn(("consumers", "consume", "producers"), self._candidates(text))
