"""Every branch of the room auto-close handler."""
import unittest
from types import SimpleNamespace

from learning_orbit_worker.core_handlers import (
    RetryableJobError,
    TerminalJobError,
    room_auto_close_handler,
)
from learning_orbit_worker.handler_registry import HandlerOutcome, WorkerClaim
from learning_orbit_worker.internal_http import InternalHttpError
from learning_orbit_worker.jobs import WorkerJob

ROOM = "33333333-3333-4333-8333-333333333333"
CLOSES_AT = "2026-08-30T08:45:00.000Z"


def job(payload=None, room_id=ROOM):
    return WorkerJob(
        job_id="11111111-1111-4111-8111-111111111111",
        job_type="room.auto-close.v1",
        room_id=room_id,
        source_event_id="55555555-5555-4555-8555-555555555555",
        dedupe_key="room.auto-close.v1:11111111-1111-4111-8111-111111111111",
        correlation_id="44444444-4444-4444-8444-444444444444",
        payload={"roomId": ROOM, "closesAt": CLOSES_AT} if payload is None else payload,
        attempts=1,
        claim_generation="1",
        claim_token="22222222-2222-4222-8222-222222222222",
        locked_by="worker-a",
    )


def deps(response=None, error=None, sent=None):
    def post(path, audience, body, claim):
        if sent is not None:
            sent.append({"path": path, "audience": audience, "body": body})
        if error is not None:
            raise error
        return SimpleNamespace(body=response)

    row = job()
    return SimpleNamespace(
        internal_http=SimpleNamespace(post=post),
        claim=WorkerClaim(
            row.job_id, row.job_type, row.room_id, row.source_event_id, row.dedupe_key,
            row.correlation_id, row.claim_generation, row.claim_token, row.locked_by,
        ),
    )


class AutoCloseHandlerTests(unittest.TestCase):
    def test_sends_the_complete_claim_and_the_deadline_it_was_given(self):
        sent = []
        room_auto_close_handler(
            deps(response={"status": "completed", "code": "ROOM_CLOSED"}, sent=sent), job(),
        )
        self.assertEqual(sent[0]["path"], "/internal/rooms/auto-close")
        self.assertEqual(sent[0]["audience"], "internal.rooms.autoClose")
        self.assertEqual(sorted(sent[0]["body"]), [
            "claimGeneration", "claimToken", "closesAt", "correlationId", "dedupeKey",
            "jobId", "jobType", "roomId", "sourceEventId", "workerId",
        ])
        self.assertEqual(sent[0]["body"]["closesAt"], CLOSES_AT)
        self.assertEqual(sent[0]["body"]["workerId"], "worker-a")

    def test_a_close_and_an_already_closed_room_are_both_success(self):
        for code in ["ROOM_CLOSED", "ALREADY_CLOSED"]:
            with self.subTest(code=code):
                self.assertIs(
                    room_auto_close_handler(deps(response={"status": "completed", "code": code}), job()),
                    HandlerOutcome.SUCCESS,
                )

    def test_a_room_not_yet_due_is_retryable_rather_than_a_failure(self):
        with self.assertRaises(RetryableJobError):
            room_auto_close_handler(
                deps(response={"status": "retryable", "code": "ROOM_CLOSE_NOT_DUE"}), job(),
            )

    def test_a_superseded_claim_gives_up_the_lease_instead_of_failing_the_job(self):
        # Another worker owns this job now; failing it would move work the new
        # owner is doing into a retry state.
        self.assertIs(
            room_auto_close_handler(
                deps(response={"status": "rejected", "code": "JOB_CLAIM_STALE"}), job(),
            ),
            HandlerOutcome.LOST_LEASE,
        )

    def test_any_other_rejection_is_terminal_and_keeps_its_code(self):
        with self.assertRaises(TerminalJobError) as raised:
            room_auto_close_handler(
                deps(response={"status": "rejected", "code": "ROOM_DELETION_IN_PROGRESS"}), job(),
            )
        self.assertEqual(raised.exception.code, "ROOM_DELETION_IN_PROGRESS")

    def test_a_response_off_contract_is_never_treated_as_success(self):
        for response in [None, {}, {"status": "completed"}, {"status": "completed", "code": "SOMETHING"}]:
            with self.subTest(response=response):
                with self.assertRaises(TerminalJobError):
                    room_auto_close_handler(deps(response=response), job())

    def test_transport_trouble_retries_while_a_refusal_does_not(self):
        for code, expected in [
            ("INTERNAL_HTTP_TIMEOUT", RetryableJobError),
            ("INTERNAL_HTTP_TRANSPORT", RetryableJobError),
            ("INTERNAL_HTTP_STATUS", RetryableJobError),
            ("INTERNAL_HTTP_SUBJECT_INVALID", TerminalJobError),
            ("INTERNAL_HTTP_PATH_INVALID", TerminalJobError),
        ]:
            with self.subTest(code=code):
                with self.assertRaises(expected):
                    room_auto_close_handler(deps(error=InternalHttpError(code)), job())

    def test_refuses_a_payload_that_does_not_match_its_own_job(self):
        for payload in [
            {},
            {"roomId": ROOM},
            {"closesAt": CLOSES_AT},
            {"roomId": "99999999-9999-4999-8999-999999999999", "closesAt": CLOSES_AT},
        ]:
            with self.subTest(payload=payload):
                with self.assertRaises(TerminalJobError):
                    room_auto_close_handler(deps(response={"status": "completed", "code": "ROOM_CLOSED"}), job(payload))

    def test_refuses_to_run_without_the_ports_it_needs(self):
        for missing in [{"internal_http": None}, {"claim": None}]:
            with self.subTest(missing=missing):
                broken = deps(response={"status": "completed", "code": "ROOM_CLOSED"})
                for name, value in missing.items():
                    setattr(broken, name, value)
                with self.assertRaises(TerminalJobError):
                    room_auto_close_handler(broken, job())
