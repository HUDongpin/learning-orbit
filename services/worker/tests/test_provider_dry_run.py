"""The keyless dry run: everything about the provider path that can be proven
before the credential exists.

The day the real credential arrives should be an observation, not a debugging
session. This module therefore drives the *real* pieces — the manifest loader,
the manifest-selected adapter, the SSE decoder, the durable executor — against
a committed example manifest and a replayed Anthropic Messages stream, so that
the only thing left untested on that day is whether the key itself is accepted.

Two invariants hold for every case below and are asserted rather than assumed:

* **No network.** Sockets and ``urlopen`` are trapped, not merely unused, and
  one case proves the trap fires so the others mean something.
* **No credential.** Every case that could depend on one clears the process
  environment outright and hands the adapter an explicit mapping carrying a
  placeholder that is a literal in this file and authenticates nothing.

Where the current behaviour is arguably wrong, the test documents what the code
actually does today and says so in a comment. A harness that asserts the
behaviour someone wishes for cannot tell anybody what will happen on the day.
"""
import contextlib
import importlib.util
import io
import json
import logging
import os
import re
import socket
import tempfile
import unittest
import urllib.error
import urllib.request
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from learning_orbit_worker.agent.executor import DurableAgentExecutor
from learning_orbit_worker.core_handlers import RetryableJobError
from learning_orbit_worker.handler_registry import HandlerOutcome
from learning_orbit_worker.internal_http import InternalResponse
from learning_orbit_worker.providers.anthropic import (
    ADAPTERS,
    AnthropicMessagesProvider,
    build_model_provider,
)
from learning_orbit_worker.providers.fixture import ProviderCancelled, ProviderError
from learning_orbit_worker.providers.manifest import (
    ProviderManifestError,
    load_provider_manifest,
    parse_provider_manifest,
)
from learning_orbit_worker.providers.model import ModelRequest

#: The committed example. It is a complete, valid manifest — the file a
#: deployment copies and edits — and it is loaded here through the same
#: ``load_provider_manifest`` the worker uses, from an absolute path, so the
#: example and the loader cannot drift apart unnoticed.
EXAMPLE_PATH = Path(__file__).resolve().parent / "resources" / "provider-manifest.example.json"

#: The operator-facing script this module is the harness for. It is loaded by
#: path because its filename is not an importable module name, and importing it
#: runs nothing but its constants and definitions.
SCRIPT_PATH = Path(__file__).resolve().parents[3] / "scripts" / "provider-dry-run.py"

#: Not a credential: a fixed literal, wrong shape, wrong length, committed on
#: purpose. Every case that needs the named variable to be *present* uses this.
PLACEHOLDER = "dry-run-placeholder-not-a-credential"

#: What a student asked and what the provider is replayed as answering. Both
#: are content: neither may reach a log record, stdout, stderr or an exception.
QUESTION = "分解者把落葉變成土壤，那沒有牠們會怎樣？"
ANSWER = "你觀察到哪些證據支持這個想法？"

ROOM = str(uuid4())
RUN = str(uuid4())
JOB = str(uuid4())
TRIGGER = str(uuid4())
CORRELATION = str(uuid4())
CLAIM_TOKEN = str(uuid4())


def example_bytes() -> bytes:
    return EXAMPLE_PATH.read_bytes()


def example_document() -> dict:
    return json.loads(example_bytes().decode("utf-8"))


def example_manifest():
    return load_provider_manifest(EXAMPLE_PATH)


def variant(**override):
    """The example manifest with fields replaced, parsed by the real parser."""
    return parse_provider_manifest(json.dumps({**example_document(), **override}).encode("utf-8"))


def env(credential=PLACEHOLDER):
    manifest = example_manifest()
    return {manifest.credential_env_var: credential} if credential is not None else {}


def dry_run_script():
    """Load ``scripts/provider-dry-run.py`` as a module without running it."""
    spec = importlib.util.spec_from_file_location("provider_dry_run_operator_script", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        # A script this harness cannot find is a defect in the pair, not a
        # reason to pass: there is nothing here to be lenient about.
        raise AssertionError("the operator script is not where this harness expects it")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# -- the replayed provider ---------------------------------------------------


def sse(*events) -> list[bytes]:
    """One realistic Anthropic Messages SSE frame per event.

    The wire carries an ``event:`` line, a ``data:`` line and a blank line for
    every frame. The existing adapter tests replay only the ``data:`` lines;
    replaying the whole frame is the point of a dry run, because a decoder that
    tripped over the other two lines would fail on the first real call.
    """
    lines: list[bytes] = []
    for event in events:
        lines.append(f"event: {event['type']}\n".encode("utf-8"))
        lines.append(
            ("data: " + json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
        )
        lines.append(b"\n")
    return lines


def delta(text: str) -> dict:
    return {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}


def full_message(*texts: str) -> list[bytes]:
    """A complete, successful stream: start, one text block, stop, [DONE]."""
    return sse(
        {"type": "message_start", "message": {
            "id": "msg_01DryRun", "type": "message", "role": "assistant",
            "model": "claude-sonnet-5", "content": [], "stop_reason": None,
            "usage": {"input_tokens": 214, "output_tokens": 1},
        }},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "ping"},
        *[delta(text) for text in texts],
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta",
         "delta": {"stop_reason": "end_turn", "stop_sequence": None},
         "usage": {"output_tokens": 37}},
        {"type": "message_stop"},
    ) + [b"data: [DONE]\n", b"\n"]


