"""TRACE-AI role-aware, lineage-preserving projection adapter."""
from __future__ import annotations

import hashlib
import hmac
import json
import math
from typing import Any, Mapping
from uuid import UUID, uuid5

TRACE_EDGE_NAMESPACE = UUID("7dd764bf-8848-5e96-8683-6f14bd1f7941")
TRACE_STUDENT_INTERPRETATION_ZH_HANT = (
    "此圖呈現系統觀測到的近期互動事件，不等同友情、地位、能力、"
    "貢獻價值、學習成績、心理關係或 Agent 因果效果。"
)
STUDENT_EDGE_LAYERS = {"communication", "uptake"}
STUDENT_WARNINGS = {"small_group_interpretation_warning", "recent_group_interaction_only", "requires_replay", "insufficient_window"}


def trace_wire_edge_id(room_id: str, edge: Mapping[str, Any]) -> str:
    value = json.dumps([room_id, edge.get("edgeId"), edge["sourceId"], edge["targetId"], edge["layer"]], separators=(",", ":"))
    return str(uuid5(TRACE_EDGE_NAMESPACE, value))


def scoped_node_id(room_pseudonym_key: bytes, room_id: str, analysis_epoch: str, internal_node_id: str) -> str:
    digest = hmac.new(room_pseudonym_key, (room_id + "\0" + analysis_epoch + "\0" + internal_node_id).encode(), hashlib.sha256).hexdigest()
    return "p-" + digest[:16]


def _metrics(snapshot: Mapping[str, Any]) -> dict[str, float]:
    raw = snapshot.get("metrics")
    if not isinstance(raw, Mapping):
        raise ValueError("INVALID_TRACE_METRICS")

    def bounded(*names: str) -> float:
        marker = object()
        value: Any = marker
        for name in names:
            if name in raw:
                value = raw[name]
                break
        if value is marker or isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("INVALID_TRACE_METRICS")
        result = float(value)
        if not math.isfinite(result) or not 0.0 <= result <= 1.0:
            raise ValueError("INVALID_TRACE_METRICS")
        return result

    reciprocity = bounded("weightedReciprocity", "reciprocity")
    if "weightedReciprocity" in raw and "reciprocity" in raw \
            and reciprocity != bounded("reciprocity"):
        raise ValueError("INVALID_TRACE_METRICS")
    return {
        "participationBalance": bounded("participationBalance"),
        "reciprocity": reciprocity,
        "agentShare": bounded("agentShare"),
        "semanticCoverage": bounded("semanticCoverage"),
    }


def _normalize_view(snapshot: Mapping[str, Any], view: str, evidence_index: Mapping[str, Mapping[str, Any]], room_id: str) -> dict[str, Any]:
    # Accept both a single SnaSnapshot.to_dict() and a wrapper with views.
    if "views" in snapshot and view in snapshot["views"]:
        source = snapshot["views"][view]
    else:
        source = snapshot
    nodes = [dict(node) for node in source.get("nodes", ())]
    node_kind = {n["nodeId"]: n.get("actorKind", n.get("kind", "human")) for n in nodes}
    edges: list[dict[str, Any]] = []
    for edge in source.get("edges", ()):
        edge = dict(edge)
        src, dst = str(edge["sourceId"]), str(edge["targetId"])
        layer = str(edge["layer"])
        if view == "human_only" and (
            node_kind.get(src) not in {"human", "learner"}
            or node_kind.get(dst) not in {"human", "learner"}
        ):
            continue
        if view == "lineage_adjusted" and layer != "uptake":
            continue
        evidence_refs = []
        for evidence_id in edge.get("evidenceIds", ()):
            if evidence_id not in evidence_index:
                raise ValueError("unknown TRACE evidence")
            source_ref = evidence_index[evidence_id]
            basis = str(source_ref.get("basis", "text_span"))
            start = source_ref.get("start")
            end = source_ref.get("end")
            if basis == "event_metadata":
                start = end = None
            elif start is None or end is None or not isinstance(start, int) or isinstance(start, bool) \
                    or not isinstance(end, int) or isinstance(end, bool) or end <= start:
                raise ValueError("TRACE text evidence requires a valid span")
            evidence_refs.append({"eventId": str(source_ref["eventId"]), "start": start, "end": end, "basis": basis})
        if view == "lineage_adjusted" and not evidence_refs:
            continue
        raw_channels = edge.get("channels")
        if not isinstance(raw_channels, Mapping):
            raise ValueError("INVALID_TRACE_EDGE")
        channels: dict[str, float] = {}
        for key in ("positive", "challenge", "uncertain"):
            value = raw_channels.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError("INVALID_TRACE_EDGE")
            numeric = float(value)
            if not math.isfinite(numeric) or numeric < 0:
                raise ValueError("INVALID_TRACE_EDGE")
            channels[key] = numeric
        raw_weight = edge.get("weight")
        if isinstance(raw_weight, bool) or not isinstance(raw_weight, (int, float)):
            raise ValueError("INVALID_TRACE_EDGE")
        weight = float(raw_weight)
        if not math.isfinite(weight) or weight <= 0:
            raise ValueError("INVALID_TRACE_EDGE")
        # Always issue a room-scoped UUID.  Passing through an upstream string
        # would allow non-UUID IDs and could collide across projection views.
        edges.append({"edgeId": trace_wire_edge_id(room_id, edge), "sourceId": src, "targetId": dst, "layer": layer, "channels": channels, "weight": weight, "evidenceRefs": evidence_refs})
    ids = {n["nodeId"] for n in nodes}
    if view == "human_only":
        nodes = [n for n in nodes if node_kind.get(n["nodeId"]) in {"human", "learner"}]
        ids = {n["nodeId"] for n in nodes}
    elif view == "lineage_adjusted":
        endpoint_ids = {e["sourceId"] for e in edges} | {e["targetId"] for e in edges}
        nodes = [n for n in nodes if n["nodeId"] in endpoint_ids]
        ids = endpoint_ids
    edges = [e for e in edges if e["sourceId"] in ids and e["targetId"] in ids]
    metrics = _metrics(source)
    warnings = list(source.get("warnings", snapshot.get("warnings", ())))
    return {"nodes": nodes, "edges": edges, "metrics": metrics, "warnings": warnings}


