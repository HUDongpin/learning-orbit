"""Scheduling the provider health probe, and the assertion the server accepts.

Three things had to be true at once before `agent_provider_health` could ever
hold a row, and none of them were: something had to schedule the probe, it had
to sign for the provider rather than for a worker, and it had to sign for no
longer than the server's own bound. Each is asserted here against the exact
values `authorizeProviderHealthAssertion` checks, because the failure they
caused was invisible - a worker that looked healthy, a table that stayed empty
and a Nova that was refused for a reason nobody could see.
"""
import base64
import json
import threading
import unittest
from datetime import datetime, timedelta, timezone
from threading import Event, Thread

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from learning_orbit_worker.internal_http import (
    INTERNAL_HTTP_DEFAULT_TIMEOUT_SECONDS,
    PROVIDER_HEALTH_IGNORED_STALE,
    PROVIDER_HEALTH_LIFETIME_SECONDS,
    InternalHttpError,
    InternalServiceClient,
)
from learning_orbit_worker.main import WorkerSupervisor
from learning_orbit_worker.observability import InMemoryTelemetry, create_telemetry
from learning_orbit_worker.providers.anthropic import PROBE_TIMEOUT_SECONDS, AnthropicMessagesProvider
from learning_orbit_worker.providers.fixture import ProviderError
from learning_orbit_worker.providers.health import (
    PROVIDER_HEALTH_INTERVAL_SECONDS,
    PROVIDER_HEALTH_JOIN_SECONDS,
    ProviderHealthProbe,
    build_provider_health_probe,
)
from learning_orbit_worker.providers.manifest import ProviderManifestError, parse_provider_manifest
from learning_orbit_worker.service_assertion import ServiceAssertionSigner

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
#: `authorizeProviderHealthAssertion` refuses a window longer than this, which
#: is half of what every worker-job callback is allowed.
SERVER_MAX_ASSERTION_SECONDS = 30
#: `ProviderHealthRepository.current` reads a sample older than this as
#: `unavailable`, so the probe has to run more often than it.
SERVER_FRESHNESS_SECONDS = 30


def manifest(**override):
    return parse_provider_manifest(json.dumps({**MANIFEST, **override}).encode("utf-8"))


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


def client(captured, response=(200, {"status": "accepted"})):
    def transport(url, payload, headers, timeout):
        captured.append({"url": url, "payload": payload, "headers": headers})
        return response

    return InternalServiceClient("http://127.0.0.1:3001", signer(), transport=transport)


def envelope_of(sent):
    assertion = sent["headers"]["X-LO-Service-Assertion"]
    padded = assertion + "=" * (-len(assertion) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))


class _StopAfter:
    """An Event-like object that stops a loop after N waits."""

    def __init__(self, waits):
        self.remaining = waits
        self.slept = []

    def is_set(self):
        return self.remaining <= 0

    def wait(self, seconds):
        self.slept.append(seconds)
        self.remaining -= 1
        return self.is_set()

    def set(self):
        self.remaining = 0


class _RaisingProbe:
    def __init__(self, error):
        self.error = error
        self.calls = 0

    def run_once(self):
        self.calls += 1
        raise self.error


class _DecidingProbe:
    """A probe whose reports the server answers with a given list of receipts."""

    def __init__(self, decisions):
        self.decisions = list(decisions)
        self.calls = 0

    def run_once(self):
        self.calls += 1
        return self.decisions[min(self.calls, len(self.decisions)) - 1]


class _StuckThread:
    """A probe thread that is still working when the join budget expires."""

    def __init__(self):
        self.joined = None

    def join(self, timeout=None):
        self.joined = timeout

    def is_alive(self):
        return True


def _supervisor(provider_health=None, telemetry=None, jobs=None):
    supervisor = WorkerSupervisor.__new__(WorkerSupervisor)
    supervisor.jobs = jobs
    supervisor.registry = None
    supervisor.deps = None
    supervisor.poll_seconds = 0.0
    supervisor.telemetry = telemetry or create_telemetry()
    supervisor.consecutive_failures = 0
    supervisor.provider_health = provider_health
    supervisor.provider_health_interval = 0.0
    return supervisor


