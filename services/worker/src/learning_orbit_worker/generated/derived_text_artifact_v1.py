"""Generated closed parser for derived-text-artifact.v1."""
from __future__ import annotations
from dataclasses import dataclass
from re import fullmatch
from ._validation import exact_object, integer, number, optional_uuid, timestamp, uuid, fail

_FIELDS = {"schemaVersion", "artifactId", "lineageId", "roomId", "eventId", "roomSeq", "sourceMediaId", "sourceModality", "derivation", "text", "normalizedTextSha256", "sourceConfidenceRaw", "sourceConfidenceCalibrated", "provider", "modelVersion", "languageTag", "spans", "reviewStatus", "displayStatus", "warnings", "supersedesArtifactId", "active", "createdAt"}
_CODE = "INVALID_DERIVED_TEXT_ARTIFACT"

@dataclass(frozen=True, slots=True)
class Artifact:
    value: dict[str, object]

    @classmethod
    def from_dict(cls, value: object) -> "Artifact":
        v = exact_object(value, _FIELDS, _CODE)
        if v["schemaVersion"] != 1: fail(_CODE)
        for key in ("artifactId", "lineageId", "roomId", "eventId"): uuid(v[key], _CODE)
        integer(v["roomSeq"], _CODE, minimum=1)
        optional_uuid(v["sourceMediaId"], _CODE)
        if v["sourceModality"] not in {"text", "audio", "image"}: fail(_CODE)
        derivation = v["derivation"]
        if derivation not in {"direct", "asr", "ocr", "image_description", "human_correction"}: fail(_CODE)
        if not isinstance(v["text"], str) or not 1 <= len(v["text"]) <= 20000: fail(_CODE)
        if not isinstance(v["normalizedTextSha256"], str) or not fullmatch(r"[a-f0-9]{64}", v["normalizedTextSha256"]): fail(_CODE)
        number(v["sourceConfidenceRaw"], _CODE, minimum=0, maximum=1)
        if v["sourceConfidenceCalibrated"] is not None: number(v["sourceConfidenceCalibrated"], _CODE, minimum=0, maximum=1)
        for key, limit in (("provider", 100), ("modelVersion", 160), ("languageTag", 35)):
            if not isinstance(v[key], str) or not 1 <= len(v[key]) <= limit: fail(_CODE)
        if not isinstance(v["spans"], list): fail(_CODE)
        for span in v["spans"]:
            if not isinstance(span, dict) or set(span) - {"start", "end", "confidence", "startMs", "endMs", "boundingBox"} != { } or not {"start", "end", "confidence"} <= set(span): fail(_CODE)
            integer(span["start"], _CODE, minimum=0); integer(span["end"], _CODE, minimum=1); number(span["confidence"], _CODE, minimum=0, maximum=1)
            for key in ("startMs", "endMs"):
                if key in span: integer(span[key], _CODE, minimum=0)
            if "boundingBox" in span and (not isinstance(span["boundingBox"], list) or not 4 <= len(span["boundingBox"]) <= 4): fail(_CODE)
            if "boundingBox" in span:
                for item in span["boundingBox"]: number(item, _CODE)
        if v["reviewStatus"] not in {"unreviewed", "approved", "rejected", "corrected"} or v["displayStatus"] not in {"hidden", "teacher_shadow", "student_approved"}: fail(_CODE)
        if not isinstance(v["warnings"], list) or len(v["warnings"]) > 32 or any(not isinstance(x, str) or not 1 <= len(x) <= 160 for x in v["warnings"]): fail(_CODE)
        if not isinstance(v["supersedesArtifactId"], (str, type(None))): fail(_CODE)
        optional_uuid(v["supersedesArtifactId"], _CODE)
        if derivation == "direct" and (v["sourceModality"] != "text" or v["sourceMediaId"] is not None): fail(_CODE)
        if derivation == "human_correction" and v["supersedesArtifactId"] is None: fail(_CODE)
        if not isinstance(v["active"], bool): fail(_CODE)
        timestamp(v["createdAt"], _CODE)
        return cls(v)
