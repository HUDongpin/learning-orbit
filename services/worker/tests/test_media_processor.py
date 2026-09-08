"""The media processor: read, scan, sanitize, report — in that order."""
import struct
import threading
import unittest
import zlib
from http.server import BaseHTTPRequestHandler, HTTPServer
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

from learning_orbit_worker.core_handlers import RetryableJobError, TerminalJobError
from learning_orbit_worker.generated.media_internal_outcome_v1 import (
    Request as MediaOutcomeRequest,
)
from learning_orbit_worker.handler_registry import HandlerOutcome
from learning_orbit_worker.internal_http import InternalResponse
from learning_orbit_worker.media.processor import MediaProcessor
from learning_orbit_worker.media.sanitize import sanitize_image
from learning_orbit_worker.media.scan import ScanResult, ScanUnavailable
from learning_orbit_worker.media.sigv4 import S3Credentials, authorization_headers, presign_url
from learning_orbit_worker.media.store import ObjectStoreError, PrivateObjectStore

from datetime import datetime, timezone

REPOSITORY = Path(__file__).resolve().parents[3]

ROOM = str(uuid4())
MEDIA = str(uuid4())
KEY = f"rooms/{ROOM}/media/{MEDIA}/original"


def derivative_key(kind: str) -> str:
    """The key `safeDerivativeObjectKey` in the server recomputes on download."""
    return f"rooms/{ROOM}/derivative/{MEDIA}/{kind}"


def chunk(name: bytes, payload: bytes) -> bytes:
    body = name + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


PNG = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
       + chunk(b"tEXt", b"Author\x00Student Name")
       + chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff"))
       + chunk(b"IEND", b""))

#: What the sanitizer produces from it, so a test can name the digest the
#: outcome has to carry rather than read it back out of the outcome.
SANITIZED_PNG = sanitize_image(PNG).data

#: What the fake ffmpeg runner below emits.
OPUS = b"OggS-opus-bytes"


class FakeCursor:
    def __init__(self, rows):
        self._rows = rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class FakeConnection:
    def __init__(self, *, kind="image", room=ROOM, object_key=KEY, digest=None, state="uploaded", mime=None):
        self.row = {
            "media_id": MEDIA, "room_id": room, "kind": kind, "state": state,
            "object_key": object_key, "sha256": digest if digest is not None else sha256(PNG).hexdigest(),
            "detected_mime": mime or ("image/png" if kind == "image" else "audio/mpeg"),
        }

    def execute(self, sql, params=()):
        assert "FROM media_asset" in sql
        return FakeCursor([self.row])


class Stored:
    def __init__(self, data):
        self.data = data
        self.sha256 = sha256(data).hexdigest()


class FakeStore:
    """A write-once bucket, keyed like the real one.

    Keys matter now: the retry path reads back the object it could not write,
    so a store that answered every key with the same bytes would hide exactly
    the mistake these tests exist to catch.
    """

    def __init__(self, data=PNG, put_error=None, get_error=None, existing=None):
        self.data = data
        self.put_error = put_error
        self.get_error = get_error
        self.written = []
        self.objects = {KEY: data}
        self.objects.update(existing or {})

    def get(self, key):
        if self.get_error:
            raise self.get_error
        if key not in self.objects:
            raise ObjectStoreError("MEDIA_STORE_OBJECT_ABSENT")
        return Stored(self.objects[key])

    def put(self, key, data, *, content_type, write_once=True):
        if self.put_error:
            raise self.put_error
        if write_once and key in self.objects:
            raise ObjectStoreError("MEDIA_STORE_ALREADY_WRITTEN")
        self.objects[key] = data
        self.written.append({"key": key, "bytes": len(data), "contentType": content_type, "writeOnce": write_once})
        return sha256(data).hexdigest()


class FakeScanner:
    def __init__(self, result=None, error=None):
        self.result = result or ScanResult(True, "MEDIA_SCAN_CLEAN")
        self.error = error
        self.calls = 0

    def scan(self, data):
        self.calls += 1
        if self.error:
            raise self.error
        return self.result


