"""Small transactional persistence port for analytics projections.

The computation modules remain pure; this class is the only worker seam that
writes the analytics read models.  It deliberately does not write room_event
or outbox_event.  psycopg connections and lightweight test doubles exposing
``execute`` are both supported.
"""
from __future__ import annotations

from typing import Any, Mapping
from uuid import UUID
from datetime import datetime


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
             snapshot["algorithmVersion"], snapshot["parameterHash"], snapshot["payload"], payload_hash),
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
                 patch["algorithmVersion"], patch["parameterHash"], patch, patch_hash),
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
