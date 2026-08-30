import unittest

from learning_orbit_worker.generated.agent_internal_command_v1 import Request


class AgentInternalContractTests(unittest.TestCase):
    def setUp(self):
        self.value = {
            "jobId": "11111111-1111-4111-8111-111111111111",
            "jobType": "agent.execute.v1",
            "roomId": "22222222-2222-4222-8222-222222222222",
            "sourceEventId": "33333333-3333-4333-8333-333333333333",
            "dedupeKey": "agent.execute.v1:44444444-4444-4444-8444-444444444444",
            "agentRunId": "44444444-4444-4444-8444-444444444444",
            "correlationId": "55555555-5555-4555-8555-555555555555",
            "claimGeneration": "1",
            "claimToken": "66666666-6666-4666-8666-666666666666",
            "workerId": "worker-test",
            "text": "請找出證據。",
            "outputSha256": "a" * 64,
            "sourceEventIds": ["33333333-3333-4333-8333-333333333333"],
            "warningCodes": [],
        }

    def test_closed_and_bounded(self):
        parsed = Request.from_dict(self.value)
        self.assertEqual(parsed.job_type, "agent.execute.v1")
        with self.assertRaises(ValueError):
            Request.from_dict({**self.value, "provider": "secret"})
        with self.assertRaises(ValueError):
            Request.from_dict({**self.value, "sourceEventIds": [self.value["sourceEventIds"][0]] * 31})


if __name__ == "__main__":
    unittest.main()
