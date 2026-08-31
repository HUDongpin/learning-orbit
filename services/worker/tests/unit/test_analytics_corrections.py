import copy
import unittest
from types import SimpleNamespace
from uuid import UUID

from learning_orbit_worker.analytics_handlers import (
    _approved_echo_edge_ids,
    _apply_artifact_reviews,
    _apply_projection_corrections,
    _artifact_source_event_id,
    _effective_events,
    _persist_extractions,
    _review_allowlist,
)
from learning_orbit_worker.echo_adapter import echo_wire_edge_id


ROOM = "00000000-0000-4000-8000-000000000001"
EPOCH = "00000000-0000-4000-8000-000000000002"
EDGE_EVENT = "00000000-0000-4000-8000-000000000003"
REPLACEMENT_EVENT = "00000000-0000-4000-8000-000000000004"
ARTIFACT = "00000000-0000-4000-8000-000000000005"
LINEAGE = "00000000-0000-4000-8000-000000000006"
MERGE_EVENT = "00000000-0000-4000-8000-000000000007"
UNDO_EVENT = "00000000-0000-4000-8000-000000000008"
CORRECTED = "00000000-0000-5000-8000-000000000009"
MEDIA = "00000000-0000-4000-8000-000000000010"


def common(kind):
    return {
        "correctionKind": kind,
        "reason": "教師依證據修正。",
        "expectedAnalysisEpoch": EPOCH,
        "expectedProjectionVersion": 1,
    }


def detail(event_id, payload):
    return {
        "reviewEventId": event_id,
        "payload": payload,
        "roomSeq": 10,
        "createdAt": "2026-08-31T01:00:00.000Z",
    }


def internal():
    return {
        "nodes": [
            {"nodeId": "producer", "label": "生產者", "x": 0.0, "y": 0.0},
            {"nodeId": "plant", "label": "植物", "x": 0.2, "y": 0.2},
            {"nodeId": "sun", "label": "太陽", "x": -0.2, "y": -0.2},
        ],
        "edges": [{
            "head": "plant",
            "predicate": "uses",
            "tail": "sun",
            "relationFamily": "energy_flow",
            "status": "supported",
            "channels": {"support": 1.0, "challenge": 0.0, "uncertain": 0.0, "question": 0.0},
            "evidenceIds": ["source"],
        }],
    }