def validate_internal_views(views: Mapping[str, Mapping[str, Any]]) -> None:
    expected = {"observed", "human_only", "lineage_adjusted"}
    if set(views) != expected:
        raise ValueError("TRACE bundle requires exactly three views")
    human = views["human_only"]
    human_ids = {n["nodeId"] for n in human["nodes"]}
    if any(n.get("actorKind", n.get("kind")) not in {"human", "learner"} for n in human["nodes"]):
        raise ValueError("human_only contains Agent or ROOM")
    if any(e["sourceId"] not in human_ids or e["targetId"] not in human_ids for e in human["edges"]):
        raise ValueError("human_only edge leaves human node set")
    lineage = views["lineage_adjusted"]
    lineage_ids = {n["nodeId"] for n in lineage["nodes"]}
    if any(e.get("layer") != "uptake" or not e.get("evidenceRefs") or e["sourceId"] not in lineage_ids or e["targetId"] not in lineage_ids for e in lineage["edges"]):
        raise ValueError("lineage_adjusted requires evidence-backed uptake")


def _single(reference: Mapping[str, Any], window_name: str, metadata: Mapping[str, Any], pseudonyms: Mapping[str, Mapping[str, Any]], evidence_index: Mapping[str, Mapping[str, Any]], human_count: int) -> tuple[dict[str, Any], dict[str, Any]]:
    views = {name: _normalize_view(reference, name, evidence_index, str(metadata["roomId"])) for name in ("observed", "human_only", "lineage_adjusted")}
    validate_internal_views(views)
    teacher_views, student_views = {}, {}
    teacher_actor_mapping = metadata.get("teacherActorMapping")
    if not isinstance(teacher_actor_mapping, Mapping):
        raise ValueError("INVALID_TRACE_ACTOR_MAPPING")
    for name, internal in views.items():
        warnings = list(internal["warnings"])
        if window_name == "recent_10m" and "recent_group_interaction_only" not in warnings:
            warnings.append("recent_group_interaction_only")
        if human_count < 5 and "small_group_interpretation_warning" not in warnings:
            warnings.append("small_group_interpretation_warning")
        teacher_nodes = []
        for node in internal["nodes"]:
            actor = node.get("actorKind", node.get("kind", "human"))
            node_id = node.get("nodeId")
            mapping = teacher_actor_mapping.get(node_id) if isinstance(node_id, str) else None
            expected_kind = "learner" if actor in {"human", "learner"} else actor
            if not isinstance(mapping, Mapping) or mapping.get("kind") != expected_kind \
                    or not isinstance(mapping.get("pseudonym"), str) \
                    or not 1 <= len(mapping["pseudonym"]) <= 160:
                raise ValueError("INVALID_TRACE_ACTOR_MAPPING")
            teacher_nodes.append({
                "nodeId": node_id,
                "label": mapping["pseudonym"],
                "kind": expected_kind,
            })
        teacher_views[name] = {"nodes": teacher_nodes, "edges": internal["edges"], "metrics": internal["metrics"], "warnings": warnings}
        # The student branch is intentionally narrower than the teacher
        # observed view.  A teacher may inspect the virtual ROOM and Nova
        # facilitation nodes, while the generated StudentView contract allows
        # only pseudonymous learner nodes.  Filter on both the reference node
        # kind and the server-side pseudonym record so a malformed actor index
        # cannot relabel an Agent/ROOM as a learner.
        learner_nodes = [
            n for n in internal["nodes"]
            if n["nodeId"] in pseudonyms
            and n.get("actorKind", n.get("kind", "human")) in {"human", "learner"}
            and pseudonyms[n["nodeId"]].get("kind") == "learner"
        ]
        learner_ids = {n["nodeId"] for n in learner_nodes}
        student_nodes = [
            {
                "nodeId": str(pseudonyms[n["nodeId"]]["nodeId"]),
                "label": str(pseudonyms[n["nodeId"]]["label"]),
                "kind": "learner",
            }
            for n in learner_nodes
        ]
        student_edges = []
        for edge in internal["edges"]:
            if edge["layer"] not in STUDENT_EDGE_LAYERS:
                continue
            if edge["sourceId"] not in learner_ids or edge["targetId"] not in learner_ids:
                continue
            src, dst = pseudonyms.get(edge["sourceId"]), pseudonyms.get(edge["targetId"])
            if src and dst and src.get("kind") == "learner" and dst.get("kind") == "learner":
                student_edges.append({"sourceNodeId": src["nodeId"], "targetNodeId": dst["nodeId"], "layer": edge["layer"]})
        student_views[name] = {"nodes": student_nodes, "edges": student_edges, "metrics": internal["metrics"], "warnings": [w for w in warnings if w in STUDENT_WARNINGS]}
    teacher = {"payload": {"views": teacher_views}}
    student = {"payload": {"views": student_views}}
    return teacher, student


