"""Generated-style closed parser for media-internal-reconcile.v1."""
from __future__ import annotations

from dataclasses import dataclass
from re import fullmatch

from ._validation import exact_object, uuid

_CODE = "INVALID_MEDIA_INTERNAL_RECONCILE"
_FIELDS = {
    "jobId", "jobType", "roomId", "sourceEventId", "dedupeKey", "mediaId",
    "correlationId", "claimGeneration", "claimToken", "workerId",
}


@dataclass(frozen=True, slots=True)
class Request:
    job_id: str
    job_type: str
    room_id: str
    source_event_id: None
    dedupe_key: str
    media_id: str
    correlation_id: str
    claim_generation: str
    claim_token: str
    worker_id: str

    @classmethod
    def from_dict(cls, value: object) -> "Request":
        record = exact_object(value, _FIELDS, _CODE)
        for key in ("jobId", "roomId", "mediaId", "correlationId", "claimToken"):
            uuid(record[key], _CODE)
        # This family is room-scoped but never event-caused; the null is part
        # of the closed shape rather than an omission.
        if record["sourceEventId"] is not None or record["jobType"] != "media.reconcile-upload.v1":
            raise ValueError(_CODE)
        dedupe = record["dedupeKey"]
        if not isinstance(dedupe, str) or not fullmatch(r"media\.reconcile-upload\.v1:[0-9a-f-]{36}", dedupe):
            raise ValueError(_CODE)
        generation = record["claimGeneration"]
        if not isinstance(generation, str) or not fullmatch(r"[1-9][0-9]{0,18}", generation):
            raise ValueError(_CODE)
        worker = record["workerId"]
        if not isinstance(worker, str) or not 0 < len(worker) <= 128:
            raise ValueError(_CODE)
        return cls(
            record["jobId"], record["jobType"], record["roomId"], None, dedupe,
            record["mediaId"], record["correlationId"], generation,
            record["claimToken"], worker,
        )