class Cursor:
    def __init__(self, rows=()):
        self.rows = list(rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class ArtifactConnection:
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if "FROM derived_text_artifact WHERE artifact_id=%s" in sql:
            return Cursor([{
                "artifact_id": params[0],
                "lineage_id": LINEAGE,
                "event_id": MERGE_EVENT,
                "room_id": ROOM,
                "room_seq": 10,
                "source_media_id": None,
                "source_modality": "text",
                "derivation": "human_correction",
                "text_content": "修正後文字",
                "normalized_text_sha256": "6bc8a3e0fe813d4763d48a64f745d6d4b539264a9d8d3754906250d53d0aa8f3",
                "source_confidence_raw": 1.0,
                "source_confidence_calibrated": None,
                "provider": "teacher-correction",
                "model_version": "teacher-correction-v1",
                "language_tag": "zh-Hant",
                "spans": [],
                "review_status": "corrected",
                "display_status": "teacher_shadow",
                "warnings": [],
                "supersedes_artifact_id": ARTIFACT,
                "active": True,
                "created_at": "2026-08-31T01:00:00.000Z",
            }])
        if "SELECT artifact_id,lineage_id,event_id" in sql:
            return Cursor([{
                "artifact_id": ARTIFACT,
                "lineage_id": LINEAGE,
                "event_id": EDGE_EVENT,
                "room_seq": 3,
                "source_media_id": None,
                "source_modality": "text",
                "language_tag": "und",
            }])
        if "active=true AND derivation='human_correction'" in sql:
            return Cursor([{"artifact_id": MERGE_EVENT, "text_content": "修正後文字"}])
        if "WITH RECURSIVE artifact_ancestry" in sql:
            return Cursor([
                {
                    "artifact_id": MERGE_EVENT,
                    "event_id": MERGE_EVENT,
                    "derivation": "human_correction",
                    "supersedes_artifact_id": ARTIFACT,
                    "depth": 0,
                },
                {
                    "artifact_id": ARTIFACT,
                    "event_id": EDGE_EVENT,
                    "derivation": "direct",
                    "supersedes_artifact_id": None,
                    "depth": 1,
                },
            ])
        return Cursor()


class StatefulArtifactConnection:
    """Small relational double for replaying the same correction ledger twice."""

    def __init__(self, *, persisted_overrides=None):
        self.calls = []
        self.persisted_overrides = dict(persisted_overrides or {})
        self.rows = {
            ARTIFACT: {
                "artifact_id": ARTIFACT,
                "lineage_id": LINEAGE,
                "event_id": EDGE_EVENT,
                "room_id": ROOM,
                "room_seq": 3,
                "source_media_id": UUID(MEDIA),
                "source_modality": "audio",
                "derivation": "asr",
                "text_content": "原文",
                "normalized_text_sha256": "0" * 64,
                "source_confidence_raw": 0.8,
                "source_confidence_calibrated": None,
                "provider": "fixture-asr",
                "model_version": "fixture-v1",
                "language_tag": "zh-Hant",
                "spans": [],
                "review_status": "unreviewed",
                "display_status": "teacher_shadow",
                "warnings": [],
                "supersedes_artifact_id": None,
                "active": True,
                "created_at": "2026-08-31T00:59:00.000Z",
            },
        }
    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if "SELECT artifact_id,lineage_id,event_id" in sql and "WHERE room_id=" in sql:
            row = self.rows.get(str(params[1]))
            return Cursor([row] if row else [])
        if "UPDATE derived_text_artifact SET active=false" in sql:
            for row in self.rows.values():
                if row["lineage_id"] == str(params[1]) and row["active"]:
                    row["active"] = False
            return Cursor()
        if "INSERT INTO derived_text_artifact" in sql:
            artifact_id = str(params[0])
            if artifact_id not in self.rows:
                self.rows[artifact_id] = {
                    "artifact_id": artifact_id,
                    "lineage_id": str(params[1]),
                    "event_id": str(params[2]),
                    "room_id": str(params[3]),
                    "room_seq": int(params[4]),
                    "source_media_id": params[5],
                    "source_modality": str(params[6]),
                    "derivation": str(params[7]),
                    "text_content": str(params[8]),
                    "normalized_text_sha256": str(params[9]),
                    "source_confidence_raw": float(params[10]),
                    "source_confidence_calibrated": params[11],
                    "provider": str(params[12]),
                    "model_version": str(params[13]),
                    "language_tag": str(params[14]),
                    "spans": [],
                    "review_status": str(params[16]),
                    "display_status": str(params[17]),
                    "warnings": [],
                    "supersedes_artifact_id": str(params[19]),
                    "active": bool(params[20]),
                    "created_at": str(params[21]),
                }
                self.rows[artifact_id].update(self.persisted_overrides)
            return Cursor()
        if "FROM derived_text_artifact WHERE artifact_id=" in sql:
            row = self.rows.get(str(params[0]))
            return Cursor([row] if row else [])
        if "SET active=true,review_status='corrected'" in sql:
            row = self.rows[str(params[0])]
            row.update(active=True, review_status="corrected", display_status="teacher_shadow")
            return Cursor()
        if "SET review_status=%s" in sql:
            row = self.rows.get(str(params[2]))
            if row:
                row["review_status"] = str(params[0])
            return Cursor()
        return Cursor()


class LineageConnection:
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if "active=true AND derivation='human_correction'" in sql:
            return Cursor([{
                "artifact_id": CORRECTED,
                "text_content": "第二次修正後文字",
            }])
        if "WITH RECURSIVE artifact_ancestry" in sql:
            return Cursor([
                {
                    "artifact_id": CORRECTED,
                    "event_id": UNDO_EVENT,
                    "derivation": "human_correction",
                    "supersedes_artifact_id": MERGE_EVENT,
                    "depth": 0,
                },
                {
                    "artifact_id": MERGE_EVENT,
                    "event_id": MERGE_EVENT,
                    "derivation": "human_correction",
                    "supersedes_artifact_id": ARTIFACT,
                    "depth": 1,
                },
                {
                    "artifact_id": ARTIFACT,
                    "event_id": EDGE_EVENT,
                    "derivation": "direct",
                    "supersedes_artifact_id": None,
                    "depth": 2,
                },
            ])
        return Cursor()


class AllowlistConnection:
    def __init__(self, payloads):
        self.payloads = payloads

    def execute(self, sql, params=()):
        if "FROM analytics_review_detail" in sql:
            return Cursor([{"validated_payload": payload} for payload in self.payloads])
        if "WITH RECURSIVE artifact_ancestry" in sql:
            if str(params[1]) == CORRECTED:
                return Cursor([
                    {
                        "artifact_id": CORRECTED,
                        "event_id": UNDO_EVENT,
                        "derivation": "human_correction",
                        "supersedes_artifact_id": MERGE_EVENT,
                        "depth": 0,
                    },
                    {
                        "artifact_id": MERGE_EVENT,
                        "event_id": MERGE_EVENT,
                        "derivation": "human_correction",
                        "supersedes_artifact_id": ARTIFACT,
                        "depth": 1,
                    },
                    {
                        "artifact_id": ARTIFACT,
                        "event_id": EDGE_EVENT,
                        "derivation": "direct",
                        "supersedes_artifact_id": None,
                        "depth": 2,
                    },
                ])
            return Cursor([{
                "artifact_id": ARTIFACT,
                "event_id": EDGE_EVENT,
                "derivation": "direct",
                "supersedes_artifact_id": None,
                "depth": 0,
            }])
        return Cursor()


class ExtractionConnection(LineageConnection):
    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if "active=true" in sql and "derived_text_artifact" in sql and "artifact_id" in sql:
            return Cursor([{
                "artifact_id": CORRECTED,
                "event_id": UNDO_EVENT,
                "derivation": "human_correction",
                "room_seq": 10,
            }])
        if "WITH RECURSIVE artifact_ancestry" in sql:
            return LineageConnection.execute(self, sql, params)
        return Cursor()


class AnalyticsCorrectionTests(unittest.TestCase):
    def test_review_status_and_replace_text_create_an_active_corrected_artifact(self):
        connection = ArtifactConnection()
        review = detail(UNDO_EVENT, {
            "targetType": "derived_text",
            "targetId": ARTIFACT,
            "decision": "approve",
            "rationale": "來源一致。",
            "expectedAnalysisEpoch": EPOCH,
            "expectedProjectionVersion": 1,
        })
        correction = detail(MERGE_EVENT, {
            **common("replace_text"),
            "targetArtifactId": ARTIFACT,
            "replacement": {"text": "修正後文字", "languageTag": "zh-Hant"},
        })
        _apply_artifact_reviews(connection, ROOM, [review, correction])

        status_updates = [call for call in connection.calls if "SET review_status=" in call[0]]
        self.assertTrue(any(params[0] == "approved" and params[-1] == ARTIFACT for _, params in status_updates))
        insert = next(call for call in connection.calls if "INSERT INTO derived_text_artifact" in call[0])
        self.assertIn("修正後文字", insert[1])
        self.assertIn("human_correction", insert[1])
        self.assertIn("corrected", insert[1])

        source = [{"eventId": EDGE_EVENT, "payload": {"text": "原文", "messageId": ARTIFACT}}]
        effective = _effective_events(connection, ROOM, source)
        self.assertEqual(effective[0]["payload"]["text"], "修正後文字")
        self.assertEqual(source[0]["payload"]["text"], "原文")

    def test_replace_text_compares_uuid_and_every_immutable_persistence_field(self):
        correction = detail(MERGE_EVENT, {
            **common("replace_text"),
            "targetArtifactId": ARTIFACT,
            "replacement": {"text": "修正後文字", "languageTag": "zh-Hant"},
        })
        connection = StatefulArtifactConnection()
        _apply_artifact_reviews(connection, ROOM, [correction])
        corrected = next(row for key, row in connection.rows.items() if key != ARTIFACT)
        self.assertEqual(str(corrected["source_media_id"]), MEDIA)
        self.assertEqual(corrected["event_id"], MERGE_EVENT)
        self.assertEqual(corrected["room_seq"], 10)

        corruptions = (
            {"source_media_id": UUID("00000000-0000-4000-8000-000000000099")},
            {"source_confidence_raw": 0.7},
            {"source_confidence_calibrated": 0.9},
            {"spans": [{"start": 0, "end": 1}]},
            {"warnings": ["SILENT_DRIFT"]},
            {"provider": "wrong-provider"},
        )
        for persisted_overrides in corruptions:
            with self.subTest(persisted_overrides=persisted_overrides):
                corrupt = StatefulArtifactConnection(persisted_overrides=persisted_overrides)
                with self.assertRaisesRegex(ValueError, "PERSISTENCE"):
                    _apply_artifact_reviews(corrupt, ROOM, [correction])

    def test_correction_then_approve_or_reject_is_idempotent_across_later_replays(self):
        for decision, expected in (("approve", "approved"), ("reject", "rejected")):
            with self.subTest(decision=decision):
                connection = StatefulArtifactConnection()
                correction = detail(MERGE_EVENT, {
                    **common("replace_text"),
                    "targetArtifactId": ARTIFACT,
                    "replacement": {"text": "修正後文字", "languageTag": "zh-Hant"},
                })
                _apply_artifact_reviews(connection, ROOM, [correction])
                corrected_id = next(key for key in connection.rows if key != ARTIFACT)
                review = detail(UNDO_EVENT, {
                    "targetType": "derived_text",
                    "targetId": corrected_id,
                    "decision": decision,
                    "rationale": "人工修正已完成後續審閱。",
                    "expectedAnalysisEpoch": EPOCH,
                    "expectedProjectionVersion": 2,
                })
                _apply_artifact_reviews(connection, ROOM, [correction, review])
                self.assertEqual(connection.rows[corrected_id]["review_status"], expected)
                _apply_artifact_reviews(connection, ROOM, [correction, review])
                self.assertEqual(connection.rows[corrected_id]["review_status"], expected)

    def test_multilevel_human_correction_resolves_the_original_source_event(self):
        connection = LineageConnection()
        self.assertEqual(_artifact_source_event_id(connection, ROOM, CORRECTED), EDGE_EVENT)
        source = [{"eventId": EDGE_EVENT, "payload": {"text": "原文", "messageId": ARTIFACT}}]
        effective = _effective_events(connection, ROOM, source)
        self.assertEqual(effective[0]["payload"]["text"], "第二次修正後文字")

    def test_corrected_artifact_extraction_uses_root_event_but_correction_sequence(self):
        connection = ExtractionConnection()
        chat = SimpleNamespace(
            event_id=EDGE_EVENT,
            revision=1,
            text="太陽提供能量給生產者。",
            source_confidence=1.0,
        )
        _persist_extractions(connection, ROOM, [chat])
        insert = next(call for call in connection.calls if "INSERT INTO extraction_artifacts" in call[0])
        self.assertEqual(insert[1][1], CORRECTED)
        self.assertEqual(insert[1][3], 10)

    def test_only_explicit_approve_publishes_and_evidence_maps_through_event_id(self):
        projection_id = echo_wire_edge_id(ROOM, internal()["edges"][0])
        rich = AllowlistConnection([
            {
                "targetType": "projection", "targetId": projection_id,
                "decision": "review_pass", "rationale": "品質檢查通過但未核准發布。",
                "expectedAnalysisEpoch": EPOCH, "expectedProjectionVersion": 1,
            },
            {
                "targetType": "evidence", "targetId": EDGE_EVENT,
                "decision": "review_concerns", "rationale": "只記錄品質疑慮。",
                "expectedAnalysisEpoch": EPOCH, "expectedProjectionVersion": 1,
            },
            {
                "targetType": "derived_text", "targetId": CORRECTED,
                "decision": "review_fail", "rationale": "品質檢查失敗不等於撤銷。",
                "expectedAnalysisEpoch": EPOCH, "expectedProjectionVersion": 1,
            },
        ])
        approvals, _ = _review_allowlist(rich, ROOM, 10)
        self.assertEqual(approvals, set())

        explicit = AllowlistConnection([
            {
                "targetType": "evidence", "targetId": EDGE_EVENT,
                "decision": "approve", "rationale": "批准此證據。",
                "expectedAnalysisEpoch": EPOCH, "expectedProjectionVersion": 1,
            },
            {
                "targetType": "derived_text", "targetId": CORRECTED,
                "decision": "approve", "rationale": "批准此衍生文字。",
                "expectedAnalysisEpoch": EPOCH, "expectedProjectionVersion": 1,
            },
        ])
        approvals, _ = _review_allowlist(explicit, ROOM, 10)
        edge_ids = _approved_echo_edge_ids(
            ROOM,
            internal(),
            {"source": {"eventId": EDGE_EVENT, "start": 0, "end": 3}},
            approvals,
        )
        self.assertEqual(edge_ids, {projection_id})

        explicit_then_rich_fail = AllowlistConnection([
            {
                "targetType": "projection", "targetId": projection_id,
                "decision": "approve", "rationale": "批准發布。",
                "expectedAnalysisEpoch": EPOCH, "expectedProjectionVersion": 1,
            },
            {
                "targetType": "projection", "targetId": projection_id,
                "decision": "review_fail", "rationale": "品質標記不等於撤銷。",
                "expectedAnalysisEpoch": EPOCH, "expectedProjectionVersion": 2,
            },
        ])
        approvals, _ = _review_allowlist(explicit_then_rich_fail, ROOM, 10)
        self.assertIn(projection_id, approvals)

    def test_all_projection_correction_branches_transform_or_retract_the_server_target(self):
        base = internal()
        original_edge_id = echo_wire_edge_id(ROOM, base["edges"][0])
        evidence = {"source": {"eventId": EDGE_EVENT, "start": 0, "end": 3}}

        relation = detail(MERGE_EVENT, {
            **common("replace_relation"),
            "targetProjectionEdgeId": original_edge_id,
            "replacement": {"head": "producer", "predicate": "receives", "tail": "sun", "relationFamily": "energy_flow"},
        })
        projected, _ = _apply_projection_corrections(ROOM, base, evidence, [relation])
        self.assertEqual((projected["edges"][0]["head"], projected["edges"][0]["predicate"]), ("producer", "receives"))

        span = detail(MERGE_EVENT, {
            **common("replace_evidence_span"),
            "targetProjectionEdgeId": original_edge_id,
            "target": {"eventId": EDGE_EVENT, "start": 0, "end": 3},
            "replacement": {"eventId": REPLACEMENT_EVENT, "start": 1, "end": 4},
        })
        projected, refs = _apply_projection_corrections(ROOM, base, evidence, [span])
        replacement_key = projected["edges"][0]["evidenceIds"][0]
        self.assertEqual(refs[replacement_key], {"eventId": REPLACEMENT_EVENT, "start": 1, "end": 4})

        merge = detail(MERGE_EVENT, {
            **common("merge_alias"),
            "targetCanonicalNodeId": "producer",
            "replacement": {"aliasNodeId": "plant"},
        })
        projected, _ = _apply_projection_corrections(ROOM, base, evidence, [merge])
        self.assertNotIn("plant", {node["nodeId"] for node in projected["nodes"]})
        self.assertEqual(projected["edges"][0]["head"], "producer")

        split = detail(MERGE_EVENT, {
            **common("split_alias"),
            "targetCanonicalNodeId": "producer",
            "replacement": {"aliasNodeId": "plant", "newCanonicalNodeId": "flora", "newLabel": "植物群"},
        })
        projected, _ = _apply_projection_corrections(ROOM, base, evidence, [split])
        self.assertIn({"nodeId": "flora", "label": "植物群", "x": 0.2, "y": 0.2}, projected["nodes"])
        self.assertEqual(projected["edges"][0]["head"], "flora")

        undo = detail(UNDO_EVENT, {
            **common("undo_merge"),
            "targetCorrectionEventId": MERGE_EVENT,
            "replacement": {},
        })
        projected, _ = _apply_projection_corrections(ROOM, base, evidence, [merge, undo])
        self.assertEqual(projected, base)

        retract = detail(MERGE_EVENT, {
            **common("retract"),
            "targetType": "projection",
            "targetId": original_edge_id,
            "replacement": {},
        })
        projected, _ = _apply_projection_corrections(ROOM, base, evidence, [retract])
        self.assertEqual(projected["edges"], [])

        retract_evidence = detail(MERGE_EVENT, {
            **common("retract"),
            "targetType": "evidence",
            "targetId": EDGE_EVENT,
            "replacement": {},
        })
        projected, _ = _apply_projection_corrections(ROOM, base, evidence, [retract_evidence])
        self.assertEqual(projected["edges"], [])

        self.assertEqual(base, internal(), "correction overlay must not mutate the reference snapshot")


if __name__ == "__main__":
    unittest.main()
