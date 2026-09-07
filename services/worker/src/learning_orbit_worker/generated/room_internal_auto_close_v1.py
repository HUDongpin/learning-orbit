"""Generated-style closed parser for room-internal-auto-close.v1."""
from __future__ import annotations

from dataclasses import dataclass
from re import fullmatch

from ._validation import exact_object, timestamp, uuid

_CODE = "INVALID_ROOM_INTERNAL_AUTO_CLOSE"
_FIELDS = {
    "jobId", "jobType", "roomId", "sourceEventId", "dedupeKey",
    "closesAt", "correlationId", "claimGeneration", "claimToken", "workerId",
}


@dataclass(frozen=True, slots=True)
class Request:
    job_id: str
    job_type: str
    room_id: str
    source_event_id: str
    dedupe_key: str
    closes_at: str
    correlation_id: str
    claim_generation: str
    claim_token: str
    worker_id: str

    @classmethod
    def from_dict(cls, value: object) -> "Request":
        record = exact_object(value, _FIELDS, _CODE)
        for key in ("jobId", "roomId", "sourceEventId", "correlationId", "claimToken"):
            uuid(record[key], _CODE)
        if record["jobType"] != "room.auto-close.v1":
            raise ValueError(_CODE)
        dedupe = record["dedupeKey"]
        if not isinstance(dedupe, str) or not fullmatch(r"room\.auto-close\.v1:[0-9a-f-]{36}", dedupe):
            raise ValueError(_CODE)
        generation = record["claimGeneration"]
        if not isinstance(generation, str) or not fullmatch(r"[1-9][0-9]{0,18}", generation):
            raise ValueError(_CODE)
        worker = record["workerId"]
        if not isinstance(worker, str) or not 0 < len(worker) <= 128:
            raise ValueError(_CODE)
        timestamp(record["closesAt"], _CODE)
        return cls(
            record["jobId"], record["jobType"], record["roomId"], record["sourceEventId"],
            dedupe, record["closesAt"], record["correlationId"], generation,
            record["claimToken"], worker,
        )
