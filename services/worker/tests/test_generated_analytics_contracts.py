import hashlib
import json
import unittest
from pathlib import Path
from learning_orbit_worker.generated.analysis_projection_envelope_v1 import Envelope
from learning_orbit_worker.generated.analytics_review_command_v1 import Request as ReviewRequest
from learning_orbit_worker.generated.derived_text_artifact_v1 import Artifact

ROOM = "00000000-0000-4000-8000-000000000001"
EVENT = "00000000-0000-4000-8000-000000000002"
BASE_ARTIFACT = {"schemaVersion":1,"artifactId":EVENT,"lineageId":ROOM,"roomId":ROOM,"eventId":EVENT,"roomSeq":1,"sourceMediaId":None,"sourceModality":"text","derivation":"direct","text":"energy","normalizedTextSha256":"a"*64,"sourceConfidenceRaw":1.0,"sourceConfidenceCalibrated":None,"provider":"fixture","modelVersion":"v1","languageTag":"en","spans":[],"reviewStatus":"unreviewed","displayStatus":"hidden","warnings":[],"supersedesArtifactId":None,"active":True,"createdAt":"2026-08-30T00:00:00Z"}

class GeneratedAnalyticsContractTests(unittest.TestCase):
    def test_closed_artifact_and_strict_numbers(self):
        self.assertEqual(Artifact.from_dict(BASE_ARTIFACT).value["roomSeq"], 1)
        for bad in ({**BASE_ARTIFACT, "extra": 1}, {**BASE_ARTIFACT, "roomSeq": 1.2}, {**BASE_ARTIFACT, "sourceConfidenceRaw": True}):
            with self.assertRaises(ValueError): Artifact.from_dict(bad)

    def test_envelope_and_review(self):
        env = {"schemaVersion":1,"projectionKey":"echo.teacher_shadow","roomId":ROOM,"analysisEpoch":EVENT,"algorithmVersion":"echo-v1","parameterHash":"b"*64,"projectionVersion":1,"baseVersion":0,"completeThroughRoomSeq":0,"watermarkEventTime":"2026-08-30T00:00:00Z","requiresReplay":False,"evidenceStatus":"active","reviewStatus":"unreviewed","displayStatus":"teacher_shadow","warnings":[],"payload":{}}
        Envelope.from_dict(env)
        ReviewRequest.from_dict({"targetType":"projection","targetId":EVENT,"decision":"approve","rationale":"ok","expectedAnalysisEpoch":EVENT,"expectedProjectionVersion":1})
        with self.assertRaises(ValueError): Envelope.from_dict({**env, "projectionVersion": 1.1})

    def test_manifest_hashes_and_source_paths(self):
        root = Path(__file__).parents[3]
        manifest = json.loads((root / "services/worker/src/learning_orbit_worker/generated/manifest.json").read_text())
        for item in manifest["sourceSchemas"]:
            if "sha256" not in item: continue
            source = root / item["sourcePath"]
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), item["sha256"])
