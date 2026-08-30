"""ECHO-CM adapter: converts reference snapshots into closed wire-shaped dicts."""
from __future__ import annotations

import json
import math
from unicodedata import normalize
from uuid import UUID, uuid5
from typing import Any, Mapping

ECHO_EDGE_NAMESPACE = UUID("e9dd1cf5-3f28-5fe7-9d73-8f98f8bca0e1")
ADAPTER_VERSION = "echo-cm-reference-v1+adapter-v1"


def normalize_position(value: float) -> float:
    value = float(value)
    if not math.isfinite(value) or not -1.0 <= value <= 1.0:
        raise ValueError("reference ECHO position outside [-1,1]")
    return round((value + 1.0) / 2.0, 12)


def node_evidence_status(node_id: str, edges: list[dict[str, Any]]) -> str:
    incident = [edge for edge in edges if node_id in (edge.get("head"), edge.get("tail"))]
    support = any(float(edge.get("channels", {}).get("support", 0)) > 0 for edge in incident)
    challenge = any(float(edge.get("channels", {}).get("challenge", 0)) > 0 for edge in incident)
    if support and challenge:
        return "disputed"
    if support:
        return "supported"
    if challenge:
        return "challenged"
    return "uncertain"


def visual_status(evidence_status: str, approved: bool, inactive: bool = False) -> str:
    if inactive:
        return "inactive"
    if evidence_status == "disputed":
        return "disputed"
    if approved and evidence_status == "supported":
        return "confirmed"
    return "provisional"


def echo_wire_edge_id(room_id: str, edge: Mapping[str, Any]) -> str:
    family = edge.get("relationFamily", edge.get("relation_family", ""))
    predicate = edge.get("predicate", edge.get("linkPhrase", edge.get("link_phrase", "")))
    name = json.dumps([room_id, normalize("NFC", str(edge["head"])), normalize("NFC", str(predicate)), normalize("NFC", str(edge["tail"])), normalize("NFC", str(family))], ensure_ascii=False, separators=(",", ":"))
    return str(uuid5(ECHO_EDGE_NAMESPACE, name))


def _canonical_edges(internal: Mapping[str, Any]) -> list[dict[str, Any]]:
    edges = internal.get("edges", ())
    result: list[dict[str, Any]] = []
    for raw in edges:
        edge = dict(raw)
        channels = dict(edge.get("channels", {}))
        # Reference uses "status" and accumulated channels (not confidence).
        status = str(edge.get("status", edge.get("evidenceStatus", "uncertain")))
        refs = edge.get("evidenceIds", edge.get("evidence_ids", ()))
        result.append({"head": str(edge["head"]), "predicate": str(edge.get("predicate", edge.get("linkPhrase", "relates to"))), "tail": str(edge["tail"]), "relationFamily": str(edge.get("relationFamily", "evidence")), "status": status, "channels": channels, "evidenceIds": tuple(str(value) for value in refs)})
    return result


def _evidence_ref(ref: Mapping[str, Any]) -> dict[str, Any]:
    event_id = str(ref.get("eventId", ref.get("event_id", "")))
    start, end = ref.get("start"), ref.get("end")
    if not event_id:
        raise ValueError("ECHO evidence requires eventId")
    if (
        isinstance(start, bool) or isinstance(end, bool)
        or not isinstance(start, int) or not isinstance(end, int)
        or start is None or end is None
    ):
        raise ValueError("ECHO evidence requires a text span")
    out = {"eventId": event_id, "start": start, "end": end}
    if out["end"] <= out["start"]:
        raise ValueError("invalid ECHO evidence span")
    return out


