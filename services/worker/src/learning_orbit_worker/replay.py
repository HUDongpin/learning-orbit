"""Replay helpers for online/batch parity checks."""
from __future__ import annotations

from hashlib import sha256
import json
from typing import Any, Mapping, Sequence

from .projector import StreamingProjector


def canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode()
    return sha256(encoded).hexdigest()


def replay_room(events: Sequence[Mapping[str, Any]], room_id: str) -> StreamingProjector:
    projector = StreamingProjector(room_id)
    for event in sorted(events, key=lambda value: (int(value["roomSeq"]), str(value["eventId"]))):
        projector.consume(event)
    return projector


def online_batch_parity(events: Sequence[Mapping[str, Any]], room_id: str) -> bool:
    online = StreamingProjector(room_id)
    for event in events:
        online.consume(event)
    batch = replay_room(events, room_id)
    return canonical_hash(online.snapshot()) == canonical_hash(batch.snapshot())
