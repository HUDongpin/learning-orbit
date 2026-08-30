"""Generated closed parser for analysis-projection-envelope.v1."""
from __future__ import annotations
from dataclasses import dataclass
from re import fullmatch
from ._validation import exact_object, integer, timestamp, uuid, fail

_FIELDS = {"schemaVersion", "projectionKey", "roomId", "analysisEpoch", "algorithmVersion", "parameterHash", "projectionVersion", "baseVersion", "completeThroughRoomSeq", "watermarkEventTime", "requiresReplay", "evidenceStatus", "reviewStatus", "displayStatus", "warnings", "payload"}
_CODE = "INVALID_ANALYSIS_PROJECTION_ENVELOPE"

@dataclass(frozen=True, slots=True)
class Envelope:
    value: dict[str, object]

    @classmethod
    def from_dict(cls, value: object) -> "Envelope":
        v = exact_object(value, _FIELDS, _CODE)
        if v["schemaVersion"] != 1 or v["projectionKey"] not in {"echo.teacher_shadow", "echo.student_approved", "trace.teacher_bundle", "trace.student_bundle"}: fail(_CODE)
        uuid(v["roomId"], _CODE); uuid(v["analysisEpoch"], _CODE)
        for key, limit in (("algorithmVersion", 160),):
            if not isinstance(v[key], str) or not 1 <= len(v[key]) <= limit: fail(_CODE)
        if not isinstance(v["parameterHash"], str) or not fullmatch(r"[a-f0-9]{64}", v["parameterHash"]): fail(_CODE)
        integer(v["projectionVersion"], _CODE, minimum=1); integer(v["baseVersion"], _CODE, minimum=0); integer(v["completeThroughRoomSeq"], _CODE, minimum=0)
        timestamp(v["watermarkEventTime"], _CODE)
        if not isinstance(v["requiresReplay"], bool) or v["evidenceStatus"] not in {"active", "retracted", "superseded", "requires_replay"} or v["reviewStatus"] not in {"unreviewed", "approved", "rejected", "corrected"} or v["displayStatus"] not in {"hidden", "teacher_shadow", "student_approved", "student_aggregate"}: fail(_CODE)
        if not isinstance(v["warnings"], list) or len(v["warnings"]) > 64 or any(not isinstance(x, str) or not 1 <= len(x) <= 160 for x in v["warnings"]): fail(_CODE)
        if not isinstance(v["payload"], dict): fail(_CODE)
        return cls(v)
