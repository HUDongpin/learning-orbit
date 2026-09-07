"""The media branch of the deletion saga, which the server owns."""
import unittest
from types import SimpleNamespace

from learning_orbit_worker.core_handlers import RetryableJobError, TerminalJobError
from learning_orbit_worker.internal_http import InternalHttpError
from learning_orbit_worker.jobs import StaleClaim
from learning_orbit_worker.lifecycle import _verify_media_surface

DELETION = "77777777-7777-4777-8777-777777777777"


def claim():
    return SimpleNamespace(
        job_id="11111111-1111-4111-8111-111111111111",
        job_type="room.delete-surface.v1",
        room_id=None,
        source_event_id=None,
        dedupe_key=f"room.delete-surface.v1:{DELETION}:media",
        correlation_id="44444444-4444-4444-8444-444444444444",
        claim_generation="1",
        claim_token="22222222-2222-4222-8222-222222222222",
        worker_id="worker-a",
    )


def deps(response=None, error=None, sent=None, internal_http=True):
    def post(path, audience, body, job_claim):
        if sent is not None:
            sent.append({"path": path, "audience": audience, "body": body})
        if error is not None:
            raise error
        return SimpleNamespace(body=response)

    return SimpleNamespace(
        internal_http=SimpleNamespace(post=post) if internal_http else None,
    )


class MediaSurfaceVerificationTests(unittest.TestCase):
    def test_asks_the_surface_owner_with_the_complete_claim(self):
        sent = []
        _verify_media_surface(
            deps(response={"status": "completed", "surface": "media", "verifiedItemCount": 3}, sent=sent),
            claim(), DELETION,
        )
        self.assertEqual(sent[0]["path"], "/internal/lifecycle/media-surface")
        self.assertEqual(sent[0]["audience"], "internal.lifecycle.mediaSurface")
        self.assertEqual(sorted(sent[0]["body"]), [
            "claimGeneration", "claimToken", "correlationId", "dedupeKey", "deletionJobId",
            "jobId", "jobType", "roomId", "sourceEventId", "surface", "workerId",
        ])
        # This family is deliberately not room-scoped: later surfaces run after
        # the room row is already gone.
        self.assertIsNone(sent[0]["body"]["roomId"])
        self.assertEqual(sent[0]["body"]["surface"], "media")

    def test_a_redelivered_verification_is_accepted(self):
        _verify_media_surface(
            deps(response={"status": "already_verified", "surface": "media", "verifiedItemCount": 3}),
            claim(), DELETION,
        )

    def test_a_surface_the_owner_cannot_prove_gone_stays_retryable(self):
        for response in [
            {"status": "retryable", "code": "MEDIA_SURFACE_NOT_QUIESCENT", "notBefore": "2026-08-30T09:00:00Z"},
            {"status": "retryable", "code": "MEDIA_SURFACE_STORE_UNAVAILABLE", "notBefore": "2026-08-30T09:00:00Z"},
        ]:
            with self.subTest(code=response["code"]):
                with self.assertRaises(RetryableJobError):
                    _verify_media_surface(deps(response=response), claim(), DELETION)

    def test_no_route_at_all_is_retryable_rather_than_a_silent_pass(self):
        # A receipt must never be issued because the saga could not reach the
        # component that owns the surface.
        with self.assertRaises(RetryableJobError):
            _verify_media_surface(deps(internal_http=False), claim(), DELETION)

    def test_transport_trouble_retries_and_a_refusal_does_not(self):
        for code, expected in [
            ("INTERNAL_HTTP_TIMEOUT", RetryableJobError),
            ("INTERNAL_HTTP_TRANSPORT", RetryableJobError),
            ("INTERNAL_HTTP_STATUS", RetryableJobError),
            ("INTERNAL_HTTP_SUBJECT_INVALID", TerminalJobError),
        ]:
            with self.subTest(code=code):
                with self.assertRaises(expected):
                    _verify_media_surface(deps(error=InternalHttpError(code)), claim(), DELETION)

    def test_a_superseded_claim_gives_up_the_lease(self):
        with self.assertRaises(StaleClaim):
            _verify_media_surface(
                deps(response={"status": "rejected", "code": "JOB_CLAIM_STALE"}), claim(), DELETION,
            )

    def test_any_other_refusal_is_terminal(self):
        for response in [
            {"status": "rejected", "code": "LIFECYCLE_SURFACE_IDENTITY_INVALID"},
            {"status": "rejected", "code": "SERVICE_ASSERTION_INVALID"},
            None,
            {},
            {"status": "something_else"},
        ]:
            with self.subTest(response=response):
                with self.assertRaises(TerminalJobError):
                    _verify_media_surface(deps(response=response), claim(), DELETION)