class ProbeSchedulingTests(unittest.TestCase):
    def test_no_manifest_schedules_no_probe_at_all(self):
        captured = []

        self.assertIsNone(build_provider_health_probe(client(captured), {}))
        self.assertIsNone(build_provider_health_probe(client(captured), {"LO_AGENT_PROVIDER_KEY": KEY}))

        # Nothing was scheduled and nothing was sent, so `agent_provider_health`
        # stays empty, the server answers `unavailable`, and Nova is refused.
        # An unconfigured pilot has no other correct state.
        self.assertEqual(captured, [])
        self.assertIsNone(_supervisor()._start_provider_health(Event()))

    def test_a_manifest_that_is_present_but_wrong_is_a_mistake_not_a_deployment(self):
        for path, error in [
            ("provider.json", ProviderManifestError),
            ("/nonexistent/absolute/provider.json", ProviderManifestError),
        ]:
            with self.subTest(path=path):
                with self.assertRaises(error):
                    build_provider_health_probe(client([]), {"LO_AGENT_PROVIDER_MANIFEST": path})

    def test_the_probe_runs_often_enough_to_stay_inside_the_freshness_window(self):
        from learning_orbit_worker.providers.health import PROVIDER_HEALTH_INTERVAL_SECONDS

        # A cadence at or above the window would make Nova flicker between
        # answering and being refused with nothing actually wrong.
        self.assertLess(PROVIDER_HEALTH_INTERVAL_SECONDS, SERVER_FRESHNESS_SECONDS)

    def test_run_forever_starts_the_probe_and_leaves_none_behind(self):
        probed = Event()
        stop = Event()

        class _Probe:
            def __init__(self):
                self.calls = 0

            def run_once(self):
                self.calls += 1
                probed.set()
                return "accepted"

        class _IdleJobs:
            def claim(self, _limit):
                # Ends the run as soon as the probe has proved it is running,
                # so the assertions below are about a started thread, not a
                # timing window.
                if probed.wait(5.0):
                    stop.set()
                return []

        probe = _Probe()
        supervisor = _supervisor(provider_health=probe, jobs=_IdleJobs())
        supervisor.provider_health_interval = 0.01

        supervisor.run_forever(stop)

        self.assertGreaterEqual(probe.calls, 1)
        self.assertTrue(stop.is_set())
        self.assertEqual(
            [thread.name for thread in threading.enumerate() if thread.name == "lo-provider-health"],
            [],
        )


class ProbeAssertionTests(unittest.TestCase):
    def test_a_sample_is_signed_for_the_provider_not_for_a_worker(self):
        captured = []
        probe = ProviderHealthProbe(manifest(), client(captured), env=ENV, probe=lambda: "healthy")

        self.assertEqual(probe.run_once(), "accepted")

        sent = captured[0]
        envelope = envelope_of(sent)
        # The exact string `authorizeProviderHealthAssertion` compares against.
        self.assertEqual(envelope["subject"], "provider-health-probe:anthropic-messages-v1")
        self.assertEqual(envelope["audience"], "internal.agent.health")
        self.assertEqual(sent["url"], "http://127.0.0.1:3001/internal/agent/provider-health")
        # None of the worker-job claim fields the server refuses on this route.
        body = json.loads(sent["payload"])
        self.assertEqual(sorted(body), [
            "checkedAt", "health", "manifestSha256", "probeId", "providerId", "reasonCode",
        ])
        self.assertEqual(body["health"], "healthy")
        self.assertEqual(body["manifestSha256"], manifest().sha256)

    def test_the_assertion_lives_no_longer_than_the_server_allows(self):
        captured = []
        ProviderHealthProbe(manifest(), client(captured), env=ENV, probe=lambda: "healthy").run_once()

        envelope = envelope_of(captured[0])
        issued = datetime.fromisoformat(envelope["issuedAt"].replace("Z", "+00:00"))
        expires = datetime.fromisoformat(envelope["expiresAt"].replace("Z", "+00:00"))
        window = expires - issued
        # The default sixty seconds every other internal call takes is refused
        # here, so the probe has to ask for its own bound.
        self.assertGreaterEqual(window, timedelta(seconds=1))
        # Strictly inside, not on the bound: see the margin test below.
        self.assertLess(window, timedelta(seconds=SERVER_MAX_ASSERTION_SECONDS))

    def test_the_assertion_window_keeps_a_margin_inside_the_server_s_bound(self):
        # `authorizeProviderHealthAssertion` refuses `expiresAt - issuedAt >
        # 30_000`, so thirty was the largest window it still accepted and left
        # no room at all. Any rounding in either clock, or any later tightening
        # of that bound, turns every sample into a 401 and `agent_provider_
        # health` back into the empty table this whole route was fixed for.
        self.assertLess(PROVIDER_HEALTH_LIFETIME_SECONDS, SERVER_MAX_ASSERTION_SECONDS)
        self.assertGreaterEqual(PROVIDER_HEALTH_LIFETIME_SECONDS, 1)

    def test_a_refused_sample_is_never_read_as_a_delivered_one(self):
        for status in [401, 409]:
            with self.subTest(status=status):
                probe = ProviderHealthProbe(
                    manifest(),
                    client([], response=(status, {"status": "rejected", "code": "PROVIDER_SCOPE_MISMATCH"})),
                    env=ENV, probe=lambda: "healthy",
                )
                with self.assertRaises(InternalHttpError) as raised:
                    probe.run_once()
                self.assertEqual(raised.exception.code, "INTERNAL_HTTP_STATUS")

    def test_a_receipt_that_is_not_the_route_s_own_shape_is_refused(self):
        probe = ProviderHealthProbe(
            manifest(), client([], response=(200, {"status": "invented"})),
            env=ENV, probe=lambda: "healthy",
        )
        with self.assertRaises(InternalHttpError) as raised:
            probe.run_once()
        self.assertEqual(raised.exception.code, "INTERNAL_HTTP_RESPONSE_SCHEMA")


