"""Deterministic adapters from canonical room envelopes to ECHO/TRACE inputs."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Mapping, Sequence

from .derived_text import build_composite_artifact
from .reference.learning_orbit_algorithms_v1 import (
    ChatEvent, DeterministicEcosystemExtractor, EdgeEvidence, EvidenceRef,
    SourceRef,
)

EXTRACTOR_VERSION = "deterministic-ecosystem-v1"


@dataclass(frozen=True)
class ResolvedLineage:
    reply_event_id: str | None
    target_event_id: str | None


class MessageLineageIndex:
    """Maps message-root IDs to the currently active room event."""
    def __init__(self) -> None:
        self.active_by_message: dict[str, str] = {}

    def resolve_before(self, event: Mapping[str, Any]) -> ResolvedLineage:
        payload = event.get("payload", {})
        if not isinstance(payload, Mapping):
            raise ValueError("event payload must be an object")
        reply_root = payload.get("replyTo")
        message_root = payload.get("messageId")
        reply = self.active_by_message.get(str(reply_root)) if reply_root else None
        target = self.active_by_message.get(str(message_root)) if message_root else None
        if reply_root and reply is None:
            raise ValueError("reply message root has no active event")
        if event.get("operation") in {"revise", "retract", "delete"} and target is None:
            raise ValueError("revision target has no active event")
        return ResolvedLineage(reply, target)

    def advance(self, event: Mapping[str, Any]) -> None:
        payload = event.get("payload", {})
        if not isinstance(payload, Mapping):
            return
        root = payload.get("messageId")
        if not root:
            return
        root = str(root)
        if event.get("operation") in {"retract", "delete"}:
            self.active_by_message.pop(root, None)
        else:
            self.active_by_message[root] = str(event["eventId"])


def canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False,
                      separators=(",", ":"), sort_keys=True).encode("utf-8")


def to_chat_event(event: Mapping[str, Any], composite: Mapping[str, Any] | None = None,
                  lineage: MessageLineageIndex | None = None,
                  effective_event_time: Any | None = None) -> ChatEvent:
    payload = event.get("payload", {})
    if not isinstance(payload, Mapping):
        raise ValueError("event payload must be an object")
    index = lineage or MessageLineageIndex()
    before = index.resolve_before(event)
    if composite is None:
        composite = build_composite_artifact(event) or {"text": "", "modality": "text", "sourceConfidence": 1.0}
    modality = str(composite.get("modality", "text"))
    if modality not in {"text", "audio_asr", "image_ocr"}:
        modality = "text"
    agent_role = None
    if event.get("actorKind") == "agent":
        role = event.get("actorRole")
        # The wire role ``socratic_facilitator`` is mapped to the reference
        # ``summary`` role only inside this adapter.  Source IDs are validated
        # upstream when available; reply lineage remains the conservative
        # fallback for deterministic fixtures.
        agent_role = "summary" if role in {"summary", "socratic_facilitator"} else role
    value = effective_event_time if effective_event_time is not None else event.get("eventTime")
    result = ChatEvent(
        event_id=str(event["eventId"]), session_id=str(event.get("roomId", "")),
        event_time=value, ingest_time=event.get("ingestTime", value),
        actor_id=str(event["actorId"]), actor_kind=str(event["actorKind"]),
        modality=modality, text=str(composite.get("text", "")),
        source_confidence=float(composite.get("sourceConfidence", 1.0)),
        revision=int(event.get("revision", 1)), operation=str(event.get("operation", "add")),
        reply_to=before.reply_event_id,
        mentions=tuple(str(item) for item in (payload.get("mentions", ()) or ())),
        supersedes=before.target_event_id if event.get("operation") == "revise" else None,
        retracts=before.target_event_id if event.get("operation") in {"retract", "delete"} else None,
        agent_role=agent_role,
    )
    index.advance(event)
    return result


def extract_echo(event: ChatEvent, context: Sequence[ChatEvent] = ()) -> dict[str, Any]:
    candidates = DeterministicEcosystemExtractor().extract(event, context)
    output = {"extractorVersion": EXTRACTOR_VERSION, "eventId": event.event_id,
              "candidates": [candidate.to_dict() for candidate in candidates]}
    return {"output": output, "outputSha256": sha256(canonical_json(output)).hexdigest()}


def extract_trace_evidence(event: ChatEvent, context: Sequence[ChatEvent] = ()) -> tuple[EdgeEvidence, ...]:
    """Derive typed relations from causal context (without private reference state)."""
    by_id = {item.event_id: item for item in context}
    parent = by_id.get(event.reply_to or "")
    evidence: list[EdgeEvidence] = []
    targets: dict[str, str] = {}
    if parent is not None:
        targets[parent.actor_id] = "reply"
    for mention in event.mentions:
        targets.setdefault(mention, "mention")
    if targets:
        share = 1.0 / len(targets)
        for target_id in sorted(targets):
            evidence.append(EdgeEvidence(source_id=event.actor_id, target_id=target_id, layer="communication", polarity="positive", magnitude=share, confidence=event.source_confidence, basis=targets[target_id], object_id=event.event_id))
    else:
        evidence.append(EdgeEvidence(source_id=event.actor_id, target_id="ROOM", layer="communication", polarity="positive", magnitude=1.0, confidence=event.source_confidence, basis="broadcast", object_id=event.event_id))
    uptake = bool(re.search(r"(?:building on|build on|agree|because|based on|延續|接著|承接|同意|因為|根據|補充)", event.text, re.IGNORECASE))
    if parent is not None and uptake:
        source_id = parent.actor_id
        provenance: tuple[SourceRef, ...] = ()
        if parent.actor_kind == "agent":
            # A summary replies to a human source; retain the source actor for
            # lineage-adjusted view and keep the Agent facilitation edge.
            source_parent = by_id.get(parent.reply_to or "")
            if source_parent is not None and source_parent.actor_kind == "human":
                source_id = source_parent.actor_id
                provenance = (SourceRef(source_id=f"source:{source_parent.event_id}", event_id=source_parent.event_id, actor_id=source_parent.actor_id, actor_kind="human", confidence=source_parent.source_confidence),)
        evidence.append(EdgeEvidence(source_id=source_id, target_id=event.actor_id, layer="uptake", polarity="positive", magnitude=1.0, confidence=event.source_confidence, basis="semantic_uptake", object_id=parent.event_id, provenance=provenance))
        if parent.actor_kind == "agent":
            evidence.append(EdgeEvidence(source_id=parent.actor_id, target_id=event.actor_id, layer="facilitation", polarity="positive", magnitude=1.0, confidence=event.source_confidence, basis="summary_facilitation", object_id=parent.event_id, provenance=provenance))
    if event.actor_kind == "agent" and event.agent_role in {"socratic_facilitator", "summary"} and parent is not None and parent.actor_kind == "human":
        evidence.append(EdgeEvidence(source_id=event.actor_id, target_id=parent.actor_id, layer="facilitation", polarity="positive", magnitude=1.0, confidence=event.source_confidence, basis="facilitator_reply", object_id=event.event_id))
    return tuple(evidence)


def reference_trace_snapshot(events: Sequence[ChatEvent], *, now: Any | None = None) -> dict[str, Any]:
    from .reference.learning_orbit_algorithms_v1 import StreamingInteractionNetwork
    network = StreamingInteractionNetwork()
    for event in events:
        network.apply(event)
    return network.snapshot(now=now).to_dict()