def project_trace(reference_snapshots: Mapping[str, Mapping[str, Any]], window_bounds: Mapping[str, Mapping[str, Any]], metadata: Mapping[str, Any], pseudonym_index: Mapping[str, Mapping[str, Any]], evidence_index: Mapping[str, Mapping[str, Any]], human_count: int = 4) -> tuple[dict[str, Any], dict[str, Any]]:
    if set(reference_snapshots) != {"recent_10m", "session_45m"}:
        raise ValueError("TRACE requires both fixed windows")
    teacher_windows, student_windows = {}, {}
    for window in ("recent_10m", "session_45m"):
        teacher, student = _single(reference_snapshots[window], window, metadata, pseudonym_index, evidence_index, human_count)
        bounds = window_bounds[window]
        base = {"windowStartEventTime": bounds["windowStartEventTime"], "windowEndEventTime": bounds["windowEndEventTime"]}
        teacher_windows[window] = {**base, "views": teacher["payload"]["views"]}
        student_windows[window] = {**base, "views": student["payload"]["views"]}
    common = {"schemaVersion": 1, "roomId": metadata["roomId"], "analysisEpoch": metadata["analysisEpoch"], "algorithmVersion": metadata["algorithmVersion"], "parameterHash": metadata["parameterHash"], "projectionVersion": metadata["projectionVersion"], "baseVersion": metadata.get("baseVersion", 0), "completeThroughRoomSeq": metadata.get("completeThroughRoomSeq", 0), "watermarkEventTime": metadata["watermarkEventTime"], "requiresReplay": bool(metadata.get("requiresReplay", False)), "evidenceStatus": "requires_replay" if metadata.get("requiresReplay") else "active"}
    actor_mapping = {}
    for actor_id, value in (metadata.get("teacherActorMapping", metadata.get("actorMapping", {})) or {}).items():
        if value.get("kind") == "room":
            actor_mapping[str(actor_id)] = {
                "roomId": str(value["roomId"]),
                "pseudonym": str(value["pseudonym"]),
                "kind": "room",
            }
        else:
            actor_mapping[str(actor_id)] = {
                "actorId": str(value["actorId"]),
                "pseudonym": str(value["pseudonym"]),
                "kind": str(value["kind"]),
            }
    teacher = {**common, "projectionKey": "trace.teacher_bundle", "reviewStatus": "unreviewed", "displayStatus": "teacher_shadow", "warnings": list(metadata.get("warnings", ())), "payload": {"windows": teacher_windows, "actorMapping": actor_mapping}}
    student_warnings = [w for w in metadata.get("warnings", ()) if w in STUDENT_WARNINGS]
    if human_count < 5 and "small_group_interpretation_warning" not in student_warnings:
        student_warnings.append("small_group_interpretation_warning")
    student = {**common, "projectionKey": "trace.student_bundle", "reviewStatus": "approved", "displayStatus": "student_aggregate", "warnings": student_warnings, "payload": {"windows": student_windows, "interpretation": TRACE_STUDENT_INTERPRETATION_ZH_HANT}}
    return teacher, student