class FakeHttp:
    def __init__(self, body=None):
        self.body = body or {"status": "applied"}
        self.posts = []

    def post(self, path, audience, body, claim):
        self.posts.append({"path": path, "audience": audience, "body": body})
        return InternalResponse(200, self.body)


class Job:
    job_id = str(uuid4())
    room_id = ROOM
    dedupe_key = "media.process.v1:" + MEDIA
    correlation_id = str(uuid4())
    claim_generation = "1"
    claim_token = str(uuid4())


class Claim:
    worker_id = "worker-1"


def processor(connection=None, store=None, http=None, scanner=None, transcoder=None):
    return MediaProcessor(
        connection or FakeConnection(), store or FakeStore(), http or FakeHttp(),
        scanner=scanner or FakeScanner(), transcoder=transcoder,
    )


class ProcessorTest(unittest.TestCase):
    def test_a_clean_image_is_sanitized_written_once_and_reported_ready(self) -> None:
        store = FakeStore()
        http = FakeHttp()
        outcome = processor(store=store, http=http)(media_id=MEDIA, room_id=ROOM, claim=Claim(), job=Job())

        self.assertIs(outcome, HandlerOutcome.SUCCESS)
        self.assertEqual(len(store.written), 1)
        written = store.written[0]
        self.assertTrue(written["writeOnce"])
        self.assertEqual(written["key"], derivative_key("sanitized_image"))
        body = http.posts[0]["body"]
        self.assertEqual(http.posts[0]["path"], "/internal/media/outcome")
        self.assertEqual(body["state"], "ready")
        self.assertIsNone(body["failureCode"])
        self.assertEqual(body["derivatives"][0]["kind"], "sanitized_image")

    def test_bytes_that_are_not_the_committed_bytes_are_never_scanned(self) -> None:
        connection = FakeConnection(digest="f" * 64)
        scanner = FakeScanner()
        store = FakeStore()
        http = FakeHttp()
        processor(connection, store, http, scanner)(media_id=MEDIA, room_id=ROOM, claim=Claim(), job=Job())
        self.assertEqual(scanner.calls, 0)
        self.assertEqual(store.written, [])
        self.assertEqual(http.posts[0]["body"]["failureCode"], "MEDIA_CONTENT_HASH_MISMATCH")
        self.assertEqual(http.posts[0]["body"]["state"], "failed")

    def test_an_infected_upload_is_quarantined_and_no_copy_is_written(self) -> None:
        store = FakeStore()
        http = FakeHttp()
        scanner = FakeScanner(ScanResult(False, "MEDIA_SCAN_INFECTED", "Eicar-Test"))
        processor(store=store, http=http, scanner=scanner)(media_id=MEDIA, room_id=ROOM, claim=Claim(), job=Job())
        self.assertEqual(store.written, [])
        self.assertEqual(http.posts[0]["body"]["state"], "quarantined")

    def test_an_unscannable_upload_waits_rather_than_being_published(self) -> None:
        store = FakeStore()
        scanner = FakeScanner(error=ScanUnavailable("MEDIA_SCAN_UNREACHABLE"))
        with self.assertRaises(RetryableJobError) as raised:
            processor(store=store, scanner=scanner)(media_id=MEDIA, room_id=ROOM, claim=Claim(), job=Job())
        self.assertIn("MEDIA_SCAN_UNREACHABLE", str(raised.exception))
        self.assertEqual(store.written, [])

    def test_the_sanitized_copy_carries_no_student_name(self) -> None:
        store = FakeStore()
        processor(store=store)(media_id=MEDIA, room_id=ROOM, claim=Claim(), job=Job())
        # The written bytes are the stripped ones; the original is untouched.
        self.assertLess(store.written[0]["bytes"], len(PNG))

    def test_a_retry_after_a_lost_response_keeps_the_first_copy(self) -> None:
        store = FakeStore(existing={derivative_key("sanitized_image"): SANITIZED_PNG})
        http = FakeHttp()
        outcome = processor(store=store, http=http)(media_id=MEDIA, room_id=ROOM, claim=Claim(), job=Job())
        # Write-once means the first copy stands; the job still settles.
        self.assertIs(outcome, HandlerOutcome.SUCCESS)
        self.assertEqual(store.written, [])
        self.assertEqual(http.posts[0]["body"]["state"], "ready")

    def test_audio_without_a_transcoder_is_stated_not_published(self) -> None:
        http = FakeHttp()
        processor(FakeConnection(kind="audio"), http=http)(media_id=MEDIA, room_id=ROOM, claim=Claim(), job=Job())
        body = http.posts[0]["body"]
        self.assertEqual(body["state"], "failed")
        self.assertEqual(body["failureCode"], "MEDIA_TRANSCODER_UNAVAILABLE")

    def test_media_from_another_room_is_refused(self) -> None:
        with self.assertRaises(TerminalJobError) as raised:
            processor(FakeConnection(room=str(uuid4())))(media_id=MEDIA, room_id=ROOM, claim=Claim(), job=Job())
        self.assertIn("MEDIA_ASSET_ROOM_MISMATCH", str(raised.exception))

    def test_an_unpromoted_row_waits_instead_of_failing(self) -> None:
        connection = FakeConnection()
        connection.row["object_key"] = None
        with self.assertRaises(RetryableJobError) as raised:
            processor(connection)(media_id=MEDIA, room_id=ROOM, claim=Claim(), job=Job())
        self.assertIn("MEDIA_ASSET_NOT_STAGED", str(raised.exception))

    def test_a_stale_claim_reported_by_the_server_loses_the_lease(self) -> None:
        http = FakeHttp({"status": "rejected", "code": "JOB_CLAIM_STALE"})
        outcome = processor(http=http)(media_id=MEDIA, room_id=ROOM, claim=Claim(), job=Job())
        self.assertIs(outcome, HandlerOutcome.LOST_LEASE)

    def test_the_worker_never_writes_the_row_itself(self) -> None:
        http = FakeHttp()
        processor(http=http)(media_id=MEDIA, room_id=ROOM, claim=Claim(), job=Job())
        # Every state change goes through the signed route. A worker that could
        # write `ready` itself could publish an unscanned file with one wrong
        # line.
        self.assertEqual([post["audience"] for post in http.posts], ["internal.media.outcome"])


