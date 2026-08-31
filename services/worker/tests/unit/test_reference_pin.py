import json
import unittest
from hashlib import sha256
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[4]
REFERENCE = PROJECT / "services" / "worker" / "src" / "learning_orbit_worker" / "reference" / "learning_orbit_algorithms_v1.py"
MANIFEST = REFERENCE.parent / "manifest.json"
REFERENCE_SHA256 = "3a2983b0f99cd016b45fb5fd7ee8e1ac4b93b3eee62f3a189a8e20df8c1cf220"
SOURCE_TEST_SHA256 = "59ad56baa784fa187b6ea6a7cffcbba6138bfc945e43a2aa38fc6cce78560732"
SOURCE_PATH = "work/learning_orbit_algorithms.py"
SOURCE_TEST_PATH = "work/test_learning_orbit_algorithms.py"
DESTINATION_PATH = (
    "services/worker/src/learning_orbit_worker/reference/"
    "learning_orbit_algorithms_v1.py"
)


class ReferencePinTests(unittest.TestCase):
    def test_reference_file_is_hash_pinned(self):
        self.assertTrue(REFERENCE.is_file())
        self.assertTrue(MANIFEST.is_file())
        self.assertEqual(sha256(REFERENCE.read_bytes()).hexdigest(), REFERENCE_SHA256)
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(manifest["sourcePath"], SOURCE_PATH)
        self.assertEqual(manifest["sourceTestPath"], SOURCE_TEST_PATH)
        self.assertEqual(manifest["destinationPath"], DESTINATION_PATH)
        self.assertEqual(manifest["sha256"], REFERENCE_SHA256)
        self.assertEqual(manifest["sourceTestSha256"], SOURCE_TEST_SHA256)

    def test_manifest_and_claim_ceiling(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(manifest["sha256"], sha256(REFERENCE.read_bytes()).hexdigest())
        source = " ".join(REFERENCE.read_text(encoding="utf-8").split())
        self.assertIn("not natural-language-processing models", source)
        self.assertIn("make no claim of linguistic coverage", source)
