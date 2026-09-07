"""The reviewed Anthropic Messages adapter behind the provider manifest."""
import json
import unittest
import urllib.error
from dataclasses import replace

from learning_orbit_worker.providers.anthropic import (
    AnthropicMessagesProvider,
    build_model_provider,
)
from learning_orbit_worker.providers.fixture import ProviderCancelled, ProviderError
from learning_orbit_worker.providers.manifest import parse_provider_manifest
from learning_orbit_worker.providers.model import ModelRequest

MANIFEST = {
    "schemaVersion": 1,
    "providerId": "anthropic-messages-v1",
    "displayName": "Anthropic Messages",
    "modelId": "claude-sonnet-5",
    "region": "us",
    "purpose": "socratic facilitation for a controlled classroom pilot",
    "maxOutputTokens": 512,
    "credentialEnvVar": "LO_AGENT_PROVIDER_KEY",
    "remoteCopyMode": "no_persistent_copy_attested",
}
KEY = "sk-not-a-real-key-0123456789"
ENV = {"LO_AGENT_PROVIDER_KEY": KEY}


def manifest(**override):
    return parse_provider_manifest(json.dumps({**MANIFEST, **override}).encode("utf-8"))


def sse(*events: dict) -> list[bytes]:
    return [f"data: {json.dumps(event)}\n".encode("utf-8") for event in events]