class ReplayTransport:
    """The injected transport: replays bytes, records the request, never dials."""

    def __init__(self, lines=(), raises=None):
        self.lines = list(lines)
        self.raises = raises
        self.calls = []
        self.closed = False

    def __call__(self, url, body, headers):
        self.calls.append({"url": url, "body": json.loads(body), "headers": dict(headers)})
        if self.raises is not None:
            raise self.raises
        transport = self

        class Stream:
            """Closing is explicit, the way closing a response is."""

            def __init__(self):
                self._lines = iter(transport.lines)

            def __iter__(self):
                return self

            def __next__(self):
                return next(self._lines)

            def close(self):
                transport.closed = True

        return Stream()


class MidStreamTransport(ReplayTransport):
    """Yields part of a stream and then fails the way a socket read does."""

    def __init__(self, lines, after, error):
        super().__init__(lines)
        self.after = after
        self.error = error

    def __call__(self, url, body, headers):
        self.calls.append({"url": url, "body": json.loads(body), "headers": dict(headers)})
        transport = self

        def stream():
            for index, line in enumerate(transport.lines):
                if index == transport.after:
                    raise transport.error
                yield line

        return stream()


def provider(lines=(), *, transport=None, manifest=None, credential=PLACEHOLDER):
    used = transport if transport is not None else ReplayTransport(lines)
    model = AnthropicMessagesProvider(
        manifest or example_manifest(),
        env=env(credential),
        transport=used,
    )
    return model, used


def request(**override):
    return ModelRequest(
        model_id=override.get("model_id", example_document()["modelId"]),
        system=override.get("system", "You are a Socratic facilitator."),
        messages=override.get("messages", ({"role": "user", "content": QUESTION},)),
        max_output_tokens=override.get("max_output_tokens", 256),
    )


# -- guards ------------------------------------------------------------------


class NetworkAttempted(AssertionError):
    """Raised in place of any real connection attempt."""


@contextlib.contextmanager
def no_network():
    """Trap every path out of the process, so "no network" is proven, not hoped."""

    def refuse(*_args, **_kwargs):
        raise NetworkAttempted("the dry-run harness attempted a network call")

    with patch.object(socket, "socket", refuse), \
            patch.object(socket, "create_connection", refuse), \
            patch.object(socket, "getaddrinfo", refuse), \
            patch.object(urllib.request, "urlopen", refuse):
        yield


