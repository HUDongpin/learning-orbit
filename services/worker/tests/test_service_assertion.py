import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from learning_orbit_worker.service_assertion import ServiceAssertionSigner, canonical_json, parse_canonical_json, verify_assertion


class FixedClock:
    def __init__(self, value): self.value = value
    def now(self): return self.value


class AssertionTests(unittest.TestCase):
    def test_canonical_nested_unicode_and_key_order(self):
        self.assertEqual(canonical_json({"z": 1, "a": "學習", "ok": True}), b'{"a":"\xe5\xad\xb8\xe7\xbf\x92","ok":true,"z":1}')
        with self.assertRaises(ValueError): canonical_json(float("nan"))
        with self.assertRaises(ValueError): parse_canonical_json(b'{"b":1,"a":2}')

    def test_sign_and_verify(self):
        key = Ed25519PrivateKey.generate()
        now = datetime(2026, 8, 30, 1, 2, 3, 456000, tzinfo=timezone.utc)
        signer = ServiceAssertionSigner.from_key("worker-issuer", "key-1", key, FixedClock(now))
        body = {"workerId": "worker-a", "value": "生態"}
        raw = signer.sign("internal.rooms.autoClose", "worker-a", body)
        verify_assertion(raw, body, key.public_key(), audience="internal.rooms.autoClose", subject="worker-a", now=now)
        with self.assertRaises(ValueError):
            verify_assertion(raw, {"workerId": "worker-b", "value": "生態"}, key.public_key(), audience="internal.rooms.autoClose", subject="worker-a", now=now)

    def test_key_file_requires_owner_mode_six_hundred(self):
        key = Ed25519PrivateKey.generate()
        pem = key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "worker.pem"
            path.write_bytes(pem)
            os.chmod(path, 0o644)
            with self.assertRaisesRegex(ValueError, "KEY_FILE_INVALID"):
                ServiceAssertionSigner("i", "k", path)