def delta(text: str) -> dict:
    return {"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}}


class RecordingTransport:
    def __init__(self, lines):
        self.lines = list(lines)
        self.calls = []
        self.closed = False

    def __call__(self, url, body, headers):
        self.calls.append({"url": url, "body": json.loads(body), "headers": dict(headers)})
        transport = self

        class Stream:
            def __init__(self):
                self._iter = iter(transport.lines)

            def __iter__(self):
                return self

            def __next__(self):
                return next(self._iter)

            def close(self):
                transport.closed = True

        return Stream()


def provider(lines=(), **kwargs):
    transport = RecordingTransport(lines)
    kwargs.setdefault("env", ENV)
    return AnthropicMessagesProvider(kwargs.pop("manifest", manifest()), transport=transport, **kwargs), transport


def request(**override):
    return ModelRequest(
        model_id=override.get("model_id", "claude-sonnet-5"),
        system=override.get("system", "You are a Socratic facilitator."),
        messages=override.get("messages", ({"role": "user", "content": "為什麼森林需要分解者？"},)),
        max_output_tokens=override.get("max_output_tokens", 256),
    )


class PreparationTest(unittest.TestCase):
    def test_accepts_a_call_the_manifest_describes(self) -> None:
        model, _ = provider()
        call = model.prepare(request(), "invocation-1")
        self.assertEqual(call.provider_invocation_id, "invocation-1")

    def test_refuses_a_model_the_review_never_saw(self) -> None:
        model, _ = provider()
        with self.assertRaises(ProviderError) as raised:
            model.prepare(request(model_id="some-other-model"), "invocation-1")
        self.assertEqual(raised.exception.code, "MODEL_NOT_IN_MANIFEST")

    def test_refuses_more_output_than_was_reviewed(self) -> None:
        model, _ = provider()
        with self.assertRaises(ProviderError) as raised:
            model.prepare(request(max_output_tokens=4096), "invocation-1")
        self.assertEqual(raised.exception.code, "MODEL_OUTPUT_CEILING_EXCEEDED")

    def test_reports_an_absent_credential_the_way_the_health_probe_does(self) -> None:
        model = AnthropicMessagesProvider(manifest(), env={}, transport=RecordingTransport([]))
        with self.assertRaises(ProviderError) as raised:
            model.prepare(request(), "invocation-1")
        self.assertEqual(raised.exception.code, "CREDENTIAL_ABSENT")

    def test_refuses_a_plaintext_endpoint_even_locally(self) -> None:
        # A provider call carries classroom text off this machine.
        with self.assertRaises(ProviderError) as raised:
            AnthropicMessagesProvider(manifest(), env=ENV, endpoint="http://api.anthropic.com")
        self.assertEqual(raised.exception.code, "PROVIDER_ENDPOINT_INSECURE")

    def test_refuses_a_copy_mode_no_one_reviewed(self) -> None:
        unreviewed = replace(manifest(), remote_copy_mode="keeps_a_copy_forever")
        with self.assertRaises(ProviderError) as raised:
            AnthropicMessagesProvider(unreviewed, env=ENV)
        self.assertEqual(raised.exception.code, "PROVIDER_COPY_MODE_UNREVIEWED")


class SelectionTest(unittest.TestCase):
    def test_the_manifest_chooses_the_adapter(self) -> None:
        model = build_model_provider(manifest(), env=ENV)
        self.assertIsInstance(model, AnthropicMessagesProvider)
        self.assertEqual(model.provider_id, "anthropic-messages-v1")

    def test_an_unimplemented_provider_never_falls_back_to_a_default(self) -> None:
        # "Which model answered the students" must not have an implicit answer.
        with self.assertRaises(ProviderError) as raised:
            build_model_provider(manifest(providerId="some-other-vendor"), env=ENV)
        self.assertEqual(raised.exception.code, "PROVIDER_NOT_IMPLEMENTED")


class StreamingTest(unittest.TestCase):
    def test_yields_only_the_text_deltas(self) -> None:
        model, transport = provider(sse(
            {"type": "message_start", "message": {"id": "msg_1"}},
            {"type": "content_block_start", "index": 0},
            delta("你觀察到"),
            {"type": "ping"},
            delta("什麼？"),
            {"type": "message_stop"},
        ))
        chunks = list(model.open_stream(model.prepare(request(), "invocation-1")))
        self.assertEqual(chunks, ["你觀察到", "什麼？"])

    def test_sends_the_credential_as_a_header_and_never_in_the_body(self) -> None:
        model, transport = provider(sse(delta("ok")))
        list(model.open_stream(model.prepare(request(), "invocation-1")))
        sent = transport.calls[0]
        self.assertEqual(sent["headers"]["x-api-key"], KEY)
        self.assertEqual(sent["headers"]["anthropic-version"], "2023-06-01")
        self.assertEqual(sent["headers"]["anthropic-client-request-id"], "invocation-1")
        self.assertNotIn(KEY, json.dumps(sent["body"]))
        # The invocation id correlates the two sides; nothing about the room,
        # the students or the session goes with it.
        self.assertEqual(set(sent["body"]), {"model", "max_tokens", "system", "messages", "stream"})

    def test_a_rotated_credential_takes_effect_without_a_new_provider(self) -> None:
        env = dict(ENV)
        model = AnthropicMessagesProvider(manifest(), env=env, transport=RecordingTransport(sse(delta("ok"))))
        env["LO_AGENT_PROVIDER_KEY"] = "sk-rotated"
        transport = RecordingTransport(sse(delta("ok")))
        model._transport = transport  # noqa: SLF001 - exercising the read-at-call-time rule
        list(model.open_stream(model.prepare(request(), "invocation-1")))
        self.assertEqual(transport.calls[0]["headers"]["x-api-key"], "sk-rotated")

    def test_cancellation_stops_the_stream_and_closes_the_response(self) -> None:
        calls = {"n": 0}

        def cancelled() -> bool:
            calls["n"] += 1
            return calls["n"] > 2

        model, transport = provider(sse(delta("a"), delta("b"), delta("c"), delta("d")))
        stream = model.open_stream(model.prepare(request(), "invocation-1"), cancelled=cancelled)
        with self.assertRaises(ProviderCancelled):
            list(stream)
        # A cancelled run must stop costing tokens, which means closing the
        # response rather than draining it.
        self.assertTrue(transport.closed)

    def test_an_already_cancelled_run_never_reaches_the_provider(self) -> None:
        model, transport = provider(sse(delta("a")))
        call = model.prepare(request(), "invocation-1")
        with self.assertRaises(ProviderCancelled):
            list(model.open_stream(call, cancelled=lambda: True))
        self.assertEqual(transport.calls, [])


class FailureTest(unittest.TestCase):
    def test_a_provider_error_event_becomes_a_bounded_code(self) -> None:
        for kind, code in [
            ("authentication_error", "PROVIDER_CREDENTIAL_REJECTED"),
            ("rate_limit_error", "PROVIDER_RATE_LIMITED"),
            ("overloaded_error", "PROVIDER_OVERLOADED"),
            ("something_new", "PROVIDER_FAILED"),
        ]:
            model, _ = provider(sse({"type": "error", "error": {"type": kind, "message": "為什麼森林需要分解者？"}}))
            with self.assertRaises(ProviderError) as raised:
                list(model.open_stream(model.prepare(request(), "invocation-1")))
            self.assertEqual(raised.exception.code, code)
            # A provider error can quote the prompt it was sent. None of it
            # reaches the exception.
            self.assertNotIn("森林", str(raised.exception))

    def test_http_failures_map_to_codes_without_a_response_body(self) -> None:
        for status, code in [(401, "PROVIDER_CREDENTIAL_REJECTED"), (429, "PROVIDER_RATE_LIMITED"),
                             (503, "PROVIDER_UNAVAILABLE"), (400, "PROVIDER_REQUEST_REJECTED")]:
            def refuse(_url, _body, _headers, status=status):
                raise urllib.error.HTTPError("https://api.anthropic.com", status, "no", {}, None)

            model = AnthropicMessagesProvider(manifest(), env=ENV, transport=refuse)
            with self.assertRaises(ProviderError) as raised:
                model.open_stream(model.prepare(request(), "invocation-1"))
            self.assertEqual(raised.exception.code, code)

    def test_an_unreachable_provider_is_not_a_rejected_one(self) -> None:
        def unreachable(_url, _body, _headers):
            raise urllib.error.URLError("no route")

        model = AnthropicMessagesProvider(manifest(), env=ENV, transport=unreachable)
        with self.assertRaises(ProviderError) as raised:
            model.open_stream(model.prepare(request(), "invocation-1"))
        self.assertEqual(raised.exception.code, "PROVIDER_UNREACHABLE")

    def test_malformed_stream_data_fails_rather_than_being_guessed_at(self) -> None:
        model, _ = provider([b"data: {not json\n"])
        with self.assertRaises(ProviderError) as raised:
            list(model.open_stream(model.prepare(request(), "invocation-1")))
        self.assertEqual(raised.exception.code, "PROVIDER_STREAM_MALFORMED")

    def test_an_unbounded_stream_is_cut_off(self) -> None:
        model, _ = provider(sse(delta("x" * 200_000)) * 40)
        with self.assertRaises(ProviderError) as raised:
            list(model.open_stream(model.prepare(request(), "invocation-1")))
        self.assertEqual(raised.exception.code, "PROVIDER_STREAM_TOO_LARGE")


if __name__ == "__main__":
    unittest.main()
