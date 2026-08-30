import threading
import unittest

from learning_orbit_worker.agent.context import build_context
from learning_orbit_worker.agent.contracts import AgentRunState, AgentTrigger, TriggerEvent
from learning_orbit_worker.agent.run import AgentRunner
from learning_orbit_worker.agent.trigger import AgentTriggerCoordinator, TriggerError
from learning_orbit_worker.providers.fixture import DeterministicFixtureProvider
from learning_orbit_worker.providers.multimodal import AsrResult, DeterministicMultimodalProvider, PrivateMedia
from learning_orbit_worker.agent.artifacts import build_asr_artifact, verify_evidence_span
from learning_orbit_worker.safety.policy import evaluate_agent_output


def message(event_id: str, seq: int, text: str, *, room: str = "room-1", operation: str = "add") -> dict:
    return {
        "eventId": event_id, "roomId": room, "roomSeq": seq, "type": "message.added",
        "actorId": f"student-{seq}", "actorKind": "human", "actorRole": "student",
        "revision": 1, "operation": operation, "eventTime": "2026-08-28T09:00:00Z",
        "ingestTime": "2026-08-28T09:00:01Z", "causationId": event_id,
        "correlationId": event_id, "payload": {"messageId": f"m-{seq}", "text": text, "replyTo": None, "mentions": []},
    }


