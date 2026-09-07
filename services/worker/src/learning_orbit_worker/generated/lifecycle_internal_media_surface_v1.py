"""Generated-style closed parser for lifecycle-internal-media-surface.v1."""
from __future__ import annotations

from dataclasses import dataclass
from re import fullmatch

from ._validation import exact_object, uuid

_CODE = "INVALID_LIFECYCLE_INTERNAL_MEDIA_SURFACE"
_FIELDS = {
    "jobId", "jobType", "roomId", "sourceEventId", "dedupeKey", "deletionJobId",
    "surface", "correlationId", "claimGeneration", "claimToken", "workerId",
}


@dataclass(frozen=True, slots=True)
class Request:
    job_id: str
    job_type: str
    room_id: None
    source_event_id: None
    dedupe_key: str
    deletion_job_id: str
    surface: str
    correlation_id: str
    claim_generation: str
    claim_token: str
    worker_id: str

    @classmethod
    def from_dict(cls, value: object) -> "Request":
        record = exact_object(value, _FIELDS, _CODE)
        for key in ("jobId", "deletionJobId", "correlationId", "claimToken"):
            uuid(record[key], _CODE)
        # A deletion surface job is deliberately not room-scoped: the room row
        # may already be gone by the time later surfaces run.
        if record["roomId"] is not None or record["sourceEventId"] is not None:
            raise ValueError(_CODE)
        if record["jobType"] != "room.delete-surface.v1" or record["surface"] != "media":
            raise ValueError(_CODE)
        dedupe = record["dedupeKey"]
        if not isinstance(dedupe, str) \
                or not fullmatch(r"room\.delete-surface\.v1:[0-9a-f-]{36}:media", dedupe):
            raise ValueError(_CODE)
        generation = record["claimGeneration"]
        if not isinstance(generation, str) or not fullmatch(r"[1-9][0-9]{0,18}", generation):
            raise ValueError(_CODE)
        worker = record["workerId"]
        if not isinstance(worker, str) or not 0 < len(worker) <= 128:
            raise ValueError(_CODE)
        return cls(
            record["jobId"], record["jobType"], None, None, dedupe,
            record["deletionJobId"], record["surface"], record["correlationId"],
            generation, record["claimToken"], worker,
        )
