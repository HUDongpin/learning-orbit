"""Generated closed parser for analytics-review-command.v1."""
from __future__ import annotations
from dataclasses import dataclass
from ._validation import exact_object, integer, optional_uuid, uuid, fail

_CODE = "INVALID_ANALYTICS_REVIEW_COMMAND"
_REVIEW = {"targetType", "targetId", "decision", "rationale", "expectedAnalysisEpoch", "expectedProjectionVersion"}
_CORRECTION_REQUIRED = {"correctionKind", "reason", "expectedAnalysisEpoch", "expectedProjectionVersion", "replacement"}
_CORRECTION_OPTIONAL = {"targetArtifactId", "targetProjectionEdgeId", "targetCanonicalNodeId", "targetCorrectionEventId", "targetType", "targetId", "target"}

@dataclass(frozen=True, slots=True)
class Request:
    value: dict[str, object]

    @classmethod
    def from_dict(cls, value: object) -> "Request":
        if not isinstance(value, dict): fail(_CODE)
        if set(value) == _REVIEW:
            if value["targetType"] not in {"derived_text", "evidence", "projection"} or value["decision"] not in {"review_pass", "review_concerns", "review_fail", "approve", "reject", "revoke"}: fail(_CODE)
            uuid(value["targetId"], _CODE); uuid(value["expectedAnalysisEpoch"], _CODE); integer(value["expectedProjectionVersion"], _CODE, minimum=1)
            if not isinstance(value["rationale"], str) or not 1 <= len(value["rationale"]) <= 2000: fail(_CODE)
            return cls(value)
        if set(value) - (_CORRECTION_REQUIRED | _CORRECTION_OPTIONAL) or not _CORRECTION_REQUIRED <= set(value): fail(_CODE)
        if value["correctionKind"] not in {"replace_text", "replace_evidence_span", "replace_relation", "merge_alias", "split_alias", "undo_merge", "retract"}: fail(_CODE)
        if not isinstance(value["reason"], str) or not 1 <= len(value["reason"]) <= 2000: fail(_CODE)
        uuid(value["expectedAnalysisEpoch"], _CODE); integer(value["expectedProjectionVersion"], _CODE, minimum=1)
        for key in ("targetArtifactId", "targetProjectionEdgeId", "targetCorrectionEventId", "targetId"): optional_uuid(value.get(key), _CODE)
        if "targetType" in value and value["targetType"] not in {"derived_text", "evidence", "projection"}: fail(_CODE)
        if "targetCanonicalNodeId" in value and (not isinstance(value["targetCanonicalNodeId"], str) or not 1 <= len(value["targetCanonicalNodeId"]) <= 160): fail(_CODE)
        replacement = value["replacement"]
        if not isinstance(replacement, dict): fail(_CODE)
        # Replacement is intentionally kept closed per correction kind. Unknown fields
        # are rejected here even when a future schema branch is not understood.
        allowed = ({"text", "languageTag"}, {"eventId", "start", "end"}, {"head", "predicate", "tail", "relationFamily"}, {"aliasNodeId"}, {"aliasNodeId", "newCanonicalNodeId", "newLabel"}, set())
        if set(replacement) not in allowed: fail(_CODE)
        if "eventId" in replacement:
            uuid(replacement["eventId"], _CODE); integer(replacement["start"], _CODE, minimum=0); integer(replacement["end"], _CODE, minimum=1)
        if "text" in replacement and (not isinstance(replacement["text"], str) or not 1 <= len(replacement["text"]) <= 20000 or not isinstance(replacement.get("languageTag"), str) or not 2 <= len(replacement["languageTag"]) <= 35): fail(_CODE)
        for key in ("head", "predicate", "tail", "relationFamily", "aliasNodeId", "newCanonicalNodeId", "newLabel"):
            if key in replacement and (not isinstance(replacement[key], str) or not replacement[key]): fail(_CODE)
        return cls(value)
