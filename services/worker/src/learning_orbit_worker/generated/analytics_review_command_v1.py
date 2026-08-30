"""Generated-style closed parser for analytics-review-command.v1.

The TypeScript AJV contract is the canonical source.  This small ingress
codec mirrors its tagged union so a worker never accepts a correction branch
with a target or replacement belonging to another kind.
"""
from __future__ import annotations

from dataclasses import dataclass
from ._validation import exact_object, integer, optional_uuid, uuid, fail

_CODE = "INVALID_ANALYTICS_REVIEW_COMMAND"
_REVIEW = {"targetType", "targetId", "decision", "rationale", "expectedAnalysisEpoch", "expectedProjectionVersion"}
_DECISIONS = {"review_pass", "review_concerns", "review_fail", "approve", "reject", "revoke"}
_TARGET_TYPES = {"derived_text", "evidence", "projection"}


def _text(value: object, minimum: int, maximum: int) -> None:
    if not isinstance(value, str) or not minimum <= len(value) <= maximum:
        fail(_CODE)


def _common(v: dict[str, object], kind: str, required: set[str]) -> None:
    if set(v) != required:
        fail(_CODE)
    if v.get("correctionKind") != kind:
        fail(_CODE)
    _text(v["reason"], 1, 2000)
    uuid(v["expectedAnalysisEpoch"], _CODE)
    integer(v["expectedProjectionVersion"], _CODE, minimum=1)


def _evidence(value: object) -> None:
    if not isinstance(value, dict) or set(value) != {"eventId", "start", "end"}:
        fail(_CODE)
    uuid(value["eventId"], _CODE)
    integer(value["start"], _CODE, minimum=0)
    integer(value["end"], _CODE, minimum=1)
    if value["end"] <= value["start"]:
        fail(_CODE)


def _relation(value: object) -> None:
    if not isinstance(value, dict) or set(value) != {"head", "predicate", "tail", "relationFamily"}:
        fail(_CODE)
    for key, limit in (("head", 160), ("predicate", 160), ("tail", 160), ("relationFamily", 80)):
        _text(value[key], 1, limit)


def _alias(value: object, *, split: bool) -> None:
    if not isinstance(value, dict):
        fail(_CODE)
    expected = {"aliasNodeId", "newCanonicalNodeId", "newLabel"} if split else {"aliasNodeId"}
    if set(value) != expected:
        fail(_CODE)
    for key in expected:
        _text(value[key], 1, 160)


@dataclass(frozen=True, slots=True)
class Request:
    value: dict[str, object]

    @classmethod
    def from_dict(cls, value: object) -> "Request":
        if not isinstance(value, dict):
            fail(_CODE)
        if set(value) == _REVIEW:
            if value["targetType"] not in _TARGET_TYPES or value["decision"] not in _DECISIONS:
                fail(_CODE)
            uuid(value["targetId"], _CODE)
            uuid(value["expectedAnalysisEpoch"], _CODE)
            integer(value["expectedProjectionVersion"], _CODE, minimum=1)
            _text(value["rationale"], 1, 2000)
            return cls(value)

        kind = value.get("correctionKind")
        if kind == "replace_text":
            _common(value, kind, {"targetArtifactId", "correctionKind", "replacement", "reason", "expectedAnalysisEpoch", "expectedProjectionVersion"})
            uuid(value["targetArtifactId"], _CODE)
            replacement = value["replacement"]
            if not isinstance(replacement, dict) or set(replacement) != {"text", "languageTag"}:
                fail(_CODE)
            _text(replacement["text"], 1, 20000); _text(replacement["languageTag"], 2, 35)
        elif kind == "replace_evidence_span":
            _common(value, kind, {"targetProjectionEdgeId", "correctionKind", "target", "replacement", "reason", "expectedAnalysisEpoch", "expectedProjectionVersion"})
            uuid(value["targetProjectionEdgeId"], _CODE); _evidence(value["target"]); _evidence(value["replacement"])
        elif kind == "replace_relation":
            _common(value, kind, {"targetProjectionEdgeId", "correctionKind", "replacement", "reason", "expectedAnalysisEpoch", "expectedProjectionVersion"})
            uuid(value["targetProjectionEdgeId"], _CODE); _relation(value["replacement"])
        elif kind == "merge_alias":
            _common(value, kind, {"targetCanonicalNodeId", "correctionKind", "replacement", "reason", "expectedAnalysisEpoch", "expectedProjectionVersion"})
            _text(value["targetCanonicalNodeId"], 1, 160); _alias(value["replacement"], split=False)
            if value["targetCanonicalNodeId"] == value["replacement"]["aliasNodeId"]: fail(_CODE)
        elif kind == "split_alias":
            _common(value, kind, {"targetCanonicalNodeId", "correctionKind", "replacement", "reason", "expectedAnalysisEpoch", "expectedProjectionVersion"})
            _text(value["targetCanonicalNodeId"], 1, 160); _alias(value["replacement"], split=True)
            replacement = value["replacement"]
            if value["targetCanonicalNodeId"] in {replacement["aliasNodeId"], replacement["newCanonicalNodeId"]} or replacement["aliasNodeId"] == replacement["newCanonicalNodeId"]: fail(_CODE)
        elif kind == "undo_merge":
            _common(value, kind, {"targetCorrectionEventId", "correctionKind", "replacement", "reason", "expectedAnalysisEpoch", "expectedProjectionVersion"})
            uuid(value["targetCorrectionEventId"], _CODE)
            exact_object(value["replacement"], set(), _CODE)
        elif kind == "retract":
            _common(value, kind, {"targetType", "targetId", "correctionKind", "replacement", "reason", "expectedAnalysisEpoch", "expectedProjectionVersion"})
            if value["targetType"] not in _TARGET_TYPES: fail(_CODE)
            uuid(value["targetId"], _CODE); exact_object(value["replacement"], set(), _CODE)
        else:
            fail(_CODE)
        return cls(value)


__all__ = ["Request"]
