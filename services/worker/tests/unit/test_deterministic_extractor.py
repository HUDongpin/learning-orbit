import unittest
from learning_orbit_worker.extractors import canonical_json, extract_echo
from learning_orbit_worker.reference.learning_orbit_algorithms_v1 import ChatEvent


class ExtractorTests(unittest.TestCase):
    def test_canonical_output_is_stable(self):
        event = ChatEvent("e1", "r1", "2026-08-28T09:00:00Z", "2026-08-28T09:00:01Z", "s1", "human", "text", "太陽提供能量給生產者。")
        one, two = extract_echo(event), extract_echo(event)
        self.assertEqual(one["outputSha256"], two["outputSha256"])
        self.assertEqual(canonical_json(one["output"]), canonical_json(two["output"]))