class OutcomeContractTest(unittest.TestCase):
    """What the worker POSTs, read back through the contract itself.

    `generated.media_internal_outcome_v1` is the executable copy of
    packages/contracts/schemas/media-internal-outcome.v1.json, pinned to that
    file's digest by the manifest parity test in
    test_internal_route_contracts.py. Parsing the emitted body with it is the
    schema speaking, not a restatement of it, and its object check is closed:
    one field too many fails exactly like one field too few.

    Every assertion below used to fail. The derivative carried `bytes` instead
    of `sizeBytes`, no `derivativeId` and no `mime` at all, an object key
    derived from the staging key rather than the server's layout, a kind
    (`normalised_audio`) outside the enum, and on the write-once retry an
    empty digest. The route answered MEDIA_OUTCOME_INVALID every time, so the
    row stayed at `uploaded` until the job dead-lettered.
    """

    CONTRACT_FIELDS = {"derivativeId", "kind", "objectKey", "mime", "sizeBytes", "sha256"}

    def image(self, store=None):
        http = FakeHttp()
        store = store if store is not None else FakeStore()
        outcome = processor(store=store, http=http)(media_id=MEDIA, room_id=ROOM, claim=Claim(), job=Job())
        return outcome, store, http

    def audio(self, store=None):
        from learning_orbit_worker.media.transcode import FfmpegTranscoder

        def run(_argv, _data, _timeout):
            return 0, OPUS, b"stderr from a container that quoted the upload"

        http = FakeHttp()
        store = store if store is not None else FakeStore()
        outcome = MediaProcessor(
            FakeConnection(kind="audio"), store, http,
            scanner=FakeScanner(), transcoder=FfmpegTranscoder(runner=run),
        )(media_id=MEDIA, room_id=ROOM, claim=Claim(), job=Job())
        return outcome, store, http

    def only_derivative(self, http):
        body = http.posts[0]["body"]
        parsed = MediaOutcomeRequest.from_dict(body)
        self.assertEqual(len(parsed.derivatives), 1)
        self.assertEqual(set(body["derivatives"][0]), self.CONTRACT_FIELDS)
        return parsed, parsed.derivatives[0]

    def test_the_image_outcome_is_the_shape_the_route_admits(self) -> None:
        _outcome, store, http = self.image()
        parsed, derivative = self.only_derivative(http)

        self.assertEqual(parsed.state, "ready")
        self.assertIsNone(parsed.failure_code)
        self.assertEqual(derivative.kind, "sanitized_image")
        self.assertEqual(derivative.object_key, derivative_key("sanitized_image"))
        self.assertEqual(derivative.mime, "image/png")
        self.assertEqual(derivative.size_bytes, len(SANITIZED_PNG))
        self.assertEqual(derivative.sha256, sha256(SANITIZED_PNG).hexdigest())
        # The server compares the reported mime against the stored object's
        # own content type, so the copy has to be written under it.
        self.assertEqual(store.written[0]["contentType"], derivative.mime)

    def test_the_audio_outcome_is_the_shape_the_route_admits(self) -> None:
        _outcome, store, http = self.audio()
        parsed, derivative = self.only_derivative(http)

        self.assertEqual(parsed.state, "ready")
        self.assertIsNone(parsed.failure_code)
        # `playback_audio` is the kind the download path looks for on a
        # non-image asset; `normalised_audio` is not in the contract's enum.
        self.assertEqual(derivative.kind, "playback_audio")
        self.assertEqual(derivative.object_key, derivative_key("playback_audio"))
        self.assertEqual(derivative.mime, "audio/ogg")
        self.assertEqual(derivative.size_bytes, len(OPUS))
        self.assertEqual(derivative.sha256, sha256(OPUS).hexdigest())
        self.assertEqual(store.written[0]["contentType"], derivative.mime)

    def test_the_object_key_is_the_layout_the_server_recomputes(self) -> None:
        # The server rebuilds this key on every download and refuses the row if
        # it does not match, so the layout is pinned to the file that owns it.
        layout = (REPOSITORY / "apps/server/src/modules/media/media-object-keys.ts").read_text()
        self.assertIn("rooms/${roomId}/derivative/${mediaId}/${kind}", layout)

        for kind, run in (("sanitized_image", self.image), ("playback_audio", self.audio)):
            with self.subTest(kind=kind):
                _outcome, _store, http = run()
                self.assertEqual(
                    http.posts[0]["body"]["derivatives"][0]["objectKey"],
                    f"rooms/{ROOM}/derivative/{MEDIA}/{kind}",
                )

    def test_the_write_once_retry_reports_the_digest_of_the_copy_that_stands(self) -> None:
        for kind, run, expected in (
            ("sanitized_image", self.image, SANITIZED_PNG),
            ("playback_audio", self.audio, OPUS),
        ):
            with self.subTest(kind=kind):
                store = FakeStore(existing={derivative_key(kind): expected})
                outcome, store, http = run(store)
                _parsed, derivative = self.only_derivative(http)
                self.assertIs(outcome, HandlerOutcome.SUCCESS)
                # Nothing was written; the digest is the stored copy's, read
                # back rather than left empty.
                self.assertEqual(store.written, [])
                self.assertEqual(derivative.sha256, sha256(expected).hexdigest())

    def test_a_stored_copy_that_is_not_this_copy_is_never_published(self) -> None:
        for kind, run in (("sanitized_image", self.image), ("playback_audio", self.audio)):
            with self.subTest(kind=kind):
                store = FakeStore(existing={derivative_key(kind): b"someone else's bytes"})
                with self.assertRaises(RetryableJobError) as raised:
                    run(store)
                self.assertIn("MEDIA_DERIVATIVE_CONFLICT", str(raised.exception))

    def test_a_copy_that_cannot_be_read_back_waits_instead_of_being_described(self) -> None:
        # The store says the key is taken but will not hand the object over.
        # There is no digest to report and no honest way to invent one.
        for kind, run in (("sanitized_image", self.image), ("playback_audio", self.audio)):
            with self.subTest(kind=kind):
                store = FakeStore(put_error=ObjectStoreError("MEDIA_STORE_ALREADY_WRITTEN"))
                with self.assertRaises(RetryableJobError) as raised:
                    run(store)
                self.assertIn("MEDIA_STORE_OBJECT_ABSENT", str(raised.exception))

    def test_a_terminal_failure_parses_and_carries_no_derivative(self) -> None:
        http = FakeHttp()
        scanner = FakeScanner(ScanResult(False, "MEDIA_SCAN_INFECTED", "Eicar-Test"))
        processor(http=http, scanner=scanner)(media_id=MEDIA, room_id=ROOM, claim=Claim(), job=Job())
        parsed = MediaOutcomeRequest.from_dict(http.posts[0]["body"])
        self.assertEqual(parsed.state, "quarantined")
        self.assertEqual(parsed.failure_code, "MEDIA_SCAN_INFECTED")
        self.assertEqual(parsed.derivatives, ())