class ProbeFailureTests(unittest.TestCase):
    def test_a_failing_probe_reports_unavailable_and_never_healthy(self):
        captured = []
        probe = ProviderHealthProbe(
            manifest(), client(captured), env=ENV,
            probe=lambda: (_ for _ in ()).throw(OSError("connect ECONNREFUSED 10.0.0.5:443")),
        )

        self.assertEqual(probe.run_once(), "accepted")

        body = json.loads(captured[0]["payload"])
        self.assertEqual(body["health"], "unavailable")
        self.assertEqual(body["reasonCode"], "PROBE_FAILED")
        # A driver message names a host and a port; a bounded reason does not.
        self.assertNotIn("10.0.0.5", captured[0]["payload"].decode("utf-8"))

    def test_an_absent_credential_is_reported_rather_than_left_unsaid(self):
        captured = []
        probe = ProviderHealthProbe(manifest(), client(captured), env={}, probe=lambda: "healthy")

        probe.run_once()

        body = json.loads(captured[0]["payload"])
        self.assertEqual((body["health"], body["reasonCode"]), ("unavailable", "CREDENTIAL_ABSENT"))
        self.assertNotIn(KEY, captured[0]["payload"].decode("utf-8"))

    def test_a_report_that_cannot_be_delivered_is_retryable_and_survives(self):
        sink = InMemoryTelemetry()
        probe = _RaisingProbe(InternalHttpError("INTERNAL_HTTP_TRANSPORT"))
        supervisor = _supervisor(provider_health=probe, telemetry=sink.telemetry(now=lambda: 0.0))
        stop = _StopAfter(waits=3)

        # The loop must return, not raise: a probe that cannot reach the server
        # leaves a stale row the server already reads as `unavailable`, and
        # there is nothing here worth stopping deletion or media for.
        supervisor._provider_health_loop(stop)

        self.assertEqual(probe.calls, 3)
        self.assertEqual(stop.slept, [0.5, 1.0, 2.0])
        self.assertEqual(
            [span["name"] for span in sink.spans],
            ["worker.provider_health.failed"] * 3,
        )
        self.assertEqual(
            sink.spans[0]["attributes"]["failureCode"],
            "PROVIDER_HEALTH_PROBE_RETRYABLE",
        )
        # The job loop's own escalation counter is untouched: a probe failure
        # is not a reason to restart the worker.
        self.assertEqual(supervisor.consecutive_failures, 0)

    def test_a_probe_failure_never_swallows_a_stop_request(self):
        supervisor = _supervisor(provider_health=_RaisingProbe(KeyboardInterrupt()))
        with self.assertRaises(KeyboardInterrupt):
            supervisor._provider_health_loop(_StopAfter(waits=3))

    def test_a_sample_the_server_keeps_discarding_is_not_reported_as_a_success(self):
        sink = InMemoryTelemetry()
        probe = _DecidingProbe([PROVIDER_HEALTH_IGNORED_STALE, "accepted", PROVIDER_HEALTH_IGNORED_STALE])
        supervisor = _supervisor(provider_health=probe, telemetry=sink.telemetry(now=lambda: 0.0))

        supervisor._provider_health_loop(_StopAfter(waits=3))

        # `ignored_stale` means the server kept the row it already had - a
        # clock that went backwards, or another worker's later sample. The loop
        # used to discard that answer, so a probe whose every report was thrown
        # away looked exactly like one that was landing while the row it
        # believed it was refreshing went stale.
        self.assertEqual(probe.calls, 3)
        self.assertEqual(
            [(span["name"], span["attributes"]["failureCode"]) for span in sink.spans],
            [("worker.provider_health.ignored", "PROVIDER_HEALTH_SAMPLE_IGNORED_STALE")] * 2,
        )