def project_echo_snapshot(internal: Mapping[str, Any], metadata: Mapping[str, Any], evidence_index: Mapping[str, Mapping[str, Any]], approved_edge_ids: set[str] | None = None, approved_node_ids: set[str] | None = None) -> dict[str, dict[str, Any]]:
    approved_edge_ids = approved_edge_ids or set()
    approved_node_ids = approved_node_ids or set()
    edges = _canonical_edges(internal)
    teacher_edges: list[dict[str, Any]] = []
    student_edges: list[dict[str, Any]] = []
    endpoints: set[str] = set()
    for edge in edges:
        wire_id = echo_wire_edge_id(str(metadata["roomId"]), edge)
        evidence_refs = []
        for evidence_id in edge["evidenceIds"]:
            if evidence_id not in evidence_index:
                raise ValueError(f"unknown ECHO evidence: {evidence_id}")
            evidence_refs.append(_evidence_ref(evidence_index[evidence_id]))
        channels = {name: float(edge["channels"].get(name, 0.0)) for name in ("support", "challenge", "uncertain", "question")}
        if any(not math.isfinite(value) or value < 0 for value in channels.values()):
            raise ValueError("ECHO channels must be finite and non-negative")
        projected = {"edgeId": wire_id, "head": edge["head"], "predicate": edge["predicate"], "tail": edge["tail"], "relationFamily": edge["relationFamily"], "evidenceStatus": edge["status"], "reviewStatus": "approved" if wire_id in approved_edge_ids else "unreviewed", "displayStatus": visual_status(edge["status"], wire_id in approved_edge_ids), "channels": channels, "activityScore": max(channels.values()), "evidenceRefs": evidence_refs}
        teacher_edges.append(projected)
        if wire_id in approved_edge_ids:
            student_edges.append({
                key: projected[key]
                for key in (
                    "edgeId", "head", "predicate", "tail", "relationFamily",
                    "evidenceStatus", "reviewStatus", "displayStatus",
                )
            })
            endpoints.update((edge["head"], edge["tail"]))
    student_ids = set(approved_node_ids) | endpoints
    teacher_nodes: list[dict[str, Any]] = []
    student_nodes: list[dict[str, Any]] = []
    for raw in internal.get("nodes", ()):
        node = dict(raw)
        node_id = str(node["nodeId"])
        status = node_evidence_status(node_id, edges)
        projected = {"nodeId": node_id, "label": str(node.get("label", node_id)), "nodeKind": "concept", "evidenceStatus": status, "reviewStatus": "approved" if node_id in student_ids else "unreviewed", "displayStatus": visual_status(status, node_id in student_ids), "position": {"x": normalize_position(node["x"]), "y": normalize_position(node["y"])}}
        teacher_nodes.append(projected)
        if node_id in student_ids:
            student_nodes.append(projected)
    common = {"schemaVersion": 1, "roomId": metadata["roomId"], "analysisEpoch": metadata["analysisEpoch"], "algorithmVersion": metadata.get("algorithmVersion", ADAPTER_VERSION), "parameterHash": metadata["parameterHash"], "projectionVersion": int(metadata["projectionVersion"]), "baseVersion": int(metadata.get("baseVersion", 0)), "completeThroughRoomSeq": int(metadata.get("completeThroughRoomSeq", 0)), "watermarkEventTime": metadata["watermarkEventTime"], "requiresReplay": bool(metadata.get("requiresReplay", False)), "evidenceStatus": "requires_replay" if metadata.get("requiresReplay") else "active", "warnings": list(metadata.get("warnings", ())) }
    return {"teacher": {**common, "projectionKey": "echo.teacher_shadow", "reviewStatus": "unreviewed", "displayStatus": "teacher_shadow", "payload": {"nodes": teacher_nodes, "edges": teacher_edges}}, "student": {**common, "projectionKey": "echo.student_approved", "reviewStatus": "approved" if student_nodes or student_edges else "unreviewed", "displayStatus": "student_approved", "payload": {"nodes": student_nodes, "edges": student_edges}}}


def diff_echo_snapshots(previous: Mapping[str, Any], current: Mapping[str, Any], metadata: Mapping[str, Any]) -> dict[str, Any]:
    prev_nodes = {n["nodeId"]: n for n in previous.get("payload", {}).get("nodes", ())}
    cur_nodes = {n["nodeId"]: n for n in current.get("payload", {}).get("nodes", ())}
    prev_edges = {e["edgeId"]: e for e in previous.get("payload", {}).get("edges", ())}
    cur_edges = {e["edgeId"]: e for e in current.get("payload", {}).get("edges", ())}
    added_nodes = [cur_nodes[k] for k in sorted(cur_nodes.keys() - prev_nodes)]
    updated_nodes = [cur_nodes[k] for k in sorted(cur_nodes.keys() & prev_nodes) if cur_nodes[k] != prev_nodes[k]]
    added_edges = [cur_edges[k] for k in sorted(cur_edges.keys() - prev_edges)]
    updated_edges = [cur_edges[k] for k in sorted(cur_edges.keys() & prev_edges) if cur_edges[k] != prev_edges[k]]
    refs = {}
    for edge in added_edges + updated_edges:
        for ref in edge.get("evidenceRefs", ()):
            refs[(ref["eventId"], ref["start"], ref["end"])] = ref
    changed = len(added_nodes) + len(updated_nodes) + len(prev_nodes.keys() - cur_nodes) + len(added_edges) + len(updated_edges) + len(prev_edges.keys() - cur_edges)
    denominator = max(1, len(prev_nodes) + len(prev_edges))
    patch = {"analysisEpoch": metadata["analysisEpoch"], "algorithmVersion": metadata["algorithmVersion"], "parameterHash": metadata["parameterHash"], "projectionVersion": metadata["projectionVersion"], "baseVersion": metadata.get("baseVersion", 0), "completeThroughRoomSeq": metadata.get("completeThroughRoomSeq", 0), "requiresReplay": bool(metadata.get("requiresReplay", False)), "warnings": list(metadata.get("warnings", ())), "nodesAdded": added_nodes, "nodesUpdated": updated_nodes, "nodesHidden": sorted(prev_nodes.keys() - cur_nodes), "edgesAdded": added_edges, "edgesUpdated": updated_edges, "edgesHidden": sorted(prev_edges.keys() - cur_edges), "positionUpdates": [{"nodeId": n["nodeId"], "x": n["position"]["x"], "y": n["position"]["y"]} for n in added_nodes + updated_nodes], "changeScore": min(1.0, changed / denominator), "reasonCodes": list(metadata.get("reasonCodes", ())) }
    if current.get("projectionKey") != "echo.student_approved":
        patch["evidenceRefs"] = [refs[k] for k in sorted(refs)]
    return patch
