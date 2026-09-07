"""Derive text from media that has already been scanned and promoted.

`multimodal.derive.v1` was a job family with no handler: the contract gate
reported it outstanding and nothing would ever have claimed it. This is the
handler, and most of it is about what it refuses to do.

The refusals, in the order they matter:

* **Media that is not `ready` is never sent anywhere.** `ready` is the state a
  file reaches only after it was scanned and promoted, so treating any other
  state as derivable would mean handing an unscanned upload to a third party.
* **The media must belong to the room and the event in the job.** A job naming
  someone else's media is not a mistake to work around.
* **Derived text is content.** It goes in the artifact row and nowhere else —
  not a log, not a span, not an error message.
* **An absent provider is never a success.** Without a reviewed multimodal
  provider the job retries; it does not quietly write an empty artifact.

Every artifact id is a uuid5 of the event, media, model version and text
digest, so a retry that derives the same text writes the same row and a retry
that derives different text writes a new one instead of silently replacing the
old.
"""
from __future__ import annotations

from typing import Any, Mapping

from .core_handlers import RetryableJobError, TerminalJobError
from .derived_text import DerivedTextArtifact, derive_media_text
from .handler_registry import HandlerOutcome, WorkerDeps
from .jobs import WorkerJob
from .providers.multimodal import PrivateMedia

#: Only these two modalities are derived here. Text needs no derivation, and a
#: modality nobody reviewed a provider for is refused rather than guessed at.
DERIVABLE_MODALITIES = {"audio": "asr", "image": "ocr"}

_PAYLOAD_KEYS = {"mediaId", "sourceEventId", "modality"}

INSERT_ARTIFACT = """INSERT INTO derived_text_artifact (
    artifact_id, lineage_id, event_id, room_id, room_seq, source_media_id,
    source_modality, derivation, text_content, normalized_text_sha256,
    source_confidence_raw, source_confidence_calibrated, provider,
    model_version, language_tag, spans, review_status, display_status,
    warnings, supersedes_artifact_id, active
  ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s::jsonb,%s,%s)
  ON CONFLICT (artifact_id) DO NOTHING"""


def _payload(job: WorkerJob) -> Mapping[str, Any]:
    if not isinstance(job.payload, Mapping) or set(job.payload) != _PAYLOAD_KEYS:
        raise TerminalJobError("MULTIMODAL_JOB_PAYLOAD_INVALID")
    modality = job.payload.get("modality")
    if (not isinstance(job.payload.get("mediaId"), str)
            or not isinstance(job.payload.get("sourceEventId"), str)
            or modality not in DERIVABLE_MODALITIES
            or not job.room_id):
        raise TerminalJobError("MULTIMODAL_JOB_PAYLOAD_INVALID")
    return job.payload


def _row(cursor: Any) -> dict[str, Any] | None:
    row = cursor.fetchone()
    if row is None:
        return None
    if isinstance(row, Mapping):
        return dict(row)
    description = getattr(cursor, "description", None) or []
    names = [column.name if hasattr(column, "name") else column[0] for column in description]
    return dict(zip(names, row, strict=False))


def load_derivable_media(connection: Any, media_id: str, room_id: str) -> dict[str, Any]:
    """Load media that may be derived, or say precisely why it may not."""
    row = _row(connection.execute(
        """SELECT media_id, room_id, kind::text AS kind, state::text AS state,
                  sha256, alt_text
           FROM media_asset WHERE media_id=%s""",
        (media_id,),
    ))
    if row is None:
        raise TerminalJobError("MULTIMODAL_MEDIA_ABSENT")
    if str(row["room_id"]) != str(room_id):
        raise TerminalJobError("MULTIMODAL_MEDIA_ROOM_MISMATCH")
    if row["state"] != "ready":
        # Not-yet-scanned is a retry; anything terminal is not. Either way the
        # file does not leave this system in this state.
        if row["state"] in {"pending", "uploaded", "processing"}:
            raise RetryableJobError("MULTIMODAL_MEDIA_NOT_READY")
        raise TerminalJobError("MULTIMODAL_MEDIA_NOT_DERIVABLE")
    return row


