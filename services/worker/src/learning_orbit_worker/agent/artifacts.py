"""Immutable, teacher-shadow multimodal artifact values."""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from typing import Iterable

from ..providers.multimodal import AsrResult, ImageDescriptionResult, OcrResult, PrivateMedia


@dataclass(frozen=True, slots=True)
class DerivedArtifact:
    artifact_id: str
    lineage_id: str
    room_id: str
    event_id: str
    source_media_id: str
    source_modality: str
    derivation: str
    text: str
    normalized_text_sha256: str
    source_confidence_raw: float
    review_status: str = "unreviewed"
    display_status: str = "teacher_shadow"
    warnings: tuple[str, ...] = ()
    eligible_for_extraction: bool = False

    def to_wire(self) -> dict[str, object]:
        return {
            "artifactId": self.artifact_id, "lineageId": self.lineage_id,
            "roomId": self.room_id, "eventId": self.event_id,
            "sourceMediaId": self.source_media_id, "sourceModality": self.source_modality,
            "derivation": self.derivation, "text": self.text,
            "normalizedTextSha256": self.normalized_text_sha256,
            "sourceConfidenceRaw": self.source_confidence_raw,
            "sourceConfidenceCalibrated": None, "reviewStatus": self.review_status,
            "displayStatus": self.display_status, "warnings": list(self.warnings),
            "active": True,
        }


def _artifact(media: PrivateMedia, *, artifact_id: str, lineage_id: str, room_id: str, text: str, confidence: float, derivation: str, warning: str | None = None) -> DerivedArtifact:
    normalized = " ".join(text.split())
    warnings = tuple([warning] if warning else [])
    eligible = confidence >= 0.70 and bool(normalized)
    if confidence < 0.70:
        warnings = (*warnings, "LOW_SOURCE_CONFIDENCE")
    return DerivedArtifact(artifact_id, lineage_id, room_id, media.source_event_id, media.media_id, media.modality, derivation, normalized, sha256(normalized.encode()).hexdigest(), confidence, warnings=warnings, eligible_for_extraction=eligible)


def build_asr_artifact(media: PrivateMedia, result: AsrResult, *, artifact_id: str, lineage_id: str, room_id: str) -> DerivedArtifact:
    return _artifact(media, artifact_id=artifact_id, lineage_id=lineage_id, room_id=room_id, text=result.text, confidence=result.confidence, derivation="asr")


def build_ocr_artifact(media: PrivateMedia, result: OcrResult, *, artifact_id: str, lineage_id: str, room_id: str) -> DerivedArtifact:
    return _artifact(media, artifact_id=artifact_id, lineage_id=lineage_id, room_id=room_id, text=result.text, confidence=result.confidence, derivation="ocr")


def build_image_artifact(media: PrivateMedia, result: ImageDescriptionResult, *, artifact_id: str, lineage_id: str, room_id: str) -> DerivedArtifact:
    return _artifact(media, artifact_id=artifact_id, lineage_id=lineage_id, room_id=room_id, text=result.text, confidence=result.confidence, derivation="image_description")


def verify_evidence_span(*, text: str, text_sha256: str, start: int, end: int) -> str:
    if start < 0 or end <= start or end > len(text):
        raise ValueError("EVIDENCE_SPAN_INVALID")
    normalized = " ".join(text.split())
    if sha256(normalized.encode()).hexdigest() != text_sha256:
        raise ValueError("ARTIFACT_INTEGRITY_MISMATCH")
    return text[start:end]