class ProbeShutdownTests(unittest.TestCase):
    def test_a_probe_still_running_after_the_join_is_surfaced_not_left_behind(self):
        sink = InMemoryTelemetry()
        supervisor = _supervisor(telemetry=sink.telemetry(now=lambda: 0.0))
        thread, stop = _StuckThread(), Event()

        with self.assertRaises(RuntimeError) as raised:
            supervisor._stop_provider_health(thread, stop)

        # main() flushes the span sink and closes the database connection as
        # soon as run_forever returns. A join that expires is not the same as a
        # thread that stopped, and nothing used to ask which had happened.
        self.assertEqual(str(raised.exception), "WORKER_PROVIDER_HEALTH_THREAD_LEAK")
        self.assertTrue(stop.is_set())
        self.assertEqual(
            [(span["name"], span["attributes"]["failureCode"]) for span in sink.spans],
            [("worker.provider_health.thread_leak", "WORKER_PROVIDER_HEALTH_THREAD_LEAK")],
        )

    def test_the_join_waits_longer_than_one_sample_s_real_worst_case(self):
        supervisor = _supervisor()
        supervisor.provider_health_interval = PROVIDER_HEALTH_INTERVAL_SECONDS
        thread = _StuckThread()

        with self.assertRaises(RuntimeError):
            supervisor._stop_provider_health(thread, Event())

        # One sample is a provider probe that may hang to its own timeout and
        # then a report that may hang to the internal client's. A join of one
        # interval was shorter than either, so an ordinary shutdown arriving
        # mid-sample expired the join with the thread still working.
        self.assertGreater(
            thread.joined, PROBE_TIMEOUT_SECONDS + INTERNAL_HTTP_DEFAULT_TIMEOUT_SECONDS,
        )
        self.assertGreaterEqual(thread.joined, PROVIDER_HEALTH_JOIN_SECONDS)
        self.assertGreater(thread.joined, PROVIDER_HEALTH_INTERVAL_SECONDS)

    def test_a_probe_that_stopped_within_the_budget_is_not_called_a_leak(self):
        stopped = Thread(target=lambda: None)
        stopped.start()
        supervisor = _supervisor()

        supervisor._stop_provider_health(stopped, Event())

        self.assertFalse(stopped.is_alive())


class AdapterProbeTests(unittest.TestCase):
    def provider(self, status, env=None):
        calls = []

        def probe_transport(url, headers):
            calls.append({"url": url, "headers": dict(headers)})
            return status

        model = AnthropicMessagesProvider(
            manifest(), env=ENV if env is None else env, probe_transport=probe_transport,
        )
        return model, calls

    def test_only_a_200_is_healthy_and_throttling_is_degraded(self):
        for status, health in [
            (200, "healthy"), (429, "degraded"), (529, "degraded"),
            (401, "unavailable"), (403, "unavailable"), (404, "unavailable"),
            (500, "unavailable"), (503, "unavailable"),
        ]:
            with self.subTest(status=status):
                model, _calls = self.provider(status)
                self.assertEqual(model.probe(), health)

    def test_the_probe_asks_about_the_reviewed_model_and_sends_no_prompt(self):
        model, calls = self.provider(200)

        model.probe()

        self.assertEqual(calls[0]["url"], "https://api.anthropic.com/v1/models/claude-sonnet-5")
        self.assertEqual(calls[0]["headers"]["anthropic-version"], "2023-06-01")
        # The credential is sent, as a completion sends it, and nothing else
        # is: no prompt, no room, no student, no message content.
        self.assertEqual(calls[0]["headers"]["x-api-key"], KEY)
        self.assertEqual(sorted(calls[0]["headers"]), ["accept", "anthropic-version", "x-api-key"])

    def test_an_absent_credential_stops_before_a_request_is_built(self):
        model, calls = self.provider(200, env={})
        with self.assertRaises(ProviderError) as raised:
            model.probe()
        self.assertEqual(raised.exception.code, "CREDENTIAL_ABSENT")
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