def load_source_event(connection: Any, event_id: str, room_id: str) -> dict[str, Any]:
    row = _row(connection.execute(
        """SELECT event_id, room_id, room_seq, ingest_time, event_time, payload
           FROM room_event WHERE event_id=%s""",
        (event_id,),
    ))
    if row is None:
        raise TerminalJobError("MULTIMODAL_SOURCE_EVENT_ABSENT")
    if str(row["room_id"]) != str(room_id):
        raise TerminalJobError("MULTIMODAL_SOURCE_EVENT_ROOM_MISMATCH")
    return {
        "eventId": str(row["event_id"]),
        "roomId": str(row["room_id"]),
        "roomSeq": int(row["room_seq"]),
        "ingestTime": str(row.get("ingest_time") or row.get("event_time") or ""),
        "payload": row["payload"] if isinstance(row["payload"], Mapping) else {},
    }


def persist_artifact(connection: Any, artifact: DerivedTextArtifact) -> None:
    import json

    connection.execute(INSERT_ARTIFACT, (
        artifact.artifact_id, artifact.lineage_id, artifact.event_id, artifact.room_id,
        artifact.room_seq, artifact.source_media_id, artifact.source_modality,
        artifact.derivation, artifact.text, artifact.normalized_text_sha256,
        artifact.source_confidence_raw, artifact.source_confidence_calibrated,
        artifact.provider, artifact.model_version, artifact.language_tag,
        json.dumps(list(artifact.spans)), artifact.review_status,
        artifact.display_status, json.dumps(list(artifact.warnings)),
        artifact.supersedes_artifact_id, artifact.active,
    ))


def multimodal_derive_handler(deps: WorkerDeps, job: WorkerJob) -> HandlerOutcome:
    payload = _payload(job)
    provider = deps.multimodal_provider
    if provider is None:
        # An absent provider is not an empty transcript.
        raise RetryableJobError("MULTIMODAL_PROVIDER_UNAVAILABLE")

    media = load_derivable_media(deps.db, str(payload["mediaId"]), str(job.room_id))
    event = load_source_event(deps.db, str(payload["sourceEventId"]), str(job.room_id))
    modality = str(payload["modality"])
    private = PrivateMedia(
        media_id=str(media["media_id"]),
        source_event_id=event["eventId"],
        modality=modality,
        sha256=str(media["sha256"]),
    )

    try:
        if modality == "audio":
            result = provider.transcribe(private)
            derivation = "asr"
            spans: tuple[dict[str, Any], ...] = tuple(
                {"start": start, "end": end} for start, end in getattr(result, "timestamps", ())
            )
        else:
            result = provider.recognize(private)
            derivation = "ocr"
            spans = tuple(
                {"box": list(box)} for box in getattr(result, "boxes", ())
            )
    except Exception as error:  # noqa: BLE001 - a provider body may quote content
        raise RetryableJobError(f"MULTIMODAL_PROVIDER_{type(error).__name__.upper()}") from None

    try:
        artifact = derive_media_text(
            event, result.text, media_id=private.media_id, modality=modality,
            derivation=derivation, provider=provider.provider_id,
            model_version=provider.processor_version,
            confidence=result.confidence, spans=spans,
        )
    except ValueError as error:
        # `derive_media_text` refuses empty or mislabelled text. The message can
        # not carry the text itself, so only the reason is kept.
        raise TerminalJobError(f"MULTIMODAL_DERIVATION_{str(error.args[0]).upper().replace(' ', '_')}") from None

    persist_artifact(deps.db, artifact)
    return HandlerOutcome.SUCCESS


def register_multimodal_handlers(registry: Any) -> Any:
    registry.register("multimodal.derive.v1", multimodal_derive_handler)
    return registry


__all__ = [
    "DERIVABLE_MODALITIES",
    "load_derivable_media",
    "load_source_event",
    "multimodal_derive_handler",
    "persist_artifact",
    "register_multimodal_handlers",
]
