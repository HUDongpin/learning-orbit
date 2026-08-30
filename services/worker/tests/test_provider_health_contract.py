import unittest

from learning_orbit_worker.generated.agent_provider_health_v1 import Request


class ProviderHealthContractTests(unittest.TestCase):
    def test_closed_probe_and_no_room_scope(self):
        value = {
            "probeId": "11111111-1111-4111-8111-111111111111",
            "providerId": "fixture",
            "manifestSha256": "a" * 64,
            "health": "healthy",
            "checkedAt": "2026-08-30T08:00:00Z",
            "reasonCode": None,
        }
        self.assertEqual(Request.from_dict(value).provider_id, "fixture")
        with self.assertRaises(ValueError):
            Request.from_dict({**value, "roomId": value["probeId"]})
        with self.assertRaises(ValueError):
            Request.from_dict({**value, "health": "unknown"})


if __name__ == "__main__":
    unittest.main()
