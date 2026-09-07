"""The worker's side of a signed internal call."""
import base64
import json
import unittest
from datetime import datetime, timezone

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from learning_orbit_worker.handler_registry import WorkerClaim
from learning_orbit_worker.internal_http import InternalHttpError, InternalServiceClient
from learning_orbit_worker.jobs import WorkerJob
from learning_orbit_worker.service_assertion import ServiceAssertionSigner


class FixedClock:
    def __init__(self, value):
        self.value = value

    def now(self):
        return self.value


def signer():
    return ServiceAssertionSigner.from_key(
        "worker-issuer", "key-1", Ed25519PrivateKey.generate(),
        FixedClock(datetime(2026, 8, 30, 1, 2, 3, tzinfo=timezone.utc)),
    )


def client(captured, response=(200, {"status": "completed", "code": "ROOM_CLOSED"})):
    def transport(url, payload, headers, timeout):
        captured.append({"url": url, "payload": payload, "headers": headers})
        return response

    return InternalServiceClient("http://127.0.0.1:3001", signer(), transport=transport)


def job(worker="worker-from-row"):
    return WorkerJob(
        job_id="11111111-1111-4111-8111-111111111111",
        job_type="room.auto-close.v1",
        room_id="33333333-3333-4333-8333-333333333333",
        source_event_id=None,
        dedupe_key="room.auto-close.v1:33333333-3333-4333-8333-333333333333",
        correlation_id="44444444-4444-4444-8444-444444444444",
        payload={},
        attempts=1,
        claim_generation="1",
        claim_token="22222222-2222-4222-8222-222222222222",
        locked_by=worker,
    )


def worker_claim(worker="worker-from-claim"):
    row = job()
    return WorkerClaim(
        row.job_id, row.job_type, row.room_id, row.source_event_id, row.dedupe_key,
        row.correlation_id, row.claim_generation, row.claim_token, worker,
    )


def envelope_of(assertion):
    padded = assertion + "=" * (-len(assertion) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))


class InternalServiceClientTests(unittest.TestCase):
    def test_signs_for_the_worker_named_by_either_claim_shape(self):
        # A handler is handed a WorkerClaim, never a WorkerJob row. Resolving
        # the subject by class rather than by field made every signed call from
        # a real worker raise AttributeError before it was ever sent.
        for claim, expected in [
            (job("worker-from-row"), "worker-from-row"),
            (worker_claim("worker-from-claim"), "worker-from-claim"),
        ]:
            with self.subTest(claim=type(claim).__name__):
                captured = []
                client(captured).post(
                    "/internal/rooms/auto-close", "internal.rooms.autoClose",
                    {"workerId": expected}, claim,
                )
                envelope = envelope_of(captured[0]["headers"]["X-LO-Service-Assertion"])
                self.assertEqual(envelope["subject"], expected)
                self.assertEqual(envelope["audience"], "internal.rooms.autoClose")

    def test_refuses_a_claim_that_names_no_worker(self):
        class Anonymous:
            pass

        with self.assertRaises(InternalHttpError):
            client([]).post("/internal/rooms/auto-close", "internal.rooms.autoClose", {}, Anonymous())

    def test_sends_the_assertion_in_exactly_one_header_and_no_query(self):
        captured = []
        client(captured).post(
            "/internal/rooms/auto-close", "internal.rooms.autoClose", {"a": 1}, worker_claim(),
        )
        sent = captured[0]
        self.assertEqual(sent["url"], "http://127.0.0.1:3001/internal/rooms/auto-close")
        self.assertNotIn("?", sent["url"])
        self.assertEqual(
            [name for name in sent["headers"] if "assert" in name.lower()],
            ["X-LO-Service-Assertion"],
        )
        # The body travels as canonical JSON, which is what the signature binds.
        self.assertEqual(sent["payload"], b'{"a":1}')

    def test_refuses_a_path_that_could_carry_its_own_target(self):
        for path in ["internal/rooms", "/internal/rooms?x=1", "/internal/rooms#f"]:
            with self.subTest(path=path):
                with self.assertRaises(InternalHttpError):
                    client([]).post(path, "internal.rooms.autoClose", {}, worker_claim())

    def test_refuses_an_origin_it_may_not_call(self):
        # A base path is refused one layer up, by WorkerConfig, which is where
        # LO_INTERNAL_BASE_ORIGIN is read; the client owns scheme and host.
        for origin in ["ftp://127.0.0.1", "not-a-url", ""]:
            with self.subTest(origin=origin):
                with self.assertRaises(ValueError):
                    InternalServiceClient(origin, signer())

    def test_turns_a_transport_failure_into_a_bounded_code(self):
        def failing(url, payload, headers, timeout):
            raise OSError("connect ECONNREFUSED 127.0.0.1:3001")

        with self.assertRaises(InternalHttpError) as raised:
            InternalServiceClient("http://127.0.0.1:3001", signer(), transport=failing).post(
                "/internal/rooms/auto-close", "internal.rooms.autoClose", {}, worker_claim(),
            )
        # Never the driver's message: it names a host and a port.
        self.assertEqual(raised.exception.code, "INTERNAL_HTTP_TRANSPORT")
        self.assertNotIn("127.0.0.1", str(raised.exception))
