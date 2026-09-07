"""The reviewed provider manifest and the health it produces."""
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from learning_orbit_worker.providers.health import (
    HealthSample,
    sample_provider_health,
)
from learning_orbit_worker.providers.manifest import (
    ProviderManifestError,
    load_provider_manifest,
    parse_provider_manifest,
)

VALID = {
    "schemaVersion": 1,
    "providerId": "fixture-socratic-v1",
    "displayName": "Fixture Socratic Provider",
    "modelId": "fixture-model",
    "region": "local",
    "purpose": "socratic facilitation for a controlled classroom pilot",
    "maxOutputTokens": 512,
    "credentialEnvVar": "LO_AGENT_PROVIDER_KEY",
    "remoteCopyMode": "no_persistent_copy_attested",
}


def raw(**overrides):
    return json.dumps({**VALID, **overrides}).encode("utf-8")


class ProviderManifestTests(unittest.TestCase):
    def test_binds_the_manifest_to_the_digest_of_its_exact_bytes(self):
        from hashlib import sha256

        document = raw()
        manifest = parse_provider_manifest(document)
        self.assertEqual(manifest.sha256, sha256(document).hexdigest())
        # A byte that changes anything changes the digest the server stores, so
        # a provider nobody approved cannot pass for one that was.
        self.assertNotEqual(manifest.sha256, parse_provider_manifest(raw(region="eu")).sha256)

    def test_names_the_credential_and_never_carries_it(self):
        manifest = parse_provider_manifest(raw())
        self.assertEqual(manifest.credential_env_var, "LO_AGENT_PROVIDER_KEY")
        self.assertFalse(manifest.credential_present({}))
        self.assertFalse(manifest.credential_present({"LO_AGENT_PROVIDER_KEY": ""}))
        self.assertTrue(manifest.credential_present({"LO_AGENT_PROVIDER_KEY": "sk-live"}))
        # Nothing in the parsed manifest is the secret itself.
        from dataclasses import asdict

        for value in asdict(manifest).values():
            self.assertNotIn("sk-live", str(value))

    def test_refuses_a_manifest_that_looks_like_it_carries_a_secret(self):
        # A long unbroken token in a committed, hashed, logged file is a key.
        with self.assertRaises(ProviderManifestError) as raised:
            parse_provider_manifest(raw(purpose="sk-" + "a" * 70))
        self.assertEqual(raised.exception.code, "AGENT_PROVIDER_MANIFEST_SECRET_SUSPECTED")

    def test_refuses_a_manifest_that_is_not_closed_and_well_formed(self):
        for document, code in [
            (b"not json", "AGENT_PROVIDER_MANIFEST_INVALID"),
            (b"[]", "AGENT_PROVIDER_MANIFEST_INVALID"),
            (raw(schemaVersion=2), "AGENT_PROVIDER_MANIFEST_VERSION"),
            (json.dumps({**VALID, "extra": 1}).encode(), "AGENT_PROVIDER_MANIFEST_INVALID"),
            (raw(providerId="Fixture Provider"), "AGENT_PROVIDER_MANIFEST_INVALID"),
            (raw(credentialEnvVar="lowercase_var"), "AGENT_PROVIDER_MANIFEST_INVALID"),
            (raw(maxOutputTokens=0), "AGENT_PROVIDER_MANIFEST_INVALID"),
            (raw(maxOutputTokens=9000), "AGENT_PROVIDER_MANIFEST_INVALID"),
            (raw(remoteCopyMode="keep_forever"), "AGENT_PROVIDER_MANIFEST_REMOTE_COPY_MODE"),
        ]:
            with self.subTest(code=code):
                with self.assertRaises(ProviderManifestError) as raised:
                    parse_provider_manifest(document)
                self.assertEqual(raised.exception.code, code)

    def test_loads_only_from_an_absolute_path(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "provider.json"
            path.write_bytes(raw())
            self.assertEqual(load_provider_manifest(path).provider_id, "fixture-socratic-v1")
            with self.assertRaises(ProviderManifestError):
                load_provider_manifest("provider.json")
            with self.assertRaises(ProviderManifestError):
                load_provider_manifest(Path(directory) / "absent.json")


class ProviderHealthTests(unittest.TestCase):
    def manifest(self):
        return parse_provider_manifest(raw())

    def now(self):
        return datetime(2026, 8, 30, 8, 0, 0, tzinfo=timezone.utc)

    def test_an_unconfigured_provider_is_unavailable_before_anything_is_sent(self):
        calls = []

        def probe():
            calls.append(1)
            return "healthy"

        sample = sample_provider_health(self.manifest(), {}, probe=probe, now=self.now)

        self.assertEqual((sample.health, sample.reason_code), ("unavailable", "CREDENTIAL_ABSENT"))
        # Nothing was attempted: an unconfigured provider must not produce a
        # request that could be mistaken for a real outage.
        self.assertEqual(calls, [])

    def test_a_configured_provider_with_no_probe_is_still_unavailable(self):
        sample = sample_provider_health(
            self.manifest(), {"LO_AGENT_PROVIDER_KEY": "sk"}, now=self.now,
        )
        self.assertEqual((sample.health, sample.reason_code), ("unavailable", "PROBE_UNCONFIGURED"))

    def test_carries_the_manifest_digest_and_a_bounded_reason(self):
        manifest = self.manifest()
        sample = sample_provider_health(
            manifest, {"LO_AGENT_PROVIDER_KEY": "sk"}, probe=lambda: "healthy", now=self.now,
        )
        body = sample.as_body()
        self.assertEqual(body["manifestSha256"], manifest.sha256)
        self.assertEqual(body["health"], "healthy")
        self.assertIsNone(body["reasonCode"])
        self.assertEqual(body["checkedAt"], "2026-08-30T08:00:00Z")
        self.assertEqual(sorted(body), [
            "checkedAt", "health", "manifestSha256", "probeId", "providerId", "reasonCode",
        ])

    def test_a_failing_or_nonsense_probe_never_reports_healthy(self):
        for probe, reason in [
            (lambda: (_ for _ in ()).throw(RuntimeError("connect ECONNREFUSED 10.0.0.5:443")), "PROBE_FAILED"),
            (lambda: "excellent", "PROBE_RESULT_INVALID"),
        ]:
            with self.subTest(reason=reason):
                sample = sample_provider_health(
                    self.manifest(), {"LO_AGENT_PROVIDER_KEY": "sk"}, probe=probe, now=self.now,
                )
                self.assertEqual(sample.health, "unavailable")
                self.assertEqual(sample.reason_code, reason)
                # A driver message names a host and a port; a reason code does not.
                self.assertNotIn("10.0.0.5", str(sample.as_body()))

    def test_degraded_is_reported_as_degraded_with_its_own_reason(self):
        sample = sample_provider_health(
            self.manifest(), {"LO_AGENT_PROVIDER_KEY": "sk"}, probe=lambda: "degraded", now=self.now,
        )
        self.assertEqual((sample.health, sample.reason_code), ("degraded", "PROBE_REPORTED_DEGRADED"))
        self.assertIsInstance(sample, HealthSample)