class AgentShadowSliceTests(unittest.TestCase):
    def setUp(self):
        self.coordinator = AgentTriggerCoordinator(nova_actor_id="nova")
        self.event = TriggerEvent("e-1", "room-1", 4, "student-1", "human", ("nova",))
        self.coordinator.register_event(self.event)

    def test_explicit_trigger_is_idempotent_and_agent_cannot_recurse(self):
        request = AgentTrigger("room-1", "e-1", "student-1", "student")
        first, second = self.coordinator.request(request), self.coordinator.request(request)
        self.assertEqual(first.agent_run_id, second.agent_run_id)
        self.coordinator.register_event(TriggerEvent("e-agent", "room-1", 5, "nova", "agent", ()))
        with self.assertRaisesRegex(TriggerError, "AGENT_CANNOT_TRIGGER_AGENT"):
            self.coordinator.request(AgentTrigger("room-1", "e-agent", "teacher-1", "teacher"))

    def test_concurrent_retries_share_one_deterministic_run(self):
        request = AgentTrigger("room-1", "e-1", "student-1", "student")
        results = []
        barrier = threading.Barrier(8)

        def retry():
            barrier.wait()
            results.append(self.coordinator.request(request).agent_run_id)

        threads = [threading.Thread(target=retry) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(set(results)), 1)

    def test_one_active_run_and_cancel_disable_are_atomic_in_memory(self):
        run = self.coordinator.request(AgentTrigger("room-1", "e-1", "student-1", "student"))
        self.coordinator.transition(run.agent_run_id, AgentRunState.RUNNING)
        with self.assertRaisesRegex(TriggerError, "AGENT_RUN_ALREADY_ACTIVE"):
            self.coordinator.register_event(TriggerEvent("e-2", "room-1", 6, "student-2", "human", ("nova",)))
            self.coordinator.request(AgentTrigger("room-1", "e-2", "student-2", "student"))
        cancelled = self.coordinator.set_enabled("room-1", False)
        self.assertEqual(cancelled, (run.agent_run_id,))
        self.assertEqual(self.coordinator.get(run.agent_run_id).state, AgentRunState.CANCELLED)

    def test_trigger_requires_open_room(self):
        self.coordinator.set_room_status("room-1", "paused")
        with self.assertRaisesRegex(TriggerError, "ROOM_NOT_OPEN"):
            self.coordinator.request(AgentTrigger("room-1", "e-1", "student-1", "student"))

    def test_context_is_bounded_and_only_approved_artifacts_have_provenance(self):
        events = [message("e-1", 1, "太阳能进入系统"), message("e-2", 2, "这条会被撤回"), {
            **message("e-3", 3, "撤回", operation="retract"), "type": "message.retracted",
            "payload": {"messageId": "m-2"},
        }, message("e-4", 4, "分解者回到土壤")]
        context = build_context("room-1", events, through_seq=4, approved_artifacts=[
            {"artifactId": "a-1", "sourceEventId": "e-4", "text": "derived", "derivation": "asr", "reviewStatus": "approved"},
            {"artifactId": "a-2", "sourceEventId": "e-1", "text": "shadow", "derivation": "ocr", "reviewStatus": "unreviewed"},
        ])
        self.assertEqual([event.event_id for event in context.events], ["e-1", "e-4"])
        self.assertEqual(context.source_range, (1, 4))
        self.assertEqual([artifact.artifact_id for artifact in context.approved_artifacts], ["a-1"])

    def test_deterministic_provider_candidate_is_memory_only_and_idempotent(self):
        run = self.coordinator.request(AgentTrigger("room-1", "e-1", "student-1", "student"))
        context = build_context("room-1", [message("e-1", 1, "太阳能进入系统")], through_seq=1)
        provider = DeterministicFixtureProvider(["请找出", "你的证据。"])
        runner = AgentRunner(self.coordinator, provider)
        first = runner.execute(run, context)
        second = runner.execute(run, context)
        self.assertEqual(first.text, "请找出你的证据。")
        self.assertEqual(first.output_sha256, second.output_sha256)
        self.assertEqual(provider.calls, 1)
        self.assertEqual(first.source_event_ids, ("e-1",))

    def test_concurrent_execution_does_not_duplicate_provider_call(self):
        run = self.coordinator.request(AgentTrigger("room-1", "e-1", "student-1", "student"))
        context = build_context("room-1", [message("e-1", 1, "太阳能进入系统")], through_seq=1)
        provider = DeterministicFixtureProvider(["请说明证据。"])
        runner = AgentRunner(self.coordinator, provider)
        results = []
        threads = [threading.Thread(target=lambda: results.append(runner.execute(run, context))) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(provider.calls, 1)
        self.assertEqual({result.output_sha256 for result in results}, {results[0].output_sha256})

    def test_cancelled_provider_stream_never_returns_text(self):
        run = self.coordinator.request(AgentTrigger("room-1", "e-1", "student-1", "student"))
        context = build_context("room-1", [message("e-1", 1, "太阳能进入系统")], through_seq=1)
        provider = DeterministicFixtureProvider(["draft", " unsafe"])
        seen = 0
        def cancelled():
            nonlocal seen
            seen += 1
            return seen > 1
        result = AgentRunner(self.coordinator, provider).execute(run, context, cancelled=cancelled)
        self.assertEqual(result.state, AgentRunState.CANCELLED)
        self.assertEqual(result.text, "")

    def test_safety_policy_claim_ceiling(self):
        blocked = evaluate_agent_output("请公开同学的心理风险排名")
        self.assertEqual(blocked.action, "hold")
        self.assertEqual(blocked.reason_codes, ("FORBIDDEN_PERSONAL_INFERENCE",))
        warning = evaluate_agent_output("这个解释一定是正确的")
        self.assertEqual(warning.action, "warn")

    def test_multimodal_artifact_stays_teacher_shadow_with_lineage(self):
        media = PrivateMedia("media-1", "e-1", "audio", "a" * 64)
        provider = DeterministicMultimodalProvider(asr=AsrResult("不清楚", 0.31))
        artifact = build_asr_artifact(media, provider.transcribe(media), artifact_id="artifact-1", lineage_id="lineage-1", room_id="room-1")
        self.assertEqual((artifact.display_status, artifact.review_status), ("teacher_shadow", "unreviewed"))
        self.assertFalse(artifact.eligible_for_extraction)
        self.assertEqual(artifact.event_id, "e-1")

    def test_artifact_span_hash_mismatch_is_quarantined(self):
        with self.assertRaisesRegex(ValueError, "ARTIFACT_INTEGRITY_MISMATCH"):
            verify_evidence_span(text="太阳能", text_sha256="forged", start=0, end=3)


if __name__ == "__main__":
    unittest.main()
