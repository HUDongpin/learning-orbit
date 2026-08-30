import json
import unittest
from hashlib import sha256
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[4]
STARSHIP = PROJECT.parent
REFERENCE = PROJECT / "services" / "worker" / "src" / "learning_orbit_worker" / "reference" / "learning_orbit_algorithms_v1.py"
SOURCE = STARSHIP / "work" / "learning_orbit_algorithms.py"
SOURCE_TEST = STARSHIP / "work" / "test_learning_orbit_algorithms.py"
MANIFEST = REFERENCE.parent / "manifest.json"


class ReferencePinTests(unittest.TestCase):
    def test_reference_file_is_hash_pinned(self):
        self.assertTrue(SOURCE.is_file())
        self.assertTrue(REFERENCE.is_file())
        self.assertEqual(sha256(SOURCE.read_bytes()).hexdigest(), "3a2983b0f99cd016b45fb5fd7ee8e1ac4b93b3eee62f3a189a8e20df8c1cf220")
        self.assertEqual(sha256(REFERENCE.read_bytes()).hexdigest(), "3a2983b0f99cd016b45fb5fd7ee8e1ac4b93b3eee62f3a189a8e20df8c1cf220")
        self.assertEqual(sha256(SOURCE_TEST.read_bytes()).hexdigest(), "59ad56baa784fa187b6ea6a7cffcbba6138bfc945e43a2aa38fc6cce78560732")

    def test_manifest_and_claim_ceiling(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(manifest["sha256"], sha256(REFERENCE.read_bytes()).hexdigest())
        source = " ".join(REFERENCE.read_text(encoding="utf-8").split())
        self.assertIn("not natural-language-processing models", source)
        self.assertIn("make no claim of linguistic coverage", source)
