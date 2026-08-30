"""Small transactional persistence port for analytics projections.

The computation modules remain pure; this class is the only worker seam that
writes the analytics read models.  It deliberately does not write room_event
or outbox_event.  psycopg connections and lightweight test doubles exposing
``execute`` are both supported.
"""
from __future__ import annotations

import json
from hashlib import sha256
from typing import Any, Mapping
from uuid import UUID
from datetime import datetime


def _jsonb(value: Any) -> Any:
    """Adapt dictionaries for psycopg3 while keeping doubles dependency-free."""
    try:
        from psycopg.types.json import Jsonb
        return Jsonb(value)
    except ImportError:
        return value


class ProjectionStore:
    def __init__(self, connection: Any, *, snapshot_url_factory: Any | None = None) -> None:
        self.connection = connection
        self.snapshot_url_factory = snapshot_url_factory or (
            lambda room_id, key: f"/v1/rooms/{room_id}/analytics/{key}/latest"
        )

    def ensure_head(
        self, room_id: str, projection_key: str, analysis_epoch: str,
        algorithm_version: str, parameter_hash: str, watermark_event_time: str,
    ) -> None:
        self.connection.execute(
            """INSERT INTO analysis_room_heads
               (room_id,projection_key,analysis_epoch,version,complete_through_seq,
                algorithm_version,parameter_hash,max_seen_event_time,watermark_event_time)
               VALUES (%s,%s,%s,0,0,%s,%s,%s,%s)
               ON CONFLICT (room_id,projection_key) DO NOTHING""",
            (room_id, projection_key, analysis_epoch, algorithm_version,
             parameter_hash, watermark_event_time, watermark_event_time),
        )

    def persist(
        self,
        *,
        snapshot: Mapping[str, Any],
        payload_hash: str,
        patch: Mapping[str, Any] | None = None,
        patch_hash: str | None = None,
    ) -> None:
        required = ("roomId", "projectionKey", "analysisEpoch", "projectionVersion",
                    "completeThroughRoomSeq", "algorithmVersion", "parameterHash",
                    "watermarkEventTime", "requiresReplay", "payload")
        if any(key not in snapshot for key in required):
            raise ValueError("INVALID_PROJECTION_SNAPSHOT")
        if not isinstance(snapshot["roomId"], str) or not isinstance(snapshot["analysisEpoch"], str):
            raise ValueError("INVALID_PROJECTION_SNAPSHOT")
        try:
            UUID(snapshot["roomId"]); UUID(snapshot["analysisEpoch"])
        except (ValueError, AttributeError):
            raise ValueError("INVALID_PROJECTION_SNAPSHOT") from None
        int_fields = ("projectionVersion", "completeThroughRoomSeq")
        if any(isinstance(snapshot[key], bool) or not isinstance(snapshot[key], int) or snapshot[key] < (1 if key == "projectionVersion" else 0) for key in int_fields):
            raise ValueError("INVALID_PROJECTION_SNAPSHOT")
        if not isinstance(snapshot["requiresReplay"], bool) or not isinstance(snapshot["payload"], Mapping):
            raise ValueError("INVALID_PROJECTION_SNAPSHOT")
        try:
            datetime.fromisoformat(str(snapshot["watermarkEventTime"]).replace("Z", "+00:00"))
        except ValueError:
            raise ValueError("INVALID_PROJECTION_SNAPSHOT") from None
        for key in ("algorithmVersion", "projectionKey", "parameterHash"):
            if not isinstance(snapshot[key], str) or not snapshot[key]:
                raise ValueError("INVALID_PROJECTION_SNAPSHOT")
        if patch is not None:
            if not isinstance(patch, Mapping) or patch.get("projectionVersion") != snapshot["projectionVersion"] or patch.get("baseVersion") != snapshot.get("baseVersion", 0):
                raise ValueError("INVALID_PROJECTION_PATCH")
        algorithm = "ECHO-CM" if str(snapshot["projectionKey"]).startswith("echo.") else "TRACE-AI"
        self.connection.execute(
            """INSERT INTO analysis_projection_snapshots
               (snapshot_id,room_id,algorithm,projection_key,analysis_epoch,version,
                complete_through_seq,watermark_event_time,requires_replay,schema_version,
                algorithm_version,parameter_hash,payload,content_sha256)
               VALUES (gen_random_uuid(),%s,%s,%s,%s,%s,%s,%s,%s,1,%s,%s,%s,%s)
               ON CONFLICT (room_id,projection_key,analysis_epoch,version) DO NOTHING""",
            (snapshot["roomId"], algorithm, snapshot["projectionKey"], snapshot["analysisEpoch"],
             snapshot["projectionVersion"], snapshot["completeThroughRoomSeq"],
             snapshot["watermarkEventTime"], snapshot["requiresReplay"],
             snapshot["algorithmVersion"], snapshot["parameterHash"], _jsonb(snapshot["payload"]), payload_hash),
        )
        if patch is not None:
            if patch_hash is None:
                raise ValueError("PATCH_HASH_REQUIRED")
            self.connection.execute(
                """INSERT INTO analysis_projection_patches
                   (patch_id,room_id,projection_key,analysis_epoch,base_version,version,
                    complete_through_seq,algorithm_version,parameter_hash,payload,content_sha256)
                   VALUES (gen_random_uuid(),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (room_id,projection_key,analysis_epoch,version) DO NOTHING""",
                (snapshot["roomId"], snapshot["projectionKey"], snapshot["analysisEpoch"],
                 patch["baseVersion"], patch["projectionVersion"], patch["completeThroughRoomSeq"],
                 patch["algorithmVersion"], patch["parameterHash"], _jsonb(patch), patch_hash),
            )
        key = str(snapshot["projectionKey"])
        self.connection.execute(
            """INSERT INTO analysis_projection_outbox
               (room_id,projection_key,analysis_epoch,projection_version,
                complete_through_room_seq,snapshot_url)
               VALUES (%s,%s,%s,%s,%s,%s)
               ON CONFLICT (room_id,projection_key,analysis_epoch,projection_version) DO NOTHING""",
            (snapshot["roomId"], key, snapshot["analysisEpoch"], snapshot["projectionVersion"],
             snapshot["completeThroughRoomSeq"], self.snapshot_url_factory(snapshot["roomId"], key)),
        )

    def checkpoint(self, room_id: str, *, consumer_name: str = "analytics") -> int:
        row = self.connection.execute(
            "SELECT last_room_seq FROM analysis_consumer_checkpoints WHERE consumer_name=%s AND room_id=%s",
            (consumer_name, room_id),
        ).fetchone()
        if row is None:
            return 0
        return int(row[0] if not isinstance(row, Mapping) else row["last_room_seq"])

    def head(self, room_id: str, projection_key: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            """SELECT room_id,projection_key,analysis_epoch,version,complete_through_seq,
                      algorithm_version,parameter_hash,max_seen_event_time,
                      watermark_event_time,requires_replay,snapshot_id
               FROM analysis_room_heads WHERE room_id=%s AND projection_key=%s FOR UPDATE""",
            (room_id, projection_key),
        ).fetchone()
        if row is None:
            return None
        if isinstance(row, Mapping):
            return dict(row)
        names = ("room_id", "projection_key", "analysis_epoch", "version",
                 "complete_through_seq", "algorithm_version", "parameter_hash",
                 "max_seen_event_time", "watermark_event_time", "requires_replay", "snapshot_id")
        return dict(zip(names, row, strict=True))

    def snapshot_for_head(self, snapshot_id: str | None) -> dict[str, Any] | None:
        if snapshot_id is None:
            return None
        row = self.connection.execute(
            "SELECT projection_key,analysis_epoch,version,complete_through_seq,watermark_event_time,requires_replay,algorithm_version,parameter_hash,payload FROM analysis_projection_snapshots WHERE snapshot_id=%s",
            (snapshot_id,),
        ).fetchone()
        if row is None:
            return None
        if isinstance(row, Mapping):
            return dict(row)
        names = ("projection_key", "analysis_epoch", "version", "complete_through_seq",
                 "watermark_event_time", "requires_replay", "algorithm_version",
                 "parameter_hash", "payload")
        return dict(zip(names, row, strict=True))

    def persist_and_advance(
        self, *, snapshot: Mapping[str, Any], payload_hash: str,
        patch: Mapping[str, Any] | None = None, patch_hash: str | None = None,
    ) -> None:
        """Persist one immutable projection and CAS its room head in one tx."""
        try:
            from .generated.analysis_projection_envelope_v1 import Envelope
            Envelope.from_dict(dict(snapshot))
        except (ImportError, ValueError, TypeError, KeyError) as error:
            raise ValueError("INVALID_PROJECTION_SNAPSHOT") from error
        room_id = str(snapshot["roomId"])
        key = str(snapshot["projectionKey"])
        version = int(snapshot["projectionVersion"])
        head = self.head(room_id, key)
        if head is None:
            self.ensure_head(room_id, key, str(snapshot["analysisEpoch"]),
                             str(snapshot["algorithmVersion"]), str(snapshot["parameterHash"]),
                             str(snapshot["watermarkEventTime"]))
            head = self.head(room_id, key)
        if head is None:
            raise RuntimeError("ANALYTICS_HEAD_UNAVAILABLE")
        existing_head_version = int(head["version"])
        # A replay installs a new epoch atomically at version 1. Normal
        # consumes continue the current epoch and must be exact successors.
        new_epoch = str(head["analysis_epoch"]) != str(snapshot["analysisEpoch"])
        existing_version = 0 if new_epoch else existing_head_version
        if existing_version >= version:
            return
        if existing_version + 1 != version:
            raise RuntimeError("ANALYTICS_VERSION_CONFLICT")
        algorithm = "ECHO-CM" if key.startswith("echo.") else "TRACE-AI"
        inserted = self.connection.execute(
            """INSERT INTO analysis_projection_snapshots
               (snapshot_id,room_id,algorithm,projection_key,analysis_epoch,version,
                complete_through_seq,watermark_event_time,requires_replay,schema_version,
                algorithm_version,parameter_hash,payload,content_sha256)
               VALUES (gen_random_uuid(),%s,%s,%s,%s,%s,%s,%s,%s,1,%s,%s,%s,%s)
               ON CONFLICT (room_id,projection_key,analysis_epoch,version) DO NOTHING
               RETURNING snapshot_id""",
            (room_id, algorithm, key, snapshot["analysisEpoch"], version,
             snapshot["completeThroughRoomSeq"], snapshot["watermarkEventTime"],
             snapshot["requiresReplay"], snapshot["algorithmVersion"], snapshot["parameterHash"],
             _jsonb(snapshot["payload"]), payload_hash),
        ).fetchone()
        snapshot_id = inserted[0] if inserted else None
        if snapshot_id is None:
            current = self.connection.execute(
                "SELECT snapshot_id FROM analysis_projection_snapshots WHERE room_id=%s AND projection_key=%s AND analysis_epoch=%s AND version=%s",
                (room_id, key, snapshot["analysisEpoch"], version),
            ).fetchone()
            snapshot_id = current[0] if current else None
        if snapshot_id is None:
            raise RuntimeError("ANALYTICS_SNAPSHOT_UNAVAILABLE")
        if patch is not None:
            if patch_hash is None:
                raise ValueError("PATCH_HASH_REQUIRED")
            self.connection.execute(
                """INSERT INTO analysis_projection_patches
                   (patch_id,room_id,projection_key,analysis_epoch,base_version,version,
                    complete_through_seq,algorithm_version,parameter_hash,payload,content_sha256)
                   VALUES (gen_random_uuid(),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (room_id,projection_key,analysis_epoch,version) DO NOTHING""",
                (room_id, key, snapshot["analysisEpoch"], patch["baseVersion"], version,
                 snapshot["completeThroughRoomSeq"], snapshot["algorithmVersion"],
                 snapshot["parameterHash"], _jsonb(patch), patch_hash),
            )
        updated = self.connection.execute(
            """UPDATE analysis_room_heads
               SET analysis_epoch=%s,version=%s,complete_through_seq=%s,
                   algorithm_version=%s,parameter_hash=%s,
                   max_seen_event_time=%s,watermark_event_time=%s,
                   requires_replay=%s,snapshot_id=%s,updated_at=now()
               WHERE room_id=%s AND projection_key=%s AND version=%s""",
            (snapshot["analysisEpoch"], version, snapshot["completeThroughRoomSeq"],
             snapshot["algorithmVersion"], snapshot["parameterHash"], snapshot["watermarkEventTime"],
             snapshot["watermarkEventTime"], snapshot["requiresReplay"], snapshot_id,
            room_id, key, existing_head_version),
        )
        if getattr(updated, "rowcount", 1) != 1:
            raise RuntimeError("ANALYTICS_HEAD_CAS_FAILED")
        self.connection.execute(
            """INSERT INTO analysis_projection_outbox
               (room_id,projection_key,analysis_epoch,projection_version,complete_through_room_seq,snapshot_url)
               VALUES (%s,%s,%s,%s,%s,%s)
               ON CONFLICT (room_id,projection_key,analysis_epoch,projection_version) DO NOTHING""",
            (room_id, key, snapshot["analysisEpoch"], version,
             snapshot["completeThroughRoomSeq"], self.snapshot_url_factory(room_id, key)),
        )

    def content_hash(self, payload: Any) -> str:
        return sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                  separators=(",", ":"), allow_nan=False).encode()).hexdigest()

    def advance_checkpoint(self, room_id: str, room_seq: int, *, consumer_name: str = "analytics") -> None:
        if not isinstance(room_seq, int) or isinstance(room_seq, bool) or room_seq < 0:
            raise ValueError("INVALID_ANALYTICS_CURSOR")
        self.connection.execute(
            """INSERT INTO analysis_consumer_checkpoints(consumer_name,room_id,last_room_seq)
               VALUES (%s,%s,%s)
               ON CONFLICT (consumer_name,room_id) DO UPDATE
               SET last_room_seq=GREATEST(analysis_consumer_checkpoints.last_room_seq,EXCLUDED.last_room_seq),
                   updated_at=now()""",
            (consumer_name, room_id, room_seq),
        )


__all__ = ["ProjectionStore"]