class CapturingHandler(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.messages = []

    def emit(self, record):
        self.messages.append(record.getMessage() + " " + repr(getattr(record, "args", None)))


@contextlib.contextmanager
def captured_output():
    """Everything the path writes anywhere: log records, stdout, stderr."""
    handler = CapturingHandler()
    root = logging.getLogger()
    previous = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    out, err = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            yield handler.messages, out, err
    finally:
        root.removeHandler(handler)
        root.setLevel(previous)


# -- the example manifest ----------------------------------------------------


class ExampleManifestTest(unittest.TestCase):
    """The committed example is a real manifest, not a sketch of one."""

    def test_the_example_round_trips_through_the_real_loader(self):
        manifest = example_manifest()
        document = example_document()
        self.assertEqual(manifest.provider_id, document["providerId"])
        self.assertEqual(manifest.model_id, document["modelId"])
        self.assertEqual(manifest.region, document["region"])
        self.assertEqual(manifest.purpose, document["purpose"])
        self.assertEqual(manifest.display_name, document["displayName"])
        self.assertEqual(manifest.max_output_tokens, document["maxOutputTokens"])
        self.assertEqual(manifest.credential_env_var, document["credentialEnvVar"])
        self.assertEqual(manifest.remote_copy_mode, document["remoteCopyMode"])
        # The digest the server stores is the digest of these exact bytes.
        self.assertEqual(manifest.sha256, sha256(example_bytes()).hexdigest())
        self.assertRegex(manifest.sha256, r"^[0-9a-f]{64}$")

    def test_the_example_names_a_credential_it_does_not_carry(self):
        manifest = example_manifest()
        raw = example_bytes().decode("utf-8")
        self.assertEqual(manifest.credential_env_var, "LO_AGENT_PROVIDER_KEY")
        # Named, never carried: with nothing in the environment the manifest is
        # still complete and still refuses to pretend the provider is usable.
        self.assertFalse(manifest.credential_present({}))
        self.assertFalse(manifest.credential_present({manifest.credential_env_var: ""}))
        self.assertTrue(manifest.credential_present({manifest.credential_env_var: PLACEHOLDER}))
        for shape in ("sk-", "api-key", "secret", "token", "Bearer", "-----BEGIN"):
            self.assertNotIn(shape, raw, shape)

    def test_the_example_selects_the_adapter_this_build_implements(self):
        manifest = example_manifest()
        self.assertIn(manifest.provider_id, ADAPTERS)
        model = build_model_provider(manifest, env=env())
        self.assertIsInstance(model, AnthropicMessagesProvider)
        self.assertEqual(model.provider_id, "anthropic-messages-v1")

    def test_the_pinned_digest_follows_the_bytes_and_not_the_meaning(self):
        # A deployment pins a digest, not a document. Reformatting the same nine
        # values produces the same manifest and a different digest - which is
        # the intended behaviour, and the thing to know before a deploy edits
        # the file "harmlessly".
        pinned = example_manifest()
        reformatted = parse_provider_manifest(
            json.dumps(example_document(), indent=4, ensure_ascii=False).encode("utf-8")
        )
        self.assertEqual(reformatted.provider_id, pinned.provider_id)
        self.assertEqual(reformatted.model_id, pinned.model_id)
        self.assertEqual(reformatted.credential_env_var, pinned.credential_env_var)
        self.assertNotEqual(reformatted.sha256, pinned.sha256)

    def test_every_key_the_example_declares_is_required(self):
        document = example_document()
        self.assertEqual(len(document), 9)
        for key in sorted(document):
            with self.subTest(missing=key):
                without = {name: value for name, value in document.items() if name != key}
                with self.assertRaises(ProviderManifestError) as raised:
                    parse_provider_manifest(json.dumps(without).encode("utf-8"))
                self.assertEqual(raised.exception.code, "AGENT_PROVIDER_MANIFEST_INVALID")


# -- keyless and offline -----------------------------------------------------


class KeylessDryRunTest(unittest.TestCase):
    """The two properties that make this harness runnable on any machine."""

    def test_the_whole_path_runs_with_an_empty_process_environment(self):
        # Cleared, not merely ignored: if anything read os.environ for a key,
        # this would fail rather than silently pass on a developer's laptop.
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(os.environ.get("LO_AGENT_PROVIDER_KEY"))
            model, transport = provider(full_message(ANSWER))
            text = "".join(model.open_stream(model.prepare(request(), "invocation-1")))
        self.assertEqual(text, ANSWER)
        self.assertEqual(transport.calls[0]["headers"]["x-api-key"], PLACEHOLDER)

    def test_nothing_in_this_harness_opens_a_socket(self):
        with no_network():
            model, transport = provider(full_message(ANSWER))
            text = "".join(model.open_stream(model.prepare(request(), "invocation-1")))
        self.assertEqual(text, ANSWER)
        self.assertEqual(len(transport.calls), 1)

    def test_the_guard_would_notice_a_real_call(self):
        # Proving the trap works, so the assertion above means something.
        with no_network():
            with self.assertRaises(NetworkAttempted):
                socket.create_connection(("api.anthropic.com", 443))
            with self.assertRaises(NetworkAttempted):
                urllib.request.urlopen("https://api.anthropic.com/v1/messages")
        # And the adapter's own default transport is a real one: with no
        # injected transport it reaches for the network and is caught. The
        # trapped attempt surfaces as PROVIDER_FAILED, because the adapter
        # refuses to let any transport exception through as itself.
        model = AnthropicMessagesProvider(example_manifest(), env=env())
        with no_network(), self.assertRaises(ProviderError) as raised:
            model.open_stream(model.prepare(request(), "invocation-1"))
        self.assertEqual(raised.exception.code, "PROVIDER_FAILED")

    def test_an_absent_credential_stops_before_a_request_is_built(self):
        model, transport = provider(full_message(ANSWER), credential=None)
        with self.assertRaises(ProviderError) as raised:
            model.prepare(request(), "invocation-1")
        self.assertEqual(raised.exception.code, "CREDENTIAL_ABSENT")
        # Nothing was assembled and nothing was sent: an unconfigured provider
        # must not produce a request that could look like a real outage.
        self.assertEqual(transport.calls, [])


# -- the replayed stream -----------------------------------------------------


class StreamReplayTest(unittest.TestCase):
    def test_replays_a_full_message_stream_and_yields_only_the_visible_text(self):
        model, _ = provider(full_message("你觀察到", "哪些證據", "支持這個想法？"))
        chunks = list(model.open_stream(model.prepare(request(), "invocation-1")))
        # message_start, content_block_start, ping, content_block_stop,
        # message_delta (usage) and message_stop are housekeeping: they carry no
        # text and must not become chunks a student sees.
        self.assertEqual(chunks, ["你觀察到", "哪些證據", "支持這個想法？"])
        self.assertEqual("".join(chunks), ANSWER)

    def test_the_request_is_the_one_the_manifest_describes(self):
        model, transport = provider(full_message(ANSWER))
        list(model.open_stream(model.prepare(request(), "invocation-1")))
        sent = transport.calls[0]
        document = example_document()
        self.assertEqual(sent["url"], "https://api.anthropic.com/v1/messages")
        self.assertEqual(set(sent["body"]), {"model", "max_tokens", "system", "messages", "stream"})
        self.assertEqual(sent["body"]["model"], document["modelId"])
        self.assertEqual(sent["body"]["max_tokens"], 256)
        self.assertIs(sent["body"]["stream"], True)
        self.assertEqual(sorted(sent["headers"]), [
            "accept", "anthropic-client-request-id", "anthropic-version",
            "content-type", "x-api-key",
        ])
        self.assertEqual(sent["headers"]["anthropic-version"], "2023-06-01")
        self.assertEqual(sent["headers"]["accept"], "text/event-stream")
        # The credential is a header and only a header.
        self.assertNotIn(PLACEHOLDER, json.dumps(sent["body"], ensure_ascii=False))

    def test_an_unknown_frame_type_does_not_end_the_turn(self):
        # The API may add housekeeping events. A turn that failed because of one
        # would be a self-inflicted outage.
        model, _ = provider(
            sse({"type": "message_start", "message": {"id": "msg_1"}})
            + sse({"type": "some_future_event", "detail": {"anything": True}})
            + sse(delta(ANSWER), {"type": "message_stop"})
        )
        self.assertEqual(list(model.open_stream(model.prepare(request(), "invocation-1"))), [ANSWER])

    def test_a_mid_stream_error_ends_the_turn_with_a_bounded_code(self):
        # The provider can fail after it has already emitted text, and its error
        # message can quote the prompt back. Neither may escape.
        model, _ = provider(
            sse({"type": "message_start", "message": {"id": "msg_1"}}, delta("你觀察到"))
            + sse({"type": "error", "error": {"type": "overloaded_error", "message": QUESTION}})
        )
        stream = model.open_stream(model.prepare(request(), "invocation-1"))
        seen = []
        with self.assertRaises(ProviderError) as raised:
            for chunk in stream:
                seen.append(chunk)
        self.assertEqual(seen, ["你觀察到"])
        self.assertEqual(raised.exception.code, "PROVIDER_OVERLOADED")
        self.assertEqual(str(raised.exception), "PROVIDER_OVERLOADED")
        self.assertNotIn("分解者", repr(raised.exception.args))

    def test_a_non_200_never_carries_the_providers_body(self):
        for status, code in [
            (400, "PROVIDER_REQUEST_REJECTED"),
            (401, "PROVIDER_CREDENTIAL_REJECTED"),
            (403, "PROVIDER_CREDENTIAL_REJECTED"),
            (429, "PROVIDER_RATE_LIMITED"),
            (500, "PROVIDER_UNAVAILABLE"),
            (529, "PROVIDER_UNAVAILABLE"),
        ]:
            with self.subTest(status=status):
                # A real error body echoes the request; this one is built to.
                body = io.BytesIO(json.dumps({
                    "type": "error",
                    "error": {"type": "invalid_request_error", "message": QUESTION},
                }).encode("utf-8"))
                failure = urllib.error.HTTPError(
                    "https://api.anthropic.com/v1/messages", status, QUESTION, {}, body,
                )
                model, _ = provider(transport=ReplayTransport(raises=failure))
                with self.assertRaises(ProviderError) as raised:
                    model.open_stream(model.prepare(request(), "invocation-1"))
                self.assertEqual(raised.exception.code, code)
                self.assertNotIn("分解者", str(raised.exception))
                # `raise ... from None`: the provider's own exception is not
                # chained onto the one the caller sees.
                self.assertIsNone(raised.exception.__cause__)
                self.assertTrue(raised.exception.__suppress_context__)


class StreamFailureTest(unittest.TestCase):
    def test_a_malformed_event_is_refused_rather_than_guessed_at(self):
        for label, line in [
            ("truncated", b'data: {"type": "content_block_delta", "delta": {"text": "\n'),
            ("array", b"data: [1, 2, 3]\n"),
            ("string", b'data: "just a string"\n'),
            ("null", b"data: null\n"),
        ]:
            with self.subTest(label=label):
                model, _ = provider([line])
                with self.assertRaises(ProviderError) as raised:
                    list(model.open_stream(model.prepare(request(), "invocation-1")))
                self.assertEqual(raised.exception.code, "PROVIDER_STREAM_MALFORMED")

    def test_a_timeout_before_the_stream_opens_is_a_bounded_unreachable(self):
        for label, error in [
            ("read timeout", TimeoutError("timed out")),
            ("connect timeout", urllib.error.URLError(TimeoutError("timed out"))),
            ("no route", urllib.error.URLError("no route to host")),
        ]:
            with self.subTest(label=label):
                model, _ = provider(transport=ReplayTransport(raises=error))
                with self.assertRaises(ProviderError) as raised:
                    model.open_stream(model.prepare(request(), "invocation-1"))
                self.assertEqual(raised.exception.code, "PROVIDER_UNREACHABLE")

    def test_a_timeout_after_the_stream_opens_escapes_unbounded(self):
        # DOCUMENTED, NOT ENDORSED. `open_stream` wraps only the call that opens
        # the transport; `_decode` is a generator, so an exception raised while
        # the caller iterates - which is where a socket read timeout actually
        # happens - propagates as itself. It is not converted to a bounded
        # ProviderError, and the executor's `except ProviderError` does not
        # catch it. Reported for a decision rather than changed here.
        transport = MidStreamTransport(full_message(ANSWER), after=6, error=TimeoutError("timed out"))
        model, _ = provider(transport=transport)
        stream = model.open_stream(model.prepare(request(), "invocation-1"))
        with self.assertRaises(TimeoutError) as raised:
            list(stream)
        self.assertNotIsInstance(raised.exception, ProviderError)

    def test_cancellation_is_a_provider_error_so_one_handler_covers_both(self):
        # The executor has a single `except ProviderError`. Cancellation being a
        # subclass is what keeps a cancelled run from escaping it.
        self.assertTrue(issubclass(ProviderCancelled, ProviderError))
        seen = {"n": 0}

        def cancelled():
            seen["n"] += 1
            return seen["n"] > 4

        model, transport = provider(full_message("你觀察到", "哪些證據", "支持這個想法？"))
        with self.assertRaises(ProviderCancelled) as raised:
            list(model.open_stream(model.prepare(request(), "invocation-1"), cancelled=cancelled))
        self.assertEqual(raised.exception.code, "CANCELLED_BEFORE_FINAL")
        # A cancelled run stops costing tokens: the response is closed, not drained.
        self.assertTrue(transport.closed)

    def test_every_failure_this_harness_produces_is_a_bounded_code(self):
        conditions = {
            "unreviewed model": lambda: provider()[0].prepare(request(model_id="other"), "i-1"),
            "ceiling": lambda: provider()[0].prepare(request(max_output_tokens=9999), "i-1"),
            "no messages": lambda: provider()[0].prepare(request(messages=()), "i-1"),
            "bad role": lambda: provider()[0].prepare(
                request(messages=({"role": "system", "content": "x"},)), "i-1"),
            "no invocation id": lambda: provider()[0].prepare(request(), ""),
            "no credential": lambda: provider(credential=None)[0].prepare(request(), "i-1"),
            "stream error": lambda: list(provider(
                sse({"type": "error", "error": {"type": "rate_limit_error", "message": QUESTION}})
            )[0].open_stream(provider()[0].prepare(request(), "i-1"))),
            "malformed": lambda: list(provider([b"data: {\n"])[0].open_stream(
                provider()[0].prepare(request(), "i-1"))),
            "too large": lambda: list(provider(
                full_message("x" * 200_000) * 40
            )[0].open_stream(provider()[0].prepare(request(), "i-1"))),
        }
        codes = set()
        for label, condition in conditions.items():
            with self.subTest(condition=label):
                with self.assertRaises(ProviderError) as raised:
                    condition()
                code = raised.exception.code
                codes.add(code)
                self.assertRegex(code, r"^[A-Z][A-Z0-9_]{3,47}$")
                # A code is the whole message. Nothing about the room, the
                # student or the turn travels with it.
                self.assertEqual(str(raised.exception), code)
                self.assertNotIn("分解者", repr(raised.exception.args))
        self.assertEqual(len(codes), len(conditions) - 1)


# -- negative manifests ------------------------------------------------------


class NegativeManifestTest(unittest.TestCase):
    def test_an_adapter_this_build_does_not_implement_is_refused(self):
        # "Which model answered the students" must not have an implicit answer,
        # so there is no default adapter to fall back to.
        for provider_id in ("openai-chat-v1", "anthropic-messages-v2", "fixture-socratic-v1"):
            with self.subTest(provider_id=provider_id):
                self.assertNotIn(provider_id, ADAPTERS)
                with self.assertRaises(ProviderError) as raised:
                    build_model_provider(variant(providerId=provider_id), env=env())
                self.assertEqual(raised.exception.code, "PROVIDER_NOT_IMPLEMENTED")

    def test_a_digest_mismatch_is_visible_to_whoever_pinned_it(self):
        # There is no digest argument to the loader: the manifest carries the
        # digest of its own bytes and the comparison happens where the pin is
        # stored. What this asserts is that the value moves when the file does.
        pinned = example_manifest().sha256
        for label, changed in [
            ("region", variant(region="eu")),
            ("ceiling", variant(maxOutputTokens=511)),
            ("purpose", variant(purpose="socratic facilitation for a controlled classroom pilot ")),
        ]:
            with self.subTest(label=label):
                self.assertNotEqual(changed.sha256, pinned)
        self.assertEqual(parse_provider_manifest(example_bytes()).sha256, pinned)

    def test_a_manifest_carrying_an_inline_secret_is_refused(self):
        for field in ("displayName", "purpose", "region", "modelId"):
            with self.subTest(field=field):
                with self.assertRaises(ProviderManifestError) as raised:
                    variant(**{field: "sk-ant-api03-" + "A" * 80})
                self.assertEqual(raised.exception.code, "AGENT_PROVIDER_MANIFEST_SECRET_SUSPECTED")

    def test_the_secret_guard_is_a_shape_heuristic_and_not_a_proof(self):
        # DOCUMENTED, NOT ENDORSED. The guard refuses a long unbroken token; a
        # short one, or one containing a space, passes. It is a tripwire against
        # a pasted key, not a guarantee that the file holds no secret. The
        # guarantee is that the adapter reads its credential from the named
        # environment variable and never from the manifest.
        short = variant(displayName="sk-ant-" + "A" * 40)
        self.assertEqual(len(short.display_name), 47)
        self.assertNotEqual(short.credential_env_var, short.display_name)
        spaced = variant(purpose="key " + "A" * 80)
        self.assertTrue(spaced.purpose.startswith("key "))

    def test_delete_and_probe_is_accepted_by_the_worker_manifest_today(self):
        # DOCUMENTED, NOT ENDORSED - a governance contradiction, reported for a
        # human decision rather than resolved in a test. Three layers disagree:
        #   * ACCEPTS BOTH: providers/manifest.py REMOTE_COPY_MODES,
        #     anthropic.py's constructor, apps/server provider-manifest.ts
        #     REMOTE_COPY_MODES, and the external-authorization record's
        #     providerScope.remoteCopyMode union.
        #   * ACCEPTS ONE: provider-copy-authority-record.v1.json pins
        #     lifecycleMode to the const "no_persistent_copy_attested",
        #     migration 005 CHECKs the same single value, and
        #     governance-contract.test.ts asserts "delete_and_probe" throws.
        #   * IMPLEMENTS NEITHER SIDE OF delete_and_probe: no delete port, no
        #     probe, no provider-copy closure - the whole lifecycle Plan 04
        #     describes is absent from this repository.
        # This test states what the worker does today, so that whichever side is
        # corrected, the change is visible here.
        manifest = variant(remoteCopyMode="delete_and_probe")
        self.assertEqual(manifest.remote_copy_mode, "delete_and_probe")
        model = build_model_provider(manifest, env=env())
        self.assertIsInstance(model, AnthropicMessagesProvider)
        # A mode neither side reviewed is still refused by both.
        with self.assertRaises(ProviderManifestError) as raised:
            variant(remoteCopyMode="keeps_a_copy_forever")
        self.assertEqual(raised.exception.code, "AGENT_PROVIDER_MANIFEST_REMOTE_COPY_MODE")


# -- the whole path ----------------------------------------------------------


def message_event(seq: int, text: str) -> dict:
    return {
        "eventId": str(uuid4()), "roomId": ROOM, "roomSeq": seq,
        "type": "message.added", "actorId": str(uuid4()), "actorKind": "human",
        "actorRole": "student", "revision": 1, "operation": "add",
        "eventTime": "2026-09-07T10:00:00Z", "ingestTime": "2026-09-07T10:00:00Z",
        "causationId": str(uuid4()), "correlationId": CORRELATION,
        "payload": {"messageId": str(uuid4()), "text": text}, "schemaVersion": 1,
    }


class FakeCursor:
    def __init__(self, rows, rowcount=None):
        self._rows = rows
        self.rowcount = len(rows) if rowcount is None else rowcount

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class FakeConnection:
    """Answers only the queries the executor is expected to make."""

    def __init__(self):
        self.events = [message_event(1, QUESTION)]
        self.stored_prompt = None
        self.inserted = []

    def execute(self, sql, params=()):
        if "FROM agent_run" in sql:
            return FakeCursor([{
                "room_id": ROOM, "state": "queued",
                "input_from_room_seq": 1, "input_through_room_seq": 1,
            }])
        if "FROM room_event" in sql:
            return FakeCursor(self.events)
        if sql.startswith("INSERT INTO agent_prompt_artifact"):
            self.inserted.append(params)
            self.stored_prompt = params[3]
            return FakeCursor([], rowcount=1)
        if "SELECT prompt_sha256" in sql:
            return FakeCursor([{"prompt_sha256": self.stored_prompt}])
        raise AssertionError("unexpected query: " + sql[:60])


class FakeInternalHttp:
    def __init__(self, body=None):
        self.body = body if body is not None else {"status": "applied", "eventId": str(uuid4())}
        self.posts = []

    def post(self, path, audience, body, claim):
        self.posts.append({"path": path, "audience": audience, "body": body})
        return InternalResponse(200, self.body)


class Job:
    payload = {"agentRunId": RUN}
    job_id = JOB
    job_type = "agent.execute.v1"
    room_id = ROOM
    source_event_id = TRIGGER
    dedupe_key = "agent.execute.v1:" + RUN
    correlation_id = CORRELATION
    claim_generation = "1"
    claim_token = CLAIM_TOKEN
    attempt_cancelled = None


class Claim:
    worker_id = "worker-1"


class EndToEndDryRunTest(unittest.TestCase):
    """Manifest file, real adapter, replayed stream, real safety, signed route.

    Everything between the reviewed file on disk and the internal command is the
    production path. Only the socket is replaced.
    """

    def executor(self, transport, connection, http, manifest_loader=None):
        return DurableAgentExecutor(
            connection,
            http,
            env=env(),
            manifest_loader=manifest_loader or example_manifest,
            provider_factory=lambda manifest: AnthropicMessagesProvider(
                manifest, env=env(), transport=transport,
            ),
        )

    def test_one_run_goes_from_the_manifest_file_to_the_signed_route(self):
        connection, http = FakeConnection(), FakeInternalHttp()
        transport = ReplayTransport(full_message("你觀察到", "哪些證據", "支持這個想法？"))

        with patch.dict(os.environ, {}, clear=True), no_network():
            with captured_output() as (logs, out, err):
                outcome = self.executor(transport, connection, http)(job=Job(), claim=Claim())

        self.assertIs(outcome, HandlerOutcome.SUCCESS)
        posted = http.posts[0]["body"]
        self.assertEqual(http.posts[0]["path"], "/internal/agent/complete")
        self.assertEqual(posted["text"], ANSWER)
        self.assertEqual(posted["outputSha256"], sha256(ANSWER.encode("utf-8")).hexdigest())
        self.assertEqual(posted["agentRunId"], RUN)
        self.assertEqual(posted["warningCodes"], [])

        # The prompt reached the provider, and the run recorded which manifest
        # was in force rather than a copy of what it sent.
        sent = transport.calls[0]
        self.assertIn("分解者", sent["body"]["messages"][0]["content"])
        artifact = connection.inserted[0]
        self.assertIn(example_manifest().sha256, artifact)
        self.assertIn("anthropic-messages-v1", artifact)
        for value in artifact:
            self.assertNotIn("分解者", str(value))

        # Nothing about the turn was written anywhere else.
        written = " ".join(logs) + out.getvalue() + err.getvalue()
        for secret in ("分解者", "你觀察到", ANSWER, PLACEHOLDER):
            self.assertNotIn(secret, written)

    def test_a_provider_outage_is_the_runs_outcome_and_nothing_is_posted(self):
        connection, http = FakeConnection(), FakeInternalHttp()
        transport = ReplayTransport(
            sse({"type": "error", "error": {"type": "overloaded_error", "message": QUESTION}})
        )
        with patch.dict(os.environ, {}, clear=True), no_network():
            with captured_output() as (logs, out, err):
                with self.assertRaises(RetryableJobError) as raised:
                    self.executor(transport, connection, http)(job=Job(), claim=Claim())

        self.assertIn("AGENT_PROVIDER_OVERLOADED", str(raised.exception))
        self.assertNotIn("分解者", str(raised.exception))
        self.assertEqual(http.posts, [])
        written = " ".join(logs) + out.getvalue() + err.getvalue()
        for secret in ("分解者", PLACEHOLDER):
            self.assertNotIn(secret, written)

    def test_the_day_before_the_credential_arrives_a_run_retries_and_says_why(self):
        # The state the pilot is actually in right now, exercised rather than
        # assumed: the manifest is reviewed, the adapter is selected, the key is
        # not there yet. The run does not crash, does not fall back to a
        # fixture, and posts nothing; it fails with the same code the health
        # probe reports, and the job's own attempt budget bounds the retrying.
        connection, http = FakeConnection(), FakeInternalHttp()
        transport = ReplayTransport(full_message(ANSWER))
        executor = DurableAgentExecutor(
            connection, http, env={},
            manifest_loader=example_manifest,
            provider_factory=lambda manifest: AnthropicMessagesProvider(
                manifest, env={}, transport=transport,
            ),
        )
        with patch.dict(os.environ, {}, clear=True), no_network():
            with self.assertRaises(RetryableJobError) as raised:
                executor(job=Job(), claim=Claim())
        self.assertIn("AGENT_CREDENTIAL_ABSENT", str(raised.exception))
        self.assertEqual(transport.calls, [])
        self.assertEqual(http.posts, [])

    def test_a_delete_and_probe_manifest_completes_a_run_and_nothing_probes(self):
        # DOCUMENTED, NOT ENDORSED - the visible end of the contradiction above.
        # A manifest declaring the mode with no implementation behind it does
        # not fail closed: the run completes, classroom text reaches the
        # provider, and nothing in this repository ever deletes or probes the
        # remote copy. Recorded here so the day it is decided, the decision has
        # a test to change.
        connection, http = FakeConnection(), FakeInternalHttp()
        transport = ReplayTransport(full_message(ANSWER))
        with patch.dict(os.environ, {}, clear=True), no_network():
            outcome = self.executor(
                transport, connection, http,
                manifest_loader=lambda: variant(remoteCopyMode="delete_and_probe"),
            )(job=Job(), claim=Claim())
        self.assertIs(outcome, HandlerOutcome.SUCCESS)
        self.assertEqual(http.posts[0]["body"]["text"], ANSWER)
        self.assertEqual(len(transport.calls), 1)

    def test_the_prompt_artifact_names_the_manifest_that_was_in_force(self):
        connection, http = FakeConnection(), FakeInternalHttp()
        transport = ReplayTransport(full_message(ANSWER))
        with patch.dict(os.environ, {}, clear=True), no_network():
            self.executor(transport, connection, http)(job=Job(), claim=Claim())
        recorded = connection.inserted[0]
        manifest = example_manifest()
        self.assertIn(manifest.sha256, recorded)
        self.assertIn(manifest.model_id, recorded)
        self.assertIn(manifest.max_output_tokens, recorded)
        # The digest is what ties this run to a reviewed document; a run against
        # an unapproved manifest cannot be mistaken for an approved one.
        self.assertTrue(re.fullmatch(r"[0-9a-f]{64}", manifest.sha256))


# -- the operator's script ---------------------------------------------------


class OperatorScriptTest(unittest.TestCase):
    """What ``scripts/provider-dry-run.py`` tells the person who runs it.

    The manifest report is the one thing in this area a human reads instead of
    a gate, which is why it has to be true of the machine that human is
    standing at. A field that prints the same answer whatever the shell holds
    is worse than no field at all: it reads like an observation and is not one.

    Only the report is exercised here. ``main`` runs this very module, so a
    case that called it would run the suite inside the suite.
    """

    def setUp(self):
        self.script = dry_run_script()

    def report(self, path, present_at_start):
        """Run the report over one file and collect everything it wrote.

        The process environment is emptied for the call, so what the report
        says can only have come from the snapshot it was handed - which is the
        state the script itself is in by the time it reports.
        """
        with patch.dict(os.environ, {}, clear=True), captured_output() as (messages, out, err):
            outcome, named = self.script._report_manifest(str(path), present_at_start)
        return outcome, named, out.getvalue(), err.getvalue(), messages

    def test_presence_is_the_shell_the_operator_ran_and_not_the_mapping_we_emptied(self):
        # The example names LO_AGENT_PROVIDER_KEY, which the script clears so
        # the harness stays keyless. Reading presence from the live mapping
        # after that clearing hardwires "no" for precisely the variable the
        # operator is most likely to have just exported.
        manifest = example_manifest()
        with patch.dict(os.environ, {manifest.credential_env_var: PLACEHOLDER}, clear=True):
            snapshot = self.script._presence_snapshot(os.environ)
            for name in self.script.CREDENTIAL_VARIABLES:
                os.environ.pop(name, None)
            self.assertFalse(manifest.credential_present(os.environ))
            outcome, named, out, _err, _messages = self.report(EXAMPLE_PATH, snapshot)
        self.assertEqual(outcome, 0)
        self.assertIn(f"credentialEnvVar    {manifest.credential_env_var}", out)
        self.assertIn("credentialPresent   yes", out)
        # The name comes back so the caller can clear this one too.
        self.assertEqual(named, manifest.credential_env_var)

    def test_an_unset_or_empty_credential_is_reported_absent(self):
        manifest = example_manifest()
        for label, environment in [
            ("unset", {}),
            ("empty", {manifest.credential_env_var: ""}),
        ]:
            with self.subTest(label=label):
                with patch.dict(os.environ, environment, clear=True):
                    snapshot = self.script._presence_snapshot(os.environ)
                # An empty value is not a credential, and the snapshot does not
                # record it as one.
                self.assertNotIn(manifest.credential_env_var, snapshot)
                outcome, _named, out, _err, _messages = self.report(EXAMPLE_PATH, snapshot)
                self.assertEqual(outcome, 0)
                self.assertIn("credentialPresent   no", out)

    def test_the_value_reaches_neither_the_snapshot_nor_anything_written(self):
        manifest = example_manifest()
        with patch.dict(os.environ, {manifest.credential_env_var: PLACEHOLDER}, clear=True):
            snapshot = self.script._presence_snapshot(os.environ)
        # Presence is recorded as a fixed literal. The value is not copied even
        # into memory the report can reach, let alone printed.
        self.assertEqual(snapshot, {manifest.credential_env_var: self.script.PRESENT})
        self.assertNotIn(PLACEHOLDER, snapshot.values())
        _outcome, _named, out, err, messages = self.report(EXAMPLE_PATH, snapshot)
        for written in (out, err, " ".join(messages)):
            self.assertNotIn(PLACEHOLDER, written)

    def test_a_manifest_naming_a_variable_this_script_does_not_list_is_reported_truthfully(self):
        # CREDENTIAL_VARIABLES is not the set of names a manifest may use. A
        # third name has to be reported as the shell has it, and handed back,
        # so the caller can clear it before a harness that must need no key.
        other = "LO_OTHER_PROVIDER_KEY"
        self.assertNotIn(other, self.script.CREDENTIAL_VARIABLES)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "provider-manifest.json"
            document = {**example_document(), "credentialEnvVar": other}
            path.write_bytes(json.dumps(document).encode("utf-8"))
            with patch.dict(os.environ, {other: PLACEHOLDER}, clear=True):
                snapshot = self.script._presence_snapshot(os.environ)
            outcome, named, out, _err, _messages = self.report(path, snapshot)
        self.assertEqual((outcome, named), (0, other))
        self.assertIn(f"credentialEnvVar    {other}", out)
        self.assertIn("credentialPresent   yes", out)

    def test_a_file_the_loader_refuses_names_nothing_and_fails_with_its_code(self):
        with tempfile.TemporaryDirectory() as directory:
            outcome, named, out, err, _messages = self.report(Path(directory) / "absent.json", {})
        self.assertEqual(outcome, 2)
        # Nothing loaded, so nothing is asserted about a provider and no
        # variable is named: a refused file reports the code and stops.
        self.assertIsNone(named)
        self.assertEqual(out, "")
        self.assertEqual(err.strip(), "AGENT_PROVIDER_MANIFEST_UNREADABLE")

    def test_the_echoed_manifest_fields_are_only_shape_checked_by_the_loader(self):
        # DOCUMENTED, NOT ENDORSED, and the reason the script's docstring now
        # claims no more than this. modelId and region are echoed because a
        # deployment has to check them; the loader validates them only as
        # strings of at most 160 characters, refusing a value over 60 that
        # holds no space (manifest.py). A shorter key-shaped token in either
        # field is therefore printed. What holds either way is the other rule:
        # the credential is read from the named environment variable, never
        # from the manifest, and its value is never printed.
        pasted = "sk-ant-" + "A" * 40
        self.assertLessEqual(len(pasted), 60)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "provider-manifest.json"
            path.write_bytes(json.dumps({**example_document(), "modelId": pasted}).encode("utf-8"))
            outcome, _named, out, _err, _messages = self.report(path, {})
        self.assertEqual(outcome, 0)
        self.assertIn(pasted, out)
        # displayName and purpose are echoed by nothing, which is what the
        # docstring says and the whole of what it says.
        document = example_document()
        self.assertNotIn(document["displayName"], out)
        self.assertNotIn(document["purpose"], out)


if __name__ == "__main__":
    unittest.main()
