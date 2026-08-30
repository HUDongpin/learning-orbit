"""Deterministic text-artifact boundary for RoomEvent media/text messages."""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from unicodedata import normalize
from uuid import UUID, uuid5
from typing import Any, Mapping

ARTIFACT_NAMESPACE = UUID("2af27c6d-61c8-4a40-997d-80c7d696f871")
LINEAGE_NAMESPACE = UUID("b72003a9-c4aa-5d22-91df-9a4bb77d61ac")


@dataclass(frozen=True)
class DerivedTextArtifact:
    schema_version: int
    artifact_id: str
    lineage_id: str
    room_id: str
    event_id: str
    room_seq: int
    source_media_id: str | None
    source_modality: str
    derivation: str
    text: str
    normalized_text_sha256: str
    source_confidence_raw: float
    source_confidence_calibrated: float | None
    provider: str
    model_version: str
    language_tag: str
    spans: tuple[dict[str, Any], ...] = ()
    review_status: str = "unreviewed"
    display_status: str = "hidden"
    warnings: tuple[str, ...] = ()
    supersedes_artifact_id: str | None = None
    active: bool = True
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version, "artifactId": self.artifact_id,
            "lineageId": self.lineage_id, "roomId": self.room_id,
            "eventId": self.event_id, "roomSeq": self.room_seq,
            "sourceMediaId": self.source_media_id, "sourceModality": self.source_modality,
            "derivation": self.derivation, "text": self.text,
            "normalizedTextSha256": self.normalized_text_sha256,
            "sourceConfidenceRaw": self.source_confidence_raw,
            "sourceConfidenceCalibrated": self.source_confidence_calibrated,
            "provider": self.provider, "modelVersion": self.model_version,
            "languageTag": self.language_tag, "spans": [dict(item) for item in self.spans],
            "reviewStatus": self.review_status, "displayStatus": self.display_status,
            "warnings": list(self.warnings),
            "supersedesArtifactId": self.supersedes_artifact_id,
            "active": self.active, "createdAt": self.created_at,
        }


def _payload(event: Mapping[str, Any]) -> Mapping[str, Any]:
    payload = event.get("payload", {})
    if not isinstance(payload, Mapping):
        raise ValueError("event payload must be an object")
    return payload


def derive_direct_text(event: Mapping[str, Any]) -> DerivedTextArtifact:
    payload = _payload(event)
    text = normalize("NFC", str(payload.get("text", ""))).strip()
    if not text:
        raise ValueError("direct text requires learner-authored text")
    if event.get("actorKind") != "human" or event.get("actorRole") not in {"student", "learner", None}:
        raise ValueError("direct text requires learner-authored text")
    message_id = str(payload.get("messageId", event.get("eventId", "")))
    digest = sha256(text.encode("utf-8")).hexdigest()
    artifact_id = uuid5(ARTIFACT_NAMESPACE, str(event["eventId"]) + ":direct:direct-text-v1:" + digest)
    lineage_id = uuid5(LINEAGE_NAMESPACE, message_id + ":direct")
    return DerivedTextArtifact(
        1, str(artifact_id), str(lineage_id), str(event["roomId"]), str(event["eventId"]),
        int(event["roomSeq"]), None, "text", "direct", text, digest, 1.0, None,
        "learner-authored", "direct-text-v1", "und", (), "unreviewed", "hidden", (),
        None, True, str(event.get("ingestTime", event.get("eventTime", ""))),
    )


def maybe_derive_direct_text(event: Mapping[str, Any]) -> DerivedTextArtifact | None:
    payload = _payload(event)
    if (event.get("type") not in {"message.added", "message.revised"}
            or event.get("actorKind") != "human"
            or not str(payload.get("text", "")).strip()):
        return None
    return derive_direct_text(event)


def derive_media_text(
    event: Mapping[str, Any], text: str, *, media_id: str,
    modality: str, derivation: str, provider: str, model_version: str,
    confidence: float, spans: tuple[dict[str, Any], ...] = (),
    supersedes_artifact_id: str | None = None,
    lineage_id: str | None = None,
) -> DerivedTextArtifact:
    """Construct a reviewed ASR/OCR artifact; never labels media as direct text."""
    if modality not in {"audio", "image", "text"} or derivation not in {"asr", "ocr", "image_description", "human_correction"}:
        raise ValueError("invalid media derivation")
    if derivation != "human_correction" and modality == "text":
        raise ValueError("text modality requires direct derivation")
    if not 0 <= float(confidence) <= 1:
        raise ValueError("confidence must be in [0,1]")
    clean = normalize("NFC", str(text)).strip()
    if not clean:
        raise ValueError("derived media text cannot be empty")
    if derivation == "human_correction" and not supersedes_artifact_id:
        raise ValueError("human correction requires a predecessor artifact")
    digest = sha256(clean.encode("utf-8")).hexdigest()
    message_id = str(_payload(event).get("messageId", event["eventId"]))
    lineage = lineage_id or str(uuid5(LINEAGE_NAMESPACE, f"{message_id}:{media_id}:{modality}:{derivation}"))
    artifact = uuid5(ARTIFACT_NAMESPACE, f"{event['eventId']}:{media_id}:{model_version}:{digest}")
    return DerivedTextArtifact(
        1, str(artifact), str(lineage), str(event["roomId"]), str(event["eventId"]), int(event["roomSeq"]),
        str(media_id), modality, derivation, clean, digest, float(confidence), None,
        str(provider), str(model_version), "und", tuple(dict(item) for item in spans),
        "unreviewed", "hidden", (), supersedes_artifact_id, True,
        str(event.get("ingestTime", event.get("eventTime", ""))),
    )


def build_composite_artifact(event: Mapping[str, Any], active_artifacts: Mapping[str, DerivedTextArtifact] | None = None) -> dict[str, Any] | None:
    """Return one semantic text view, preserving source offsets for evidence."""
    direct = maybe_derive_direct_text(event)
    items: list[tuple[str, str, str]] = []
    if direct:
        items.append((direct.text, direct.event_id, "text"))
    payload = _payload(event)
    for media_id in payload.get("mediaIds", ()) or ():
        artifact = (active_artifacts or {}).get(str(media_id))
        if artifact and artifact.active:
            items.append((artifact.text, artifact.event_id, artifact.source_modality))
    if not items:
        return None
    text = "\n".join(item[0] for item in items)
    offsets: list[dict[str, Any]] = []
    cursor = 0
    for value, source_event_id, modality in items:
        offsets.append({"eventId": source_event_id, "start": cursor, "end": cursor + len(value), "modality": modality})
        cursor += len(value) + 1
    return {"text": text, "modality": "text" if len(items) == 1 and items[0][2] == "text" else "audio_asr" if any(i[2] == "audio" for i in items) else "image_ocr", "sourceConfidence": min(1.0, min((active_artifacts or {}).get(i[1], direct).source_confidence_raw if i[1] in (active_artifacts or {}) else 1.0 for i in items)), "offsets": offsets}
