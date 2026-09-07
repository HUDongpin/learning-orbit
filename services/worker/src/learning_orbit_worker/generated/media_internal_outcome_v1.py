"""Generated-style closed parser for media-internal-outcome.v1."""
from __future__ import annotations

from dataclasses import dataclass
from re import fullmatch

from ._validation import exact_object, integer, uuid

_CODE = "INVALID_MEDIA_INTERNAL_OUTCOME"
_FIELDS = {
    "jobId", "jobType", "roomId", "sourceEventId", "dedupeKey", "mediaId",
    "transitionId", "state", "failureCode", "derivatives",
    "correlationId", "claimGeneration", "claimToken", "workerId",
}
_DERIVATIVE_FIELDS = {"derivativeId", "kind", "objectKey", "mime", "sizeBytes", "sha256"}
_STATES = {"processing", "ready", "quarantined", "failed"}
_KINDS = {"thumbnail", "sanitized_image", "playback_audio", "waveform"}
_MAX_BYTES = 26_214_400


@dataclass(frozen=True, slots=True)
class Derivative:
    derivative_id: str
    kind: str
    object_key: str
    mime: str
    size_bytes: int
    sha256: str

    @classmethod
    def from_dict(cls, value: object) -> "Derivative":
        record = exact_object(value, _DERIVATIVE_FIELDS, _CODE)
        uuid(record["derivativeId"], _CODE)
        if record["kind"] not in _KINDS:
            raise ValueError(_CODE)
        object_key = record["objectKey"]
        mime = record["mime"]
        digest = record["sha256"]
        if not isinstance(object_key, str) or not 0 < len(object_key) <= 512:
            raise ValueError(_CODE)
        if not isinstance(mime, str) or not 0 < len(mime) <= 127:
            raise ValueError(_CODE)
        if not isinstance(digest, str) or not fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError(_CODE)
        size = integer(record["sizeBytes"], _CODE, minimum=1)
        if size > _MAX_BYTES:
            raise ValueError(_CODE)
        return cls(record["derivativeId"], record["kind"], object_key, mime, size, digest)


@dataclass(frozen=True, slots=True)
class Request:
    job_id: str
    job_type: str
    room_id: str
    source_event_id: None
    dedupe_key: str
    media_id: str
    transition_id: str
    state: str
    failure_code: str | None
    derivatives: tuple[Derivative, ...]
    correlation_id: str
    claim_generation: str
    claim_token: str
    worker_id: str

    @classmethod
    def from_dict(cls, value: object) -> "Request":
        record = exact_object(value, _FIELDS, _CODE)
        for key in ("jobId", "roomId", "mediaId", "transitionId", "correlationId", "claimToken"):
            uuid(record[key], _CODE)
        if record["sourceEventId"] is not None or record["jobType"] != "media.process.v1":
            raise ValueError(_CODE)
        dedupe = record["dedupeKey"]
        if not isinstance(dedupe, str) or not fullmatch(r"media\.process\.v1:[0-9a-f-]{36}", dedupe):
            raise ValueError(_CODE)
        if record["state"] not in _STATES:
            raise ValueError(_CODE)
        failure = record["failureCode"]
        if failure is not None and (not isinstance(failure, str) or not 0 < len(failure) <= 100):
            raise ValueError(_CODE)
        derivatives = record["derivatives"]
        if not isinstance(derivatives, list) or len(derivatives) > 4:
            raise ValueError(_CODE)
        generation = record["claimGeneration"]
        if not isinstance(generation, str) or not fullmatch(r"[1-9][0-9]{0,18}", generation):
            raise ValueError(_CODE)
        worker = record["workerId"]
        if not isinstance(worker, str) or not 0 < len(worker) <= 128:
            raise ValueError(_CODE)
        return cls(
            record["jobId"], record["jobType"], record["roomId"], None, dedupe,
            record["mediaId"], record["transitionId"], record["state"], failure,
            tuple(Derivative.from_dict(item) for item in derivatives),
            record["correlationId"], generation, record["claimToken"], worker,
        )
