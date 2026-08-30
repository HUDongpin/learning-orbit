"""Generated closed parsers for deletion-lifecycle.v1 surfaces."""
from __future__ import annotations
from dataclasses import dataclass
from ._validation import exact_object, integer, timestamp, uuid, fail

@dataclass(frozen=True, slots=True)
class DeleteRoomRequest:
    confirmation: str
    @classmethod
    def from_dict(cls, value: object) -> "DeleteRoomRequest":
        v = exact_object(value, {"confirmation"}, "INVALID_DELETE_ROOM_REQUEST")
        if not isinstance(v["confirmation"], str) or not 1 <= len(v["confirmation"]) <= 256: fail("INVALID_DELETE_ROOM_REQUEST")
        return cls(v["confirmation"])

@dataclass(frozen=True, slots=True)
class DeleteRoomAccepted:
    deletion_job_id: str
    status: str
    @classmethod
    def from_dict(cls, value: object) -> "DeleteRoomAccepted":
        v = exact_object(value, {"deletionJobId", "status"}, "INVALID_DELETE_ROOM_ACCEPTED")
        uuid(v["deletionJobId"], "INVALID_DELETE_ROOM_ACCEPTED")
        if v["status"] != "queued": fail("INVALID_DELETE_ROOM_ACCEPTED")
        return cls(v["deletionJobId"], v["status"])

@dataclass(frozen=True, slots=True)
class DeletionReceipt:
    value: dict[str, object]
    @classmethod
    def from_dict(cls, value: object) -> "DeletionReceipt":
        v = exact_object(value, {"receiptVersion", "surfacesVerified", "completedAt"}, "INVALID_DELETION_RECEIPT")
        surfaces = v["surfacesVerified"]
        allowed = {"agent_runs", "artifacts", "caches", "derivatives", "events", "media", "projections", "provider_copies"}
        if v["receiptVersion"] != 1 or not isinstance(surfaces, list) or len(surfaces) < 8 or len(set(surfaces)) != len(surfaces) or set(surfaces) != allowed: fail("INVALID_DELETION_RECEIPT")
        timestamp(v["completedAt"], "INVALID_DELETION_RECEIPT")
        return cls(v)

@dataclass(frozen=True, slots=True)
class DeletionStatus:
    value: dict[str, object]
    @classmethod
    def from_dict(cls, value: object) -> "DeletionStatus":
        if not isinstance(value, dict): fail("INVALID_DELETION_STATUS")
        uuid(value.get("deletionJobId"), "INVALID_DELETION_STATUS")
        status = value.get("status")
        if status == "completed":
            v = exact_object(value, {"deletionJobId", "status", "receipt"}, "INVALID_DELETION_STATUS")
            DeletionReceipt.from_dict(v["receipt"]); return cls(v)
        v = exact_object(value, {"deletionJobId", "status", "nextPollAfterMs", "failureCode"}, "INVALID_DELETION_STATUS")
        if status not in {"queued", "running", "retryable", "dead"}: fail("INVALID_DELETION_STATUS")
        poll = v["nextPollAfterMs"]
        if poll is not None: integer(poll, "INVALID_DELETION_STATUS", minimum=250); 
        if poll is not None and poll > 30000: fail("INVALID_DELETION_STATUS")
        if v["failureCode"] is not None and (not isinstance(v["failureCode"], str) or not v["failureCode"] or any(not (c.isupper() or c.isdigit() or c == "_") for c in v["failureCode"])): fail("INVALID_DELETION_STATUS")
        return cls(v)