class SignatureTest(unittest.TestCase):
    """Amazon's own published vectors, reproduced by this implementation."""

    CREDENTIALS = S3Credentials(
        "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1",
    )
    WHEN = datetime(2013, 5, 24, tzinfo=timezone.utc)

    def test_reproduces_the_published_presigned_get(self) -> None:
        url = presign_url(
            self.CREDENTIALS, "GET", "https://examplebucket.s3.amazonaws.com", "/test.txt",
            expires_seconds=86400, now=self.WHEN,
        )
        self.assertIn(
            "X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404", url,
        )

    def test_reproduces_the_published_signed_put(self) -> None:
        headers = authorization_headers(
            self.CREDENTIALS, "PUT", "examplebucket.s3.amazonaws.com", "/test$file.text",
            headers={"date": "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY"},
            payload_hash="44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
            now=self.WHEN,
        )
        self.assertIn(
            "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
            headers["Authorization"],
        )


class StoreTest(unittest.TestCase):
    def store(self, responses):
        calls = []

        def transport(url, method, headers, body, timeout):
            calls.append({"url": url, "method": method, "headers": dict(headers), "body": body})
            return responses.pop(0)

        instance = PrivateObjectStore(
            "http://127.0.0.1:9000", "private",
            S3Credentials("key", "secret", "us-east-1"), transport=transport,
        )
        return instance, calls

    def test_a_read_is_signed_and_hashed(self) -> None:
        instance, calls = self.store([(200, b"payload")])
        stored = instance.get("rooms/a/original")
        self.assertEqual(stored.sha256, sha256(b"payload").hexdigest())
        self.assertIn("Authorization", calls[0]["headers"])
        self.assertEqual(calls[0]["url"], "http://127.0.0.1:9000/private/rooms/a/original")

    def test_a_write_is_write_once(self) -> None:
        instance, calls = self.store([(200, b"")])
        instance.put("rooms/a/copy", b"data", content_type="image/png")
        self.assertEqual(calls[0]["headers"]["if-none-match"], "*")

    def test_a_second_write_to_the_same_key_is_refused(self) -> None:
        instance, _calls = self.store([(412, b"")])
        with self.assertRaises(ObjectStoreError) as raised:
            instance.put("rooms/a/copy", b"data", content_type="image/png")
        self.assertEqual(raised.exception.code, "MEDIA_STORE_ALREADY_WRITTEN")

    def test_a_key_that_could_climb_out_of_its_prefix_is_refused(self) -> None:
        instance, _calls = self.store([])
        for key in ("/absolute", "rooms/../other/original", ""):
            with self.assertRaises(ObjectStoreError) as raised:
                instance.get(key)
            self.assertEqual(raised.exception.code, "MEDIA_STORE_KEY_INVALID")

    def test_an_object_larger_than_the_ceiling_is_refused_not_streamed(self) -> None:
        instance, _calls = self.store([(200, b"x" * 32)])
        instance.max_bytes = 8
        with self.assertRaises(ObjectStoreError) as raised:
            instance.get("rooms/a/original")
        self.assertEqual(raised.exception.code, "MEDIA_STORE_OBJECT_TOO_LARGE")

    def test_an_unreachable_store_is_not_a_missing_object(self) -> None:
        def transport(*_args):
            raise OSError("connection refused")

        instance = PrivateObjectStore(
            "http://127.0.0.1:9000", "private",
            S3Credentials("key", "secret", "us-east-1"), transport=transport,
        )
        with self.assertRaises(ObjectStoreError) as raised:
            instance.get("rooms/a/original")
        self.assertEqual(raised.exception.code, "MEDIA_STORE_UNREACHABLE")


