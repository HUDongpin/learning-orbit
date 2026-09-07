"""The worker's side of every signed internal route it calls."""
import json
import unittest
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

from learning_orbit_worker.generated.lifecycle_internal_media_surface_v1 import (
    Request as MediaSurfaceRequest,
)
from learning_orbit_worker.generated.media_internal_outcome_v1 import (
    Request as MediaOutcomeRequest,
)
from learning_orbit_worker.generated.media_internal_reconcile_v1 import (
    Request as MediaReconcileRequest,
)
from learning_orbit_worker.generated.room_internal_auto_close_v1 import (
    Request as AutoCloseRequest,
)

GENERATED = Path(__file__).resolve().parents[1] / "src/learning_orbit_worker/generated"
REPOSITORY = Path(__file__).resolve().parents[3]


def claim(job_type, dedupe):
    return {
        "jobId": str(uuid4()),
        "jobType": job_type,
        "dedupeKey": dedupe,
        "correlationId": str(uuid4()),
        "claimGeneration": "1",
        "claimToken": str(uuid4()),
        "workerId": "worker-1",
    }


class AutoCloseContractTests(unittest.TestCase):
    def request(self):
        media = str(uuid4())
        return {
            **claim("room.auto-close.v1", f"room.auto-close.v1:{media}"),
            "roomId": str(uuid4()),
            "sourceEventId": str(uuid4()),
            "closesAt": "2026-08-30T09:00:00Z",
        }

    def test_accepts_the_closed_shape_and_refuses_anything_else(self):
        parsed = AutoCloseRequest.from_dict(self.request())
        self.assertEqual(parsed.job_type, "room.auto-close.v1")

        for mutate in [
            lambda r: r.update(extra=1),
            lambda r: r.update(jobType="room.close.v1"),
            lambda r: r.update(dedupeKey="room.auto-close.v1:not-a-uuid"),
            lambda r: r.update(claimGeneration="0"),
            lambda r: r.update(closesAt="not a time"),
            lambda r: r.update(workerId=""),
            lambda r: r.pop("closesAt"),
        ]:
            request = self.request()
            mutate(request)
            with self.assertRaises(ValueError):
                AutoCloseRequest.from_dict(request)


class MediaReconcileContractTests(unittest.TestCase):
    def request(self):
        media = str(uuid4())
        return {
            **claim("media.reconcile-upload.v1", f"media.reconcile-upload.v1:{media}"),
            "roomId": str(uuid4()),
            "sourceEventId": None,
            "mediaId": media,
        }

    def test_requires_the_null_source_event_this_family_carries(self):
        self.assertIsNone(MediaReconcileRequest.from_dict(self.request()).source_event_id)
        request = self.request()
        request["sourceEventId"] = str(uuid4())
        with self.assertRaises(ValueError):
            MediaReconcileRequest.from_dict(request)


class MediaOutcomeContractTests(unittest.TestCase):
    def request(self, **overrides):
        media = str(uuid4())
        request = {
            **claim("media.process.v1", f"media.process.v1:{media}"),
            "roomId": str(uuid4()),
            "sourceEventId": None,
            "mediaId": media,
            "transitionId": str(uuid4()),
            "state": "ready",
            "failureCode": None,
            "derivatives": [],
        }
        request.update(overrides)
        return request

    def test_parses_a_ready_outcome_with_its_derivatives(self):
        derivative = {
            "derivativeId": str(uuid4()),
            "kind": "thumbnail",
            "objectKey": "rooms/r/media/m/thumb",
            "mime": "image/webp",
            "sizeBytes": 512,
            "sha256": sha256(b"thumb").hexdigest(),
        }
        parsed = MediaOutcomeRequest.from_dict(self.request(derivatives=[derivative]))
        self.assertEqual(parsed.state, "ready")
        self.assertEqual(parsed.derivatives[0].kind, "thumbnail")
        self.assertEqual(parsed.derivatives[0].size_bytes, 512)

    def test_refuses_a_derivative_or_state_outside_the_contract(self):
        good = {
            "derivativeId": str(uuid4()),
            "kind": "thumbnail",
            "objectKey": "rooms/r/media/m/thumb",
            "mime": "image/webp",
            "sizeBytes": 512,
            "sha256": sha256(b"thumb").hexdigest(),
        }
        for request in [
            self.request(state="deleted"),
            self.request(derivatives=[{**good, "kind": "transcript"}]),
            self.request(derivatives=[{**good, "sizeBytes": 0}]),
            self.request(derivatives=[{**good, "sizeBytes": 26_214_401}]),
            self.request(derivatives=[{**good, "sha256": "nope"}]),
            self.request(derivatives=[good, good, good, good, good]),
            self.request(failureCode=""),
        ]:
            with self.assertRaises(ValueError):
                MediaOutcomeRequest.from_dict(request)


class MediaSurfaceContractTests(unittest.TestCase):
    def request(self, **overrides):
        deletion = str(uuid4())
        request = {
            **claim("room.delete-surface.v1", f"room.delete-surface.v1:{deletion}:media"),
            "roomId": None,
            "sourceEventId": None,
            "deletionJobId": deletion,
            "surface": "media",
        }
        request.update(overrides)
        return request

    def test_is_deliberately_not_room_scoped(self):
        parsed = MediaSurfaceRequest.from_dict(self.request())
        self.assertIsNone(parsed.room_id)
        self.assertEqual(parsed.surface, "media")

        with self.assertRaises(ValueError):
            MediaSurfaceRequest.from_dict(self.request(roomId=str(uuid4())))
        with self.assertRaises(ValueError):
            MediaSurfaceRequest.from_dict(self.request(surface="events"))


class GeneratedManifestParityTests(unittest.TestCase):
    def test_every_python_ingress_schema_has_a_module_and_a_current_digest(self):
        manifest = json.loads((GENERATED / "manifest.json").read_text())
        schemas_dir = REPOSITORY / "packages/contracts/schemas"
        declared = {
            path.name
            for path in schemas_dir.glob("*.json")
            if json.loads(path.read_text()).get("x-learning-orbit-python-ingress") is True
        }
        listed = {entry["file"] for entry in manifest["sourceSchemas"]}
        self.assertEqual(listed, declared)

        for entry in manifest["sourceSchemas"]:
            with self.subTest(schema=entry["file"]):
                # A digest that no longer matches means the worker is parsing a
                # shape the server no longer sends.
                actual = sha256((schemas_dir / entry["file"]).read_bytes()).hexdigest()
                self.assertEqual(entry["sha256"], actual)
                self.assertEqual(
                    entry["sourcePath"], f"packages/contracts/schemas/{entry['file']}"
                )
        for entry in manifest["generatedModules"]:
            with self.subTest(module=entry["moduleFile"]):
                self.assertTrue((GENERATED / entry["moduleFile"]).is_file())