class StoreRedirectTest(unittest.TestCase):
    """The SigV4 header must not follow a redirect out of the bucket.

    The default transport used ``urlopen``, which follows a 30x and re-sends the
    request headers with it, so a redirecting endpoint collected the worker's
    ``Authorization`` header - and worse, ``get`` hashed whatever that host
    returned and handed it back as the stored object, so the substitution left
    no trace at this layer. Two real loopback servers stand in for the store
    because the behaviour under test belongs to the standard library: the proof
    is that the second server is never spoken to at all.
    """

    def setUp(self) -> None:
        self.reached: list[dict[str, str]] = []
        recorder = self.reached

        class _Target(BaseHTTPRequestHandler):
            def _answer(self) -> None:  # pragma: no cover - never reached
                length = int(self.headers.get("content-length") or 0)
                if length:
                    self.rfile.read(length)
                recorder.append({key.lower(): value for key, value in self.headers.items()})
                self.send_response(200)
                self.send_header("content-length", "8")
                self.end_headers()
                self.wfile.write(b"attacker")

            do_GET = _answer
            do_PUT = _answer

            def log_message(self, *_args) -> None:
                return None

        self.target = HTTPServer(("127.0.0.1", 0), _Target)
        target_url = f"http://127.0.0.1:{self.target.server_port}/private/rooms/a/original"

        class _Redirect(BaseHTTPRequestHandler):
            def _answer(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                if length:
                    self.rfile.read(length)
                self.send_response(307)
                self.send_header("location", target_url)
                self.send_header("content-length", "0")
                self.end_headers()

            do_GET = _answer
            do_PUT = _answer

            def log_message(self, *_args) -> None:
                return None

        self.redirect = HTTPServer(("127.0.0.1", 0), _Redirect)
        self.endpoint = f"http://127.0.0.1:{self.redirect.server_port}"
        self.threads = [
            threading.Thread(target=server.serve_forever, daemon=True)
            for server in (self.target, self.redirect)
        ]
        for thread in self.threads:
            thread.start()

    def tearDown(self) -> None:
        for server in (self.target, self.redirect):
            server.shutdown()
            server.server_close()
        for thread in self.threads:
            thread.join(timeout=5.0)
            self.assertFalse(thread.is_alive())

    def store(self) -> PrivateObjectStore:
        # No transport override: this exercises the shipped default.
        return PrivateObjectStore(
            self.endpoint, "private", S3Credentials("key", "secret", "us-east-1"),
        )

    def test_a_redirected_read_is_refused_and_never_returns_the_other_hosts_bytes(self) -> None:
        with self.assertRaises(ObjectStoreError) as raised:
            self.store().get("rooms/a/original")

        self.assertEqual(raised.exception.code, "MEDIA_STORE_READ_REFUSED")
        self.assertEqual(self.reached, [])

    def test_a_redirected_write_is_refused_before_the_signature_travels(self) -> None:
        with self.assertRaises(ObjectStoreError) as raised:
            self.store().put("rooms/a/copy", b"data", content_type="image/png")

        self.assertEqual(raised.exception.code, "MEDIA_STORE_WRITE_REFUSED")
        self.assertEqual(self.reached, [])


if __name__ == "__main__":
    unittest.main()


class TranscodeTest(unittest.TestCase):
    def runner(self, code=0, out=b"OggS-opus-bytes", error=None):
        seen = []

        def run(argv, data, timeout):
            seen.append({"argv": list(argv), "bytes": len(data), "timeout": timeout})
            if error:
                raise error
            return code, out, b"stderr from a container that quoted the upload"

        return run, seen

    def test_normalises_audio_to_one_format(self) -> None:
        from learning_orbit_worker.media.transcode import transcode_audio

        run, seen = self.runner()
        result = transcode_audio(b"input", "audio/mpeg", runner=run)
        self.assertEqual(result.content_type, "audio/ogg")
        argv = seen[0]["argv"]
        # A crafted container must not be able to make the decoder open a URL.
        self.assertIn("-protocol_whitelist", argv)
        self.assertEqual(argv[argv.index("-protocol_whitelist") + 1], "pipe")
        # The input format is asserted, not probed.
        self.assertEqual(argv[argv.index("-f") + 1], "mp3")
        # No path derived from user input is ever an argument.
        self.assertIn("pipe:0", argv)
        self.assertIn("pipe:1", argv)
        self.assertFalse(any("/" in item and item not in {"0:a:0"} for item in argv[1:]))

    def test_refuses_a_format_nobody_reviewed(self) -> None:
        from learning_orbit_worker.media.transcode import TranscodeError, transcode_audio

        run, seen = self.runner()
        for mime in ("video/mp4", "application/octet-stream", None, ""):
            with self.assertRaises(TranscodeError) as raised:
                transcode_audio(b"input", mime, runner=run)
            self.assertEqual(raised.exception.code, "MEDIA_TRANSCODE_FORMAT_UNSUPPORTED")
        # Refused before the decoder ever starts.
        self.assertEqual(seen, [])

    def test_a_decoder_failure_never_carries_its_stderr(self) -> None:
        from learning_orbit_worker.media.transcode import TranscodeError, transcode_audio

        run, _seen = self.runner(code=1)
        with self.assertRaises(TranscodeError) as raised:
            transcode_audio(b"input", "audio/wav", runner=run)
        self.assertEqual(raised.exception.code, "MEDIA_TRANSCODE_REJECTED")
        self.assertNotIn("quoted the upload", str(raised.exception))

    def test_a_missing_ffmpeg_is_stated_not_reported_as_a_bad_upload(self) -> None:
        from learning_orbit_worker.media.transcode import TranscodeError, transcode_audio

        run, _seen = self.runner(error=FileNotFoundError("ffmpeg"))
        with self.assertRaises(TranscodeError) as raised:
            transcode_audio(b"input", "audio/wav", runner=run)
        self.assertEqual(raised.exception.code, "MEDIA_TRANSCODE_UNAVAILABLE")

    def test_a_decompression_bomb_is_bounded(self) -> None:
        from learning_orbit_worker.media.transcode import TranscodeError, transcode_audio

        run, _seen = self.runner(out=b"x" * 64)
        with self.assertRaises(TranscodeError) as raised:
            transcode_audio(b"input", "audio/wav", runner=run, max_output_bytes=16)
        self.assertEqual(raised.exception.code, "MEDIA_TRANSCODE_OUTPUT_TOO_LARGE")

    def test_the_processor_publishes_the_normalised_copy(self) -> None:
        from learning_orbit_worker.media.transcode import FfmpegTranscoder

        run, _seen = self.runner(out=OPUS)
        store = FakeStore()
        http = FakeHttp()
        MediaProcessor(
            FakeConnection(kind="audio"), store, http,
            scanner=FakeScanner(), transcoder=FfmpegTranscoder(runner=run),
        )(media_id=MEDIA, room_id=ROOM, claim=Claim(), job=Job())
        self.assertEqual(store.written[0]["key"], derivative_key("playback_audio"))
        self.assertTrue(store.written[0]["writeOnce"])
        self.assertEqual(http.posts[0]["body"]["state"], "ready")
        self.assertEqual(http.posts[0]["body"]["derivatives"][0]["kind"], "playback_audio")
