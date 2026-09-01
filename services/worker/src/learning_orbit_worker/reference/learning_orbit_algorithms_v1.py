"""Deterministic standard-library reference algorithms for Learning Orbit.

The extractors below are deliberately small executable fixtures.  They are not
natural-language-processing models and make no claim of linguistic coverage.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
import re
import time
from typing import Any, Protocol, Sequence, runtime_checkable


REFERENCE_VERSION = "1.1"

TimeValue = float | int | datetime | str


def _json_time(value: TimeValue) -> float | int | str:
    """Return a datetime-free value accepted by :mod:`json`."""
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _require_choice(name: str, value: str, choices: set[str]) -> None:
    if value not in choices:
        allowed = ", ".join(sorted(choices))
        raise ValueError(f"{name} must be one of: {allowed}")


def _require_nonempty_string(name: str, value: Any) -> None:
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    if not value:
        raise ValueError(f"{name} must not be empty")


def _require_string(name: str, value: Any) -> None:
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")


def _require_probability(name: str, value: Any) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} must be a number")
    if not math.isfinite(value) or not 0.0 <= value <= 1.0:
        raise ValueError(f"{name} must be finite and in [0, 1]")


def _require_nonnegative_number(name: str, value: Any) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} must be a number")
    if not math.isfinite(value) or value < 0.0:
        raise ValueError(f"{name} must be finite and non-negative")


@dataclass(frozen=True)
class ChatEvent:
    """One immutable chat-ledger operation."""

    event_id: str
    session_id: str
    event_time: TimeValue
    ingest_time: TimeValue
    actor_id: str
    actor_kind: str
    modality: str
    text: str
    source_confidence: float = 1.0
    revision: int = 1
    operation: str = "add"
    reply_to: str | None = None
    mentions: tuple[str, ...] = ()
    supersedes: str | None = None
    retracts: str | None = None
    agent_role: str | None = None

    def __post_init__(self) -> None:
        _require_choice("actor_kind", self.actor_kind, {"human", "agent"})
        _require_choice(
            "modality",
            self.modality,
            {"text", "audio_asr", "image_ocr"},
        )
        _require_choice(
            "operation",
            self.operation,
            {"add", "revise", "delete", "retract"},
        )
        if not self.event_id or not self.session_id or not self.actor_id:
            raise ValueError("event_id, session_id, and actor_id are required")
        if not 0.0 <= self.source_confidence <= 1.0:
            raise ValueError("source_confidence must be in [0, 1]")
        if self.revision < 1:
            raise ValueError("revision must be positive")
        for name, value in (
            ("event_time", self.event_time),
            ("ingest_time", self.ingest_time),
        ):
            try:
                _seconds(value)
            except (OverflowError, TypeError, ValueError) as error:
                raise ValueError(f"{name} must be a finite time") from error
        object.__setattr__(self, "mentions", tuple(self.mentions))

    def to_dict(self) -> dict[str, Any]:
        return {
            "eventId": self.event_id,
            "sessionId": self.session_id,
            "eventTime": _json_time(self.event_time),
            "ingestTime": _json_time(self.ingest_time),
            "actorId": self.actor_id,
            "actorKind": self.actor_kind,
            "modality": self.modality,
            "text": self.text,
            "sourceConfidence": self.source_confidence,
            "revision": self.revision,
            "operation": self.operation,
            "replyTo": self.reply_to,
            "mentions": list(self.mentions),
            "supersedes": self.supersedes,
            "retracts": self.retracts,
            "agentRole": self.agent_role,
        }


@dataclass(frozen=True)
class EvidenceRef:
    """Addressable evidence retained with a proposition."""

    evidence_id: str
    event_id: str
    text: str = ""
    start: int | None = None
    end: int | None = None
    extractor: str = "deterministic_fixture"
    source_confidence: float = 1.0

    def __post_init__(self) -> None:
        _validate_evidence_ref(self)

    def to_dict(self) -> dict[str, Any]:
        return {
            "evidenceId": self.evidence_id,
            "eventId": self.event_id,
            "text": self.text,
            "start": self.start,
            "end": self.end,
            "extractor": self.extractor,
            "sourceConfidence": self.source_confidence,
        }


def _validate_evidence_ref(item: Any) -> None:
    if not isinstance(item, EvidenceRef):
        raise TypeError("evidence entries must be EvidenceRef instances")
    _require_nonempty_string("EvidenceRef.evidence_id", item.evidence_id)
    _require_nonempty_string("EvidenceRef.event_id", item.event_id)


@dataclass(frozen=True)
class CandidateProposition:
    """A source-linked proposition candidate, not an asserted ground truth."""

    head: str
    link_phrase: str
    tail: str
    relation_family: str
    stance: str
    confidence: float
    evidence: tuple[EvidenceRef, ...]
    inferred: bool = False

    def __post_init__(self) -> None:
        evidence = _validate_candidate_proposition(self)
        object.__setattr__(self, "evidence", evidence)

    def to_dict(self) -> dict[str, Any]:
        return {
            "head": self.head,
            "linkPhrase": self.link_phrase,
            "tail": self.tail,
            "relationFamily": self.relation_family,
            "stance": self.stance,
            "confidence": self.confidence,
            "evidence": [item.to_dict() for item in self.evidence],
            "inferred": self.inferred,
        }


def _validate_candidate_proposition(
    item: Any,
) -> tuple[EvidenceRef, ...]:
    if not isinstance(item, CandidateProposition):
        raise TypeError("extractor entries must be CandidateProposition")
    for name in ("head", "link_phrase", "tail", "relation_family"):
        _require_string(f"CandidateProposition.{name}", getattr(item, name))
    _require_string("CandidateProposition.stance", item.stance)
    _require_choice(
        "stance",
        item.stance,
        {"support", "oppose", "uncertain", "question"},
    )
    _require_probability("CandidateProposition.confidence", item.confidence)
    evidence = tuple(item.evidence)
    for ref in evidence:
        _validate_evidence_ref(ref)
    return evidence


@runtime_checkable
class PropositionExtractor(Protocol):
    """Protocol for deterministic or model-backed proposition adapters."""

    def extract(
        self,
        event: ChatEvent,
        context: Sequence[ChatEvent],
    ) -> Sequence[CandidateProposition]:
        """Return candidates; callers retain evidence and confidence."""


@dataclass(frozen=True)
class _EcosystemPattern:
    regex: re.Pattern[str]
    head: str
    link_phrase: str
    tail: str
    family: str


class DeterministicEcosystemExtractor:
    """Recognize only a tiny, declared English/Traditional-Chinese fixture."""

    _patterns = (
        _EcosystemPattern(
            re.compile(
                r"(?:sun.*\b(?:provides?|provided|gives?|given)\b"
                r".*energy.*producers?"
                r"|太陽.*生產者.*(?:能量|能源))",
                re.IGNORECASE,
            ),
            "sun",
            "provides energy to",
            "producers",
            "energy_flow",
        ),
        _EcosystemPattern(
            re.compile(
                r"(?:producers?.*\b(?:feeds?|feeding|supports?|supported|supporting)\b"
                r".*consumers?"
                r"|生產者.*(?:供養|供給|提供).*消費者)",
                re.IGNORECASE,
            ),
            "producers",
            "feed",
            "consumers",
            "trophic",
        ),
        _EcosystemPattern(
            re.compile(
                r"(?:consumers?.*\b(?:eats?|eaten|eating|consumes?|consumed)\b"
                r".*producers?"
                r"|消費者.*(?:吃|取食|攝食).*生產者)",
                re.IGNORECASE,
            ),
            "consumers",
            "consume",
            "producers",
            "trophic",
        ),
        _EcosystemPattern(
            re.compile(
                r"(?:decomposers?.*\b(?:returns?|returned|returning"
                r"|recycles?|recycled)\b.*"
                r"(?:nutrients?.*)?soil|分解者.*(?:養分|營養).*(?:土壤))",
                re.IGNORECASE,
            ),
            "decomposers",
            "return nutrients to",
            "soil",
            "nutrient_cycle",
        ),
        _EcosystemPattern(
            re.compile(
                r"(?:soil.*\b(?:provides?|provided|supplies|supplied)\b"
                r".*nutrients?.*producers?"
                r"|土壤.*(?:養分|營養).*生產者)",
                re.IGNORECASE,
            ),
            "soil",
            "provides nutrients to",
            "producers",
            "nutrient_cycle",
        ),
        _EcosystemPattern(
            re.compile(
                r"(?:energy.*\b(?:lost|released)\b.*heat"
                r"|能量.*(?:熱|熱能).*(?:散失|釋放|流失))",
                re.IGNORECASE,
            ),
            "energy",
            "is released as",
            "heat",
            "energy_loss",
        ),
    )

    @staticmethod
    def _stance(text: str) -> str:
        lowered = text.casefold()
        if re.search(r"(?:不同意|反對|disagree|reject)", lowered):
            return "oppose"
        if re.search(r"(?:不確定|可能|也許|uncertain|might|perhaps)", lowered):
            return "uncertain"
        if "?" in text or "？" in text:
            return "question"
        return "support"

    def extract(
        self,
        event: ChatEvent,
        context: Sequence[ChatEvent],
    ) -> tuple[CandidateProposition, ...]:
        del context
        found: list[CandidateProposition] = []
        stance = self._stance(event.text)
        for index, pattern in enumerate(self._patterns):
            match = pattern.regex.search(event.text)
            if not match:
                continue
            digest = hashlib.sha256(
                f"{event.event_id}:{event.revision}:{index}".encode()
            ).hexdigest()[:12]
            ref = EvidenceRef(
                evidence_id=f"ev-{digest}",
                event_id=event.event_id,
                text=match.group(0),
                start=match.start(),
                end=match.end(),
                source_confidence=event.source_confidence,
            )
            found.append(
                CandidateProposition(
                    head=pattern.head,
                    link_phrase=pattern.link_phrase,
                    tail=pattern.tail,
                    relation_family=pattern.family,
                    stance=stance,
                    confidence=0.95,
                    evidence=(ref,),
                    inferred=False,
                )
            )
        return tuple(found)


def _seconds(value: TimeValue) -> float:
    """Convert supported time values to seconds for deterministic arithmetic."""
    if isinstance(value, datetime):
        parsed = value
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        result = parsed.timestamp()
    elif isinstance(value, (float, int)):
        result = float(value)
    else:
        try:
            result = float(value)
        except ValueError:
            normalized = value.replace("Z", "+00:00")
            parsed = datetime.fromisoformat(normalized)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            result = parsed.timestamp()
    if not math.isfinite(result):
        raise ValueError("time must be finite")
    return result


def _stable_id(prefix: str, *parts: object) -> str:
    joined = "\x1f".join(str(part) for part in parts)
    digest = hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}-{digest}"


@dataclass(frozen=True)
class MapPatch:
    """Deterministic delta metadata shared by both streaming references."""

    patch_id: str
    event_id: str | None
    operation: str
    added_nodes: tuple[str, ...] = ()
    updated_nodes: tuple[str, ...] = ()
    removed_nodes: tuple[str, ...] = ()
    added_edges: tuple[str, ...] = ()
    updated_edges: tuple[str, ...] = ()
    removed_edges: tuple[str, ...] = ()
    requires_replay: bool = False
    duplicate: bool = False
    accepted: bool = True
    reason: str | None = None

    @property
    def changed(self) -> bool:
        return self.accepted and not self.duplicate and any(
            (
                self.added_nodes,
                self.updated_nodes,
                self.removed_nodes,
                self.added_edges,
                self.updated_edges,
                self.removed_edges,
            )
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "patchId": self.patch_id,
            "eventId": self.event_id,
            "operation": self.operation,
            "addedNodes": list(self.added_nodes),
            "updatedNodes": list(self.updated_nodes),
            "removedNodes": list(self.removed_nodes),
            "addedEdges": list(self.added_edges),
            "updatedEdges": list(self.updated_edges),
            "removedEdges": list(self.removed_edges),
            "requiresReplay": self.requires_replay,
            "duplicate": self.duplicate,
            "accepted": self.accepted,
            "reason": self.reason,
        }


@dataclass
class _EventLedgerEntry:
    event: ChatEvent
    active: bool
    requires_replay: bool = False

    def to_dict(self) -> dict[str, Any]:
        payload = self.event.to_dict()
        payload.update(
            {
                "active": self.active,
                "requiresReplay": self.requires_replay,
            }
        )
        return payload


@dataclass
class _ConceptContribution:
    contribution_id: str
    event_id: str
    revision: int
    event_time: float
    head: str
    predicate: str
    tail: str
    relation_family: str
    stance: str
    quality: float
    evidence: tuple[EvidenceRef, ...]
    active: bool = True


@dataclass(frozen=True)
class _ConceptInput:
    event: ChatEvent
    context: tuple[ChatEvent, ...]


class StreamingConceptMap:
    """ECHO-CM reference with event-time decay and reversible evidence.

    The class stores extraction deltas rather than treating a snapshot as
    ground truth.  A severely late operation is ledgered with
    ``requires_replay`` and does not mutate the active evidence graph until a
    deterministic replay is requested.
    """

    _known_types = {
        "python_language": "language",
        "python language": "language",
        "python語言": "language",
        "snake": "animal",
        "蛇": "animal",
    }

    def __init__(
        self,
        extractor: PropositionExtractor | None = None,
        *,
        allowed_lateness: float = 5.0,
        half_life: float = 30.0 * 60.0,
        theta_on: float = 0.6,
        theta_off: float = 0.3,
    ) -> None:
        if not math.isfinite(allowed_lateness) or allowed_lateness < 0.0:
            raise ValueError("allowed_lateness must be non-negative")
        if not math.isfinite(half_life) or half_life <= 0.0:
            raise ValueError("half_life must be positive")
        if (
            not math.isfinite(theta_off)
            or not math.isfinite(theta_on)
            or not 0.0 <= theta_off <= theta_on
        ):
            raise ValueError("require 0 <= theta_off <= theta_on")
        self.extractor = extractor or DeterministicEcosystemExtractor()
        self.allowed_lateness = float(allowed_lateness)
        self.half_life = float(half_life)
        self.theta_on = float(theta_on)
        self.theta_off = float(theta_off)
        self.aliases: dict[str, str] = {}
        self.concept_types: dict[str, str] = dict(self._known_types)
        self.organization_graph: dict[str, dict[str, str]] = {}
        self.merge_log: list[dict[str, Any]] = []
        self._merge_type_baselines: dict[
            str,
            tuple[bool, str | None],
        ] = {}
        self._merge_type_layers: dict[
            str,
            list[tuple[str, str]],
        ] = {}
        self._history: list[_ConceptInput] = []
        self._reset_runtime()

    def _reset_runtime(self) -> None:
        self.event_ledger: dict[str, list[_EventLedgerEntry]] = {}
        self.per_event_deltas: dict[str, tuple[str, ...]] = {}
        self._contributions: dict[str, _ConceptContribution] = {}
        self._seen: set[tuple[str, int, str]] = set()
        self._visible_edge_ids: set[str] = set()
        self.archived_edge_ids: set[str] = set()
        # Event ids whose retraction was accepted.  A retraction can be
        # delivered before the event it targets, so the tombstone has to
        # outlive the miss in ``_deactivate``.
        self._retracted_event_ids: set[str] = set()
        self._requires_replay: list[str] = []
        self.watermark: float | None = None

    @property
    def requires_replay(self) -> tuple[str, ...]:
        return tuple(self._requires_replay)

    @staticmethod
    def _event_key(event: ChatEvent) -> tuple[str, int, str]:
        return (event.event_id, event.revision, event.operation)

    def _patch(
        self,
        event: ChatEvent,
        *,
        added_nodes: Sequence[str] = (),
        added_edges: Sequence[str] = (),
        updated_edges: Sequence[str] = (),
        removed_edges: Sequence[str] = (),
        requires_replay: bool = False,
        duplicate: bool = False,
        accepted: bool = True,
        reason: str | None = None,
    ) -> MapPatch:
        node_ids = tuple(sorted(set(added_nodes)))
        added = tuple(sorted(set(added_edges)))
        updated = tuple(sorted(set(updated_edges)))
        removed = tuple(sorted(set(removed_edges)))
        patch_id = _stable_id(
            "cmp",
            event.event_id,
            event.revision,
            event.operation,
            node_ids,
            added,
            updated,
            removed,
            requires_replay,
            duplicate,
            accepted,
            reason,
        )
        return MapPatch(
            patch_id=patch_id,
            event_id=event.event_id,
            operation=event.operation,
            added_nodes=node_ids,
            added_edges=added,
            updated_edges=updated,
            removed_edges=removed,
            requires_replay=requires_replay,
            duplicate=duplicate,
            accepted=accepted,
            reason=reason,
        )

    def _is_too_late(self, event_time: float) -> bool:
        if self.watermark is None:
            return False
        return event_time < self.watermark - self.allowed_lateness

    def _ledger(
        self,
        event: ChatEvent,
        *,
        active: bool,
        requires_replay: bool = False,
    ) -> _EventLedgerEntry:
        entry = _EventLedgerEntry(
            event=event,
            active=active,
            requires_replay=requires_replay,
        )
        self.event_ledger.setdefault(event.event_id, []).append(entry)
        return entry

    def _deactivate(self, target_event_id: str) -> tuple[str, ...]:
        removed: set[str] = set()
        for entry in self.event_ledger.get(target_event_id, ()):
            entry.active = False
        for contribution in self._contributions.values():
            if contribution.event_id != target_event_id:
                continue
            if contribution.active:
                contribution.active = False
                removed.add(self._edge_id_for_contribution(contribution))
        return tuple(sorted(removed))

    def apply(
        self,
        event: ChatEvent,
        context: Sequence[ChatEvent] = (),
        *,
        _record_history: bool = True,
    ) -> MapPatch:
        """Apply one ledger operation, returning a deterministic map patch."""
        key = self._event_key(event)
        if key in self._seen:
            return self._patch(event, duplicate=True, reason="duplicate")
        event_time = _seconds(event.event_time)
        history_item = _ConceptInput(event, tuple(context))

        def commit_identity() -> None:
            self._seen.add(key)
            if _record_history:
                self._history.append(history_item)

        if self._is_too_late(event_time):
            commit_identity()
            self._ledger(event, active=False, requires_replay=True)
            if event.event_id not in self._requires_replay:
                self._requires_replay.append(event.event_id)
            return self._patch(
                event,
                requires_replay=True,
                accepted=False,
                reason="beyond_allowed_lateness",
            )

        target = event.retracts or event.supersedes or event.event_id
        deactivate_target = event.operation in {
            "revise",
            "delete",
            "retract",
        }
        if not deactivate_target and event.event_id in self.event_ledger:
            active_entries = [
                item
                for item in self.event_ledger[event.event_id]
                if item.active
            ]
            if active_entries:
                highest = max(item.event.revision for item in active_entries)
                if event.revision <= highest:
                    commit_identity()
                    if self.watermark is None or event_time > self.watermark:
                        self.watermark = event_time
                    return self._patch(
                        event,
                        duplicate=True,
                        reason="stale_revision",
                    )
                deactivate_target = True

        if event.operation in {"delete", "retract"}:
            commit_identity()
            if self.watermark is None or event_time > self.watermark:
                self.watermark = event_time
            removed = self._deactivate(target)
            self._retracted_event_ids.add(target)
            self._ledger(event, active=False)
            return self._patch(
                event,
                removed_edges=removed,
                reason="retracted",
            )

        if event.event_id in self._retracted_event_ids:
            # Out-of-order delivery: the retraction for this event was already
            # accepted.  ``_deactivate`` could not reach these contributions
            # because they did not exist yet, so the tombstone is what keeps
            # the retraction meaningful.  The event still joins the ledger and
            # advances the watermark; it just never contributes evidence.
            commit_identity()
            if self.watermark is None or event_time > self.watermark:
                self.watermark = event_time
            removed = self._deactivate(event.event_id)
            self._ledger(event, active=False)
            return self._patch(
                event,
                removed_edges=removed,
                reason="retracted_before_arrival",
            )

        propositions = tuple(self.extractor.extract(event, context))
        staged: list[_ConceptContribution] = []
        contribution_ids: list[str] = []
        edge_ids: list[str] = []
        nodes: set[str] = set()
        for index, candidate in enumerate(propositions):
            refs = _validate_candidate_proposition(candidate)
            predicate = candidate.link_phrase.strip()
            if not predicate or not refs:
                continue
            contribution_id = _stable_id(
                "cc",
                event.event_id,
                event.revision,
                index,
                candidate.head,
                predicate,
                candidate.tail,
                tuple(item.evidence_id for item in refs),
            )
            contribution = _ConceptContribution(
                contribution_id=contribution_id,
                event_id=event.event_id,
                revision=event.revision,
                event_time=event_time,
                head=candidate.head.strip(),
                predicate=predicate,
                tail=candidate.tail.strip(),
                relation_family=candidate.relation_family,
                stance=candidate.stance,
                quality=event.source_confidence * candidate.confidence,
                evidence=refs,
            )
            staged.append(contribution)
            contribution_ids.append(contribution_id)
            edge_ids.append(self._edge_id_for_contribution(contribution))
            nodes.update((contribution.head, contribution.tail))

        commit_identity()
        if self.watermark is None or event_time > self.watermark:
            self.watermark = event_time
        removed: tuple[str, ...] = ()
        if deactivate_target:
            removed = self._deactivate(target)
        for contribution in staged:
            self._contributions[contribution.contribution_id] = contribution
        delta_key = f"{event.event_id}:{event.revision}"
        self.per_event_deltas[delta_key] = tuple(sorted(contribution_ids))
        self._ledger(event, active=True)
        return self._patch(
            event,
            added_nodes=nodes,
            added_edges=edge_ids,
            removed_edges=removed,
            updated_edges=edge_ids if removed else (),
            reason="applied",
        )

    def _canonical(self, concept: str) -> str:
        seen: set[str] = set()
        current = concept
        while current in self.aliases and current not in seen:
            seen.add(current)
            current = self.aliases[current]
        return current

    def _edge_key(
        self,
        contribution: _ConceptContribution,
    ) -> tuple[str, str, str, str]:
        return (
            self._canonical(contribution.head),
            contribution.predicate,
            self._canonical(contribution.tail),
            contribution.relation_family,
        )

    def _edge_id_for_contribution(
        self,
        contribution: _ConceptContribution,
    ) -> str:
        return _stable_id("edge", *self._edge_key(contribution))

    def _edge_identity_map(self) -> dict[str, str]:
        """Snapshot each active contribution's edge id before an alias change.

        Inactive contributions are excluded deliberately: ``_aggregate`` skips
        them, so they can never back a visible edge, and letting one define an
        edge identity would redirect a live edge's hysteresis onto a key with
        no active evidence behind it.
        """
        return {
            item.contribution_id: self._edge_id_for_contribution(item)
            for item in self._contributions.values()
            if item.active
        }

    def _rekey_visibility(self, before: dict[str, str]) -> None:
        """Carry hysteresis and archive state across an alias change.

        Aliasing rewrites the canonical key of the affected edges only.
        Clearing the visible set instead would drop the theta_off band for
        every edge in the room, so an unrelated held edge would disappear at
        the next snapshot without ever being archived.

        Many contributions can share one edge id, and an alias change can send
        them to different keys, so the inverse map is one-to-many: an old id
        carries its state to *every* successor.  Collapsing it to a single
        entry would strand the other successors in exactly the state this
        method exists to prevent.
        """
        successors: dict[str, set[str]] = {}
        for contribution_id, old_edge_id in before.items():
            item = self._contributions.get(contribution_id)
            if item is None or not item.active:
                continue
            successors.setdefault(old_edge_id, set()).add(
                self._edge_id_for_contribution(item)
            )

        def carry(edge_ids: set[str]) -> set[str]:
            carried: set[str] = set()
            for edge_id in edge_ids:
                carried.update(successors.get(edge_id, {edge_id}))
            return carried

        self._visible_edge_ids = carry(self._visible_edge_ids)
        self.archived_edge_ids = carry(self.archived_edge_ids) - self._visible_edge_ids

    def _aggregate(
        self,
        now: float,
    ) -> dict[tuple[str, str, str, str], dict[str, Any]]:
        aggregate: dict[tuple[str, str, str, str], dict[str, Any]] = {}
        channel_for = {
            "support": "support",
            "oppose": "challenge",
            "uncertain": "uncertain",
            "question": "question",
        }
        for item in self._contributions.values():
            if not item.active:
                continue
            key = self._edge_key(item)
            record = aggregate.setdefault(
                key,
                {
                    "channels": {
                        "support": 0.0,
                        "challenge": 0.0,
                        "uncertain": 0.0,
                        "question": 0.0,
                    },
                    "evidence": set(),
                    "contributions": [],
                },
            )
            age = max(0.0, now - item.event_time)
            decayed = item.quality * math.pow(2.0, -age / self.half_life)
            channel = channel_for[item.stance]
            record["channels"][channel] += decayed
            record["evidence"].update(
                ref.evidence_id for ref in item.evidence
            )
            record["contributions"].append((item, decayed, channel))
        return aggregate

    @staticmethod
    def _position(concept: str) -> dict[str, float]:
        digest = hashlib.sha256(concept.encode("utf-8")).digest()
        x_raw = int.from_bytes(digest[:4], "big")
        y_raw = int.from_bytes(digest[4:8], "big")
        maximum = float((1 << 32) - 1)
        return {
            "x": round((x_raw / maximum) * 2.0 - 1.0, 6),
            "y": round((y_raw / maximum) * 2.0 - 1.0, 6),
        }

    def _status(self, channels: dict[str, float]) -> str:
        support = channels["support"]
        challenge = channels["challenge"]
        if support >= self.theta_off and challenge >= self.theta_off:
            return "disputed"
        if challenge > max(support, channels["uncertain"]):
            return "challenged"
        if channels["uncertain"] > support:
            return "uncertain"
        return "supported"

    def snapshot(self, now: TimeValue | None = None) -> dict[str, Any]:
        """Materialize only evidence-layer edges at the requested event time."""
        when = (
            self.watermark or 0.0
            if now is None
            else _seconds(now)
        )
        aggregate = self._aggregate(float(when))
        visible: set[str] = set()
        edges: list[dict[str, Any]] = []
        node_ids: set[str] = set()
        for key in sorted(aggregate):
            head, predicate, tail, family = key
            record = aggregate[key]
            channels = record["channels"]
            activity = max(
                channels["support"],
                channels["challenge"],
                channels["uncertain"],
            )
            edge_id = _stable_id("edge", *key)
            was_visible = edge_id in self._visible_edge_ids
            is_visible = (
                activity >= self.theta_off
                if was_visible
                else activity >= self.theta_on
            )
            if not is_visible:
                if was_visible:
                    self.archived_edge_ids.add(edge_id)
                continue
            visible.add(edge_id)
            self.archived_edge_ids.discard(edge_id)
            node_ids.update((head, tail))
            edges.append(
                {
                    "edgeId": edge_id,
                    "head": head,
                    "predicate": predicate,
                    "tail": tail,
                    "relationFamily": family,
                    "layer": "evidence",
                    "status": self._status(channels),
                    "channels": {
                        name: round(value, 12)
                        for name, value in channels.items()
                    },
                    "evidenceIds": sorted(record["evidence"]),
                }
            )
        for old_edge in self._visible_edge_ids - visible:
            self.archived_edge_ids.add(old_edge)
        self._visible_edge_ids = visible
        nodes = []
        for node_id in sorted(node_ids):
            node = {
                "nodeId": node_id,
                "label": node_id,
                "conceptType": self.concept_types.get(node_id),
            }
            node.update(self._position(node_id))
            nodes.append(node)
        return {
            "generatedAt": float(when),
            "watermark": self.watermark,
            "nodes": nodes,
            "edges": edges,
            "archivedEdgeIds": sorted(self.archived_edge_ids),
            "requiresReplay": list(self._requires_replay),
        }

    def explain_edge(
        self,
        head: str,
        predicate: str,
        tail: str,
        *,
        now: TimeValue | None = None,
    ) -> dict[str, Any]:
        """Explain active and retracted evidence for one semantic edge."""
        when = self.watermark or 0.0 if now is None else _seconds(now)
        canonical = (
            self._canonical(head),
            predicate,
            self._canonical(tail),
        )
        channels = {
            "support": 0.0,
            "challenge": 0.0,
            "uncertain": 0.0,
            "question": 0.0,
        }
        details: list[dict[str, Any]] = []
        stance_map = {
            "support": "support",
            "oppose": "challenge",
            "uncertain": "uncertain",
            "question": "question",
        }
        for item in sorted(
            self._contributions.values(),
            key=lambda value: value.contribution_id,
        ):
            if (
                self._canonical(item.head),
                item.predicate,
                self._canonical(item.tail),
            ) != canonical:
                continue
            age = max(0.0, float(when) - item.event_time)
            decayed = item.quality * math.pow(2.0, -age / self.half_life)
            channel = stance_map[item.stance]
            if item.active:
                channels[channel] += decayed
            details.append(
                {
                    "contributionId": item.contribution_id,
                    "eventId": item.event_id,
                    "active": item.active,
                    "channel": channel,
                    "baseQuality": item.quality,
                    "decayedQuality": round(decayed, 12),
                    "evidenceIds": sorted(
                        ref.evidence_id for ref in item.evidence
                    ),
                }
            )
        edge_ids = {
            self._edge_id_for_contribution(item)
            for item in self._contributions.values()
            if (
                self._canonical(item.head),
                item.predicate,
                self._canonical(item.tail),
            ) == canonical
        }
        return {
            "head": canonical[0],
            "predicate": canonical[1],
            "tail": canonical[2],
            "channels": {
                name: round(value, 12)
                for name, value in channels.items()
            },
            "visible": bool(edge_ids & self._visible_edge_ids),
            "contributions": details,
        }

    def merge_concepts(
        self,
        alias: str,
        canonical: str,
        *,
        alias_type: str | None = None,
        canonical_type: str | None = None,
    ) -> bool:
        """Merge an alias unless the explicit deterministic type guard fires."""
        resolved_alias_type = (
            alias_type
            or self.concept_types.get(alias)
            or self._known_types.get(alias.casefold())
        )
        resolved_canonical_type = (
            canonical_type
            or self.concept_types.get(canonical)
            or self._known_types.get(canonical.casefold())
        )
        if (
            resolved_alias_type
            and resolved_canonical_type
            and resolved_alias_type != resolved_canonical_type
        ):
            self.merge_log.append(
                {
                    "alias": alias,
                    "canonical": canonical,
                    "accepted": False,
                    "reason": "type_conflict",
                }
            )
            return False
        previous = self.aliases.get(alias)
        if alias == canonical or previous == canonical:
            return True
        alias_type_present = alias in self.concept_types
        prior_alias_type = self.concept_types.get(alias)
        canonical_type_present = canonical in self.concept_types
        prior_canonical_type = self.concept_types.get(canonical)
        merge_id = _stable_id(
            "merge",
            len(self.merge_log),
            alias,
            canonical,
            previous,
        )
        before = self._edge_identity_map()
        self.aliases[alias] = canonical
        if resolved_alias_type:
            self._push_merge_type(alias, merge_id, resolved_alias_type)
        if resolved_canonical_type:
            self._push_merge_type(
                canonical,
                merge_id,
                resolved_canonical_type,
            )
        self.organization_graph[alias] = {
            "sourceId": alias,
            "targetId": canonical,
            "relation": "possibly_same_as",
        }
        self.merge_log.append(
            {
                "alias": alias,
                "canonical": canonical,
                "accepted": True,
                "reason": "merged",
                "mergeId": merge_id,
                "previous": previous,
                "aliasTypePresent": alias_type_present,
                "priorAliasType": prior_alias_type,
                "canonicalTypePresent": canonical_type_present,
                "priorCanonicalType": prior_canonical_type,
                "appliedAliasType": resolved_alias_type,
                "appliedCanonicalType": resolved_canonical_type,
            }
        )
        self._rekey_visibility(before)
        return True

    def _push_merge_type(
        self,
        concept: str,
        merge_id: str,
        concept_type: str,
    ) -> None:
        layers = self._merge_type_layers.setdefault(concept, [])
        if not layers:
            self._merge_type_baselines[concept] = (
                concept in self.concept_types,
                self.concept_types.get(concept),
            )
        layers.append((merge_id, concept_type))
        self.concept_types[concept] = concept_type

    def _remove_merge_type(self, concept: str, merge_id: str) -> None:
        layers = self._merge_type_layers.get(concept, [])
        remaining = [item for item in layers if item[0] != merge_id]
        if remaining:
            self._merge_type_layers[concept] = remaining
            self.concept_types[concept] = remaining[-1][1]
            return
        self._merge_type_layers.pop(concept, None)
        present, prior = self._merge_type_baselines.pop(
            concept,
            (False, None),
        )
        if present:
            self.concept_types[concept] = prior
        else:
            self.concept_types.pop(concept, None)

    def undo_merge(self, alias: str | None = None) -> bool:
        """Undo the most recent accepted merge for ``alias`` or globally."""
        for record in reversed(self.merge_log):
            if not record.get("accepted") or record.get("undone"):
                continue
            if alias is not None and record["alias"] != alias:
                continue
            before = self._edge_identity_map()
            target_alias = record["alias"]
            previous = record.get("previous")
            if previous is None:
                self.aliases.pop(target_alias, None)
                self.organization_graph.pop(target_alias, None)
            else:
                self.aliases[target_alias] = previous
                self.organization_graph[target_alias] = {
                    "sourceId": target_alias,
                    "targetId": previous,
                    "relation": "possibly_same_as",
                }
            canonical = record["canonical"]
            merge_id = record["mergeId"]
            if record.get("appliedAliasType"):
                self._remove_merge_type(target_alias, merge_id)
            if record.get("appliedCanonicalType"):
                self._remove_merge_type(canonical, merge_id)
            record["undone"] = True
            self._rekey_visibility(before)
            return True
        return False

    def replay(
        self,
        events: Sequence[ChatEvent] | None = None,
        *,
        now: TimeValue | None = None,
    ) -> dict[str, Any]:
        """Rebuild in recorded causal order with event-time decay.

        Arrival order is part of the ledger contract for revise, delete, and
        retract operations.  Reordering an accepted control operation ahead of
        its target would reverse its meaning; event time still controls decay.
        """
        history = list(
            self._history
            if events is None
            else (_ConceptInput(item, ()) for item in events)
        )
        if events is not None:
            self._history = list(history)
        self._reset_runtime()
        lateness = self.allowed_lateness
        self.allowed_lateness = math.inf
        try:
            for item in history:
                self.apply(
                    item.event,
                    context=item.context,
                    _record_history=False,
                )
        finally:
            self.allowed_lateness = lateness
        return self.snapshot(now=now)


@dataclass(frozen=True)
class SourceRef:
    """Provenance source for a derived interaction edge."""

    source_id: str
    event_id: str
    actor_id: str
    actor_kind: str = "human"
    confidence: float = 1.0

    def __post_init__(self) -> None:
        _validate_source_ref(self)

    def to_dict(self) -> dict[str, Any]:
        return {
            "sourceId": self.source_id,
            "eventId": self.event_id,
            "actorId": self.actor_id,
            "actorKind": self.actor_kind,
            "confidence": self.confidence,
        }


def _validate_source_ref(item: Any) -> None:
    if not isinstance(item, SourceRef):
        raise TypeError("provenance entries must be SourceRef instances")
    _require_nonempty_string("SourceRef.source_id", item.source_id)
    _require_nonempty_string("SourceRef.event_id", item.event_id)
    _require_nonempty_string("SourceRef.actor_id", item.actor_id)
    _require_string("SourceRef.actor_kind", item.actor_kind)
    _require_choice("actor_kind", item.actor_kind, {"human", "agent"})
    _require_probability("SourceRef.confidence", item.confidence)


@dataclass(frozen=True)
class EdgeEvidence:
    """Typed directed interaction evidence before time decay."""

    source_id: str
    target_id: str
    layer: str
    polarity: str
    magnitude: float
    confidence: float
    basis: str
    object_id: str
    provenance: tuple[SourceRef, ...] = ()

    def __post_init__(self) -> None:
        provenance = _validate_edge_evidence(self)
        object.__setattr__(self, "provenance", provenance)

    def to_dict(self) -> dict[str, Any]:
        return {
            "sourceId": self.source_id,
            "targetId": self.target_id,
            "layer": self.layer,
            "polarity": self.polarity,
            "magnitude": self.magnitude,
            "confidence": self.confidence,
            "basis": self.basis,
            "objectId": self.object_id,
            "provenance": [item.to_dict() for item in self.provenance],
        }


def _validate_edge_evidence(
    item: Any,
) -> tuple[SourceRef, ...]:
    if not isinstance(item, EdgeEvidence):
        raise TypeError("relation entries must be EdgeEvidence")
    for name in ("source_id", "target_id", "object_id", "basis"):
        _require_nonempty_string(f"EdgeEvidence.{name}", getattr(item, name))
    _require_string("EdgeEvidence.layer", item.layer)
    _require_choice(
        "layer",
        item.layer,
        {
            "communication",
            "uptake",
            "stance",
            "coordination",
            "facilitation",
        },
    )
    _require_string("EdgeEvidence.polarity", item.polarity)
    _require_choice(
        "polarity",
        item.polarity,
        {"positive", "challenge", "uncertain"},
    )
    _require_nonnegative_number("EdgeEvidence.magnitude", item.magnitude)
    _require_probability("EdgeEvidence.confidence", item.confidence)
    provenance = tuple(item.provenance)
    for source in provenance:
        _validate_source_ref(source)
    return provenance


@runtime_checkable
class RelationExtractor(Protocol):
    """Protocol for adapters that emit explicit typed interaction evidence."""

    def extract(
        self,
        event: ChatEvent,
        context: Sequence[ChatEvent],
    ) -> Sequence[EdgeEvidence]:
        """Return typed relations with basis and provenance."""


@dataclass(frozen=True)
class SnaSnapshot:
    """JSON-compatible TRACE-AI network snapshot."""

    generated_at: float
    view: str
    nodes: tuple[dict[str, Any], ...]
    edges: tuple[dict[str, Any], ...]
    metrics: dict[str, Any]
    watermark: float | None = None
    requires_replay: tuple[str, ...] = ()
    audit: tuple[dict[str, Any], ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "generatedAt": self.generated_at,
            "view": self.view,
            "nodes": [dict(item) for item in self.nodes],
            "edges": [
                {
                    **item,
                    "channels": dict(item.get("channels", {})),
                    "evidenceIds": list(item.get("evidenceIds", ())),
                }
                for item in self.edges
            ],
            "metrics": {
                **self.metrics,
                "weightedInStrength": dict(
                    self.metrics.get("weightedInStrength", {})
                ),
                "weightedOutStrength": dict(
                    self.metrics.get("weightedOutStrength", {})
                ),
            },
            "watermark": self.watermark,
            "requiresReplay": list(self.requires_replay),
            "audit": [dict(item) for item in self.audit],
        }


@dataclass
class _NetworkContribution:
    contribution_id: str
    event_id: str
    revision: int
    event_time: float
    source_id: str
    target_id: str
    layer: str
    polarity: str
    magnitude: float
    confidence: float
    basis: str
    object_id: str
    provenance: tuple[SourceRef, ...]
    active: bool = True


@dataclass(frozen=True)
class _NetworkInput:
    event: ChatEvent
    evidence: tuple[EdgeEvidence, ...]
    sources: tuple[SourceRef, ...]
    context: tuple[ChatEvent, ...] | None
    derive_event_relations: bool


class StreamingInteractionNetwork:
    """TRACE-AI reference for typed, decayed interaction evidence.

    Demo defaults are ten minutes for communication and sixty minutes for
    uptake, stance, coordination, and facilitation.  Snapshot metrics are
    bounded streaming summaries.  Slow global metrics such as PageRank are
    intentionally not implemented and are not claimed to be O(1).
    """

    ROOM = "ROOM"
    _layers = (
        "communication",
        "uptake",
        "stance",
        "coordination",
        "facilitation",
    )

    def __init__(
        self,
        relation_extractor: RelationExtractor | None = None,
        *,
        allowed_lateness: float = 5.0,
        half_lives: dict[str, float] | None = None,
    ) -> None:
        if not math.isfinite(allowed_lateness) or allowed_lateness < 0.0:
            raise ValueError("allowed_lateness must be non-negative")
        defaults = {
            "communication": 10.0 * 60.0,
            "uptake": 60.0 * 60.0,
            "stance": 60.0 * 60.0,
            "coordination": 60.0 * 60.0,
            "facilitation": 60.0 * 60.0,
        }
        if half_lives:
            defaults.update(half_lives)
        if any(
            not math.isfinite(value) or value <= 0.0
            for value in defaults.values()
        ):
            raise ValueError("all half lives must be positive")
        self.relation_extractor = relation_extractor
        self.allowed_lateness = float(allowed_lateness)
        self.half_lives = defaults
        self._history: list[_NetworkInput] = []
        self._reset_runtime()

    def _reset_runtime(self) -> None:
        self.event_ledger: dict[str, list[_EventLedgerEntry]] = {}
        self.per_event_deltas: dict[str, tuple[str, ...]] = {}
        self._contributions: dict[str, _NetworkContribution] = {}
        self._active_events: dict[str, ChatEvent] = {}
        self._actor_kinds: dict[str, str] = {}
        self._agent_roles: dict[str, str | None] = {}
        self._summary_sources: dict[str, tuple[SourceRef, ...]] = {}
        self._seen: set[tuple[str, int, str]] = set()
        self._requires_replay: list[str] = []
        self._audit: list[dict[str, Any]] = []
        self.watermark: float | None = None

    @property
    def requires_replay(self) -> tuple[str, ...]:
        return tuple(self._requires_replay)

    @staticmethod
    def _event_key(event: ChatEvent) -> tuple[str, int, str]:
        return (event.event_id, event.revision, event.operation)

    def _patch(
        self,
        event: ChatEvent,
        *,
        added_nodes: Sequence[str] = (),
        added_edges: Sequence[str] = (),
        removed_edges: Sequence[str] = (),
        duplicate: bool = False,
        requires_replay: bool = False,
        accepted: bool = True,
        reason: str | None = None,
    ) -> MapPatch:
        added = tuple(sorted(set(added_edges)))
        removed = tuple(sorted(set(removed_edges)))
        patch_id = _stable_id(
            "sna",
            event.event_id,
            event.revision,
            event.operation,
            added,
            removed,
            duplicate,
            requires_replay,
            accepted,
            reason,
        )
        return MapPatch(
            patch_id=patch_id,
            event_id=event.event_id,
            operation=event.operation,
            added_nodes=tuple(sorted(set(added_nodes))),
            added_edges=added,
            removed_edges=removed,
            duplicate=duplicate,
            requires_replay=requires_replay,
            accepted=accepted,
            reason=reason,
        )

    def _is_too_late(self, event_time: float) -> bool:
        if self.watermark is None:
            return False
        return event_time < self.watermark - self.allowed_lateness

    def _ledger(
        self,
        event: ChatEvent,
        *,
        active: bool,
        requires_replay: bool = False,
    ) -> None:
        entry = _EventLedgerEntry(
            event=event,
            active=active,
            requires_replay=requires_replay,
        )
        self.event_ledger.setdefault(event.event_id, []).append(entry)

    def _edge_id(self, item: _NetworkContribution) -> str:
        return _stable_id(
            "sna-edge",
            item.source_id,
            item.target_id,
            item.layer,
        )

    def _deactivate(self, event_id: str) -> tuple[str, ...]:
        removed: set[str] = set()
        for entry in self.event_ledger.get(event_id, ()):
            entry.active = False
        for item in self._contributions.values():
            if item.event_id == event_id and item.active:
                item.active = False
                removed.add(self._edge_id(item))
        self._active_events.pop(event_id, None)
        self._summary_sources.pop(event_id, None)
        return tuple(sorted(removed))

    @staticmethod
    def _uptake_language(text: str) -> bool:
        return bool(
            re.search(
                r"(?:building on|build on|agree|because|based on|"
                r"延續|接著|承接|同意|因為|根據|補充)",
                text,
                re.IGNORECASE,
            )
        )

    def _reply_source(
        self,
        event: ChatEvent,
        active_events: dict[str, ChatEvent] | None = None,
    ) -> ChatEvent | None:
        if not event.reply_to:
            return None
        events = self._active_events if active_events is None else active_events
        return events.get(event.reply_to)

    def _derive_event_evidence(
        self,
        event: ChatEvent,
        active_events: dict[str, ChatEvent] | None = None,
        summary_sources: dict[str, tuple[SourceRef, ...]] | None = None,
    ) -> list[EdgeEvidence]:
        evidence: list[EdgeEvidence] = []
        parent = self._reply_source(event, active_events)
        targets: dict[str, str] = {}
        if parent is not None:
            targets[parent.actor_id] = "reply"
        for mention in event.mentions:
            targets.setdefault(mention, "mention")
        if targets:
            share = 1.0 / len(targets)
            for target_id in sorted(targets):
                evidence.append(
                    EdgeEvidence(
                        source_id=event.actor_id,
                        target_id=target_id,
                        layer="communication",
                        polarity="positive",
                        magnitude=share,
                        confidence=event.source_confidence,
                        basis=targets[target_id],
                        object_id=event.event_id,
                    )
                )
        else:
            evidence.append(
                EdgeEvidence(
                    source_id=event.actor_id,
                    target_id=self.ROOM,
                    layer="communication",
                    polarity="positive",
                    magnitude=1.0,
                    confidence=event.source_confidence,
                    basis="broadcast",
                    object_id=event.event_id,
                )
            )
        if parent is None or not self._uptake_language(event.text):
            return evidence
        if parent.actor_kind == "agent":
            lineage = (
                self._summary_sources
                if summary_sources is None
                else summary_sources
            )
            provenance = lineage.get(parent.event_id, ())
        else:
            provenance = (
                SourceRef(
                    source_id=f"source:{parent.event_id}",
                    event_id=parent.event_id,
                    actor_id=parent.actor_id,
                    actor_kind=parent.actor_kind,
                    confidence=parent.source_confidence,
                ),
            )
        evidence.append(
            EdgeEvidence(
                source_id=parent.actor_id,
                target_id=event.actor_id,
                layer="uptake",
                polarity="positive",
                magnitude=1.0,
                confidence=event.source_confidence,
                basis="semantic_uptake",
                object_id=parent.event_id,
                provenance=provenance,
            )
        )
        if parent.actor_kind == "agent" and parent.agent_role == "summary":
            evidence.append(
                EdgeEvidence(
                    source_id=parent.actor_id,
                    target_id=event.actor_id,
                    layer="facilitation",
                    polarity="positive",
                    magnitude=1.0,
                    confidence=event.source_confidence,
                    basis="summary_facilitation",
                    object_id=parent.event_id,
                    provenance=provenance,
                )
            )
        return evidence

    def _normalize_evidence(
        self,
        event: ChatEvent,
        items: Sequence[EdgeEvidence],
    ) -> tuple[tuple[EdgeEvidence, ...], tuple[dict[str, Any], ...]]:
        for item in items:
            _validate_edge_evidence(item)
        totals: dict[tuple[str, str], float] = defaultdict(float)
        for item in items:
            totals[(item.source_id, item.layer)] += item.magnitude
        normalized: list[EdgeEvidence] = []
        staged_audit: list[dict[str, Any]] = []
        for item in items:
            if item.source_id == item.target_id:
                staged_audit.append(
                    {
                        "code": "self_loop_excluded",
                        "eventId": event.event_id,
                        "sourceId": item.source_id,
                        "targetId": item.target_id,
                        "layer": item.layer,
                    }
                )
                continue
            total = totals[(item.source_id, item.layer)]
            scale = 1.0 / total if total > 1.0 else 1.0
            normalized.append(
                EdgeEvidence(
                    source_id=item.source_id,
                    target_id=item.target_id,
                    layer=item.layer,
                    polarity=item.polarity,
                    magnitude=item.magnitude * scale,
                    confidence=item.confidence,
                    basis=item.basis,
                    object_id=item.object_id,
                    provenance=item.provenance,
                )
            )
        return tuple(normalized), tuple(staged_audit)

    def _summary_sources_for_event(
        self,
        event: ChatEvent,
        sources: Sequence[SourceRef],
        active_events: dict[str, ChatEvent],
    ) -> tuple[SourceRef, ...] | None:
        if event.actor_kind != "agent" or event.agent_role != "summary":
            return None
        gathered = list(sources)
        parent = self._reply_source(event, active_events)
        if parent is not None and parent.actor_kind == "human":
            gathered.append(
                SourceRef(
                    source_id=f"source:{parent.event_id}",
                    event_id=parent.event_id,
                    actor_id=parent.actor_id,
                    actor_kind="human",
                    confidence=parent.source_confidence,
                )
            )
        unique: dict[tuple[str, str], SourceRef] = {}
        for source in gathered:
            key = (source.event_id, source.actor_id)
            current = unique.get(key)
            if current is None or source.confidence > current.confidence:
                unique[key] = source
        return tuple(unique[key] for key in sorted(unique))

    def apply(
        self,
        event: ChatEvent,
        *,
        evidence: Sequence[EdgeEvidence] = (),
        sources: Sequence[SourceRef] = (),
        context: Sequence[ChatEvent] | None = None,
        derive_event_relations: bool = True,
        _record_history: bool = True,
    ) -> MapPatch:
        """Apply one event and its optional already-extracted relations."""
        key = self._event_key(event)
        if key in self._seen:
            return self._patch(event, duplicate=True, reason="duplicate")
        evidence_tuple = tuple(evidence)
        sources_tuple = tuple(sources)
        event_time = _seconds(event.event_time)

        def commit_identity(
            history_context: tuple[ChatEvent, ...] | None,
        ) -> None:
            self._seen.add(key)
            if _record_history:
                self._history.append(
                    _NetworkInput(
                        event,
                        evidence_tuple,
                        sources_tuple,
                        history_context,
                        derive_event_relations,
                    )
                )

        if self._is_too_late(event_time):
            supplied_context = None if context is None else tuple(context)
            commit_identity(supplied_context)
            self._ledger(event, active=False, requires_replay=True)
            if event.event_id not in self._requires_replay:
                self._requires_replay.append(event.event_id)
            return self._patch(
                event,
                requires_replay=True,
                accepted=False,
                reason="beyond_allowed_lateness",
            )

        target = event.retracts or event.supersedes or event.event_id
        deactivate_target = event.operation in {
            "revise",
            "delete",
            "retract",
        }
        prospective_active = dict(self._active_events)
        if deactivate_target:
            prospective_active.pop(target, None)
        elif event.event_id in self.event_ledger:
            active_entries = [
                item
                for item in self.event_ledger[event.event_id]
                if item.active
            ]
            if active_entries:
                highest = max(item.event.revision for item in active_entries)
                if event.revision <= highest:
                    stale_context = (
                        tuple(prospective_active.values())
                        if context is None
                        else tuple(context)
                    )
                    commit_identity(stale_context)
                    if self.watermark is None or event_time > self.watermark:
                        self.watermark = event_time
                    return self._patch(
                        event,
                        duplicate=True,
                        reason="stale_revision",
                    )
                deactivate_target = True
                prospective_active.pop(event.event_id, None)
        if event.operation in {"delete", "retract"}:
            control_context = (
                tuple(prospective_active.values())
                if context is None
                else tuple(context)
            )
            commit_identity(control_context)
            if self.watermark is None or event_time > self.watermark:
                self.watermark = event_time
            removed = self._deactivate(target)
            self._ledger(event, active=False)
            return self._patch(
                event,
                removed_edges=removed,
                reason="retracted",
            )

        relation_context = (
            tuple(prospective_active.values())
            if context is None
            else tuple(context)
        )
        derived: list[EdgeEvidence] = []
        if derive_event_relations:
            derived.extend(
                self._derive_event_evidence(
                    event,
                    prospective_active,
                    self._summary_sources,
                )
            )
            if self.relation_extractor is not None:
                derived.extend(
                    self.relation_extractor.extract(event, relation_context)
                )
        derived.extend(evidence_tuple)
        normalized, staged_audit = self._normalize_evidence(event, derived)
        staged_summary_sources = self._summary_sources_for_event(
            event,
            sources_tuple,
            prospective_active,
        )
        staged: list[_NetworkContribution] = []
        contribution_ids: list[str] = []
        edge_ids: list[str] = []
        for index, item in enumerate(normalized):
            contribution_id = _stable_id(
                "nc",
                event.event_id,
                event.revision,
                index,
                item.source_id,
                item.target_id,
                item.layer,
                item.polarity,
                item.object_id,
            )
            contribution = _NetworkContribution(
                contribution_id=contribution_id,
                event_id=event.event_id,
                revision=event.revision,
                event_time=event_time,
                source_id=item.source_id,
                target_id=item.target_id,
                layer=item.layer,
                polarity=item.polarity,
                magnitude=item.magnitude,
                confidence=item.confidence,
                basis=item.basis,
                object_id=item.object_id,
                provenance=item.provenance,
            )
            staged.append(contribution)
            contribution_ids.append(contribution_id)
            edge_ids.append(self._edge_id(contribution))

        commit_identity(relation_context)
        if self.watermark is None or event_time > self.watermark:
            self.watermark = event_time
        removed: tuple[str, ...] = ()
        if deactivate_target:
            removed = self._deactivate(target)
        for audit in staged_audit:
            if audit not in self._audit:
                self._audit.append(audit)
        if staged_summary_sources is not None:
            self._summary_sources[event.event_id] = staged_summary_sources
        for contribution in staged:
            self._contributions[contribution.contribution_id] = contribution
        self.per_event_deltas[
            f"{event.event_id}:{event.revision}"
        ] = tuple(sorted(contribution_ids))
        self._active_events[event.event_id] = event
        self._actor_kinds[event.actor_id] = event.actor_kind
        self._agent_roles[event.actor_id] = event.agent_role
        self._ledger(event, active=True)
        return self._patch(
            event,
            added_nodes=(event.actor_id,),
            added_edges=edge_ids,
            removed_edges=removed,
            reason="applied",
        )

    def _virtual_rows(
        self,
        now: float,
        view: str,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        rows: list[dict[str, Any]] = []
        projection_audit: list[dict[str, Any]] = []
        for item in self._contributions.values():
            if not item.active:
                continue
            source_kind = self._actor_kinds.get(item.source_id)
            target_kind = self._actor_kinds.get(item.target_id)
            if view == "human_only" and (
                source_kind == "agent" or target_kind == "agent"
            ):
                continue
            age = max(0.0, now - item.event_time)
            half_life = self.half_lives[item.layer]
            weight = (
                item.magnitude
                * item.confidence
                * math.pow(2.0, -age / half_life)
            )
            human_sources = {
                source.actor_id: source
                for source in item.provenance
                if source.actor_kind == "human"
            }
            adjusts_lineage = (
                view == "lineage_adjusted"
                and item.layer == "uptake"
                and source_kind == "agent"
                and human_sources
            )
            if adjusts_lineage:
                count = len(human_sources)
                for actor_id in sorted(human_sources):
                    source = human_sources[actor_id]
                    if actor_id == item.target_id:
                        audit = {
                            "code": "lineage_self_loop",
                            "eventId": item.event_id,
                            "contributionId": item.contribution_id,
                            "sourceId": actor_id,
                            "targetId": item.target_id,
                            "layer": item.layer,
                        }
                        if audit not in projection_audit:
                            projection_audit.append(audit)
                        continue
                    rows.append(
                        {
                            "sourceId": actor_id,
                            "targetId": item.target_id,
                            "layer": item.layer,
                            "polarity": item.polarity,
                            "weight": weight * source.confidence / count,
                            "eventId": item.event_id,
                            "objectId": item.object_id,
                            "contributionId": item.contribution_id,
                        }
                    )
                continue
            rows.append(
                {
                    "sourceId": item.source_id,
                    "targetId": item.target_id,
                    "layer": item.layer,
                    "polarity": item.polarity,
                    "weight": weight,
                    "eventId": item.event_id,
                    "objectId": item.object_id,
                    "contributionId": item.contribution_id,
                }
            )
        return rows, projection_audit

    @staticmethod
    def _aggregate_rows(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
        grouped: dict[tuple[str, str, str], dict[str, Any]] = {}
        for row in rows:
            key = (row["sourceId"], row["targetId"], row["layer"])
            record = grouped.setdefault(
                key,
                {
                    "channels": {
                        "positive": 0.0,
                        "challenge": 0.0,
                        "uncertain": 0.0,
                    },
                    "evidence": set(),
                },
            )
            record["channels"][row["polarity"]] += row["weight"]
            record["evidence"].add(row["objectId"])
        edges: list[dict[str, Any]] = []
        for key in sorted(grouped):
            source_id, target_id, layer = key
            record = grouped[key]
            channels = {
                name: round(value, 12)
                for name, value in record["channels"].items()
            }
            edges.append(
                {
                    "edgeId": _stable_id("sna-edge", *key),
                    "sourceId": source_id,
                    "targetId": target_id,
                    "layer": layer,
                    "channels": channels,
                    "weight": round(sum(channels.values()), 12),
                    "evidenceIds": sorted(record["evidence"]),
                }
            )
        return edges

    def _active_turns(self, view: str) -> list[ChatEvent]:
        turns = [
            entry.event
            for entries in self.event_ledger.values()
            for entry in entries
            if entry.active
        ]
        if view == "human_only":
            turns = [item for item in turns if item.actor_kind == "human"]
        return turns

    def _metrics(
        self,
        edges: Sequence[dict[str, Any]],
        rows: Sequence[dict[str, Any]],
        view: str,
    ) -> dict[str, Any]:
        in_strength: dict[str, float] = defaultdict(float)
        out_strength: dict[str, float] = defaultdict(float)
        pair_weights: dict[tuple[str, str], float] = defaultdict(float)
        for edge in edges:
            weight = float(edge["weight"])
            source_id = edge["sourceId"]
            target_id = edge["targetId"]
            out_strength[source_id] += weight
            in_strength[target_id] += weight
            if target_id != self.ROOM and source_id != target_id:
                pair_weights[(source_id, target_id)] += weight
        denominator = sum(pair_weights.values())
        reciprocal = sum(
            min(weight, pair_weights.get((target, source), 0.0))
            for (source, target), weight in pair_weights.items()
        )
        reciprocity = reciprocal / denominator if denominator else 0.0

        turns = self._active_turns(view)
        counts = Counter(item.actor_id for item in turns)
        total_turns = sum(counts.values())
        if len(counts) <= 1:
            balance = 1.0
        else:
            entropy = -sum(
                (count / total_turns) * math.log(count / total_turns)
                for count in counts.values()
            )
            balance = entropy / math.log(len(counts))
        agent_turns = sum(
            count
            for actor_id, count in counts.items()
            if self._actor_kinds.get(actor_id) == "agent"
        )
        human_turns = sum(
            count
            for actor_id, count in counts.items()
            if self._actor_kinds.get(actor_id) == "human"
        )
        agent_share = agent_turns / total_turns if total_turns else 0.0
        human_share = human_turns / total_turns if total_turns else 0.0
        semantic_events = {
            row["eventId"] for row in rows if row["layer"] != "communication"
        }
        active_event_ids = {item.event_id for item in turns}
        covered = len(semantic_events & active_event_ids)
        semantic_coverage = covered / total_turns if total_turns else 0.0
        return {
            "weightedInStrength": {
                key: round(value, 12)
                for key, value in sorted(in_strength.items())
            },
            "weightedOutStrength": {
                key: round(value, 12)
                for key, value in sorted(out_strength.items())
            },
            "participationBalance": round(balance, 12),
            "weightedReciprocity": round(reciprocity, 12),
            "agentShare": round(agent_share, 12),
            "humanOnlyShare": round(human_share, 12),
            "semanticCoverage": round(semantic_coverage, 12),
        }

    def snapshot(
        self,
        now: TimeValue | None = None,
        *,
        view: str = "observed",
    ) -> SnaSnapshot:
        """Return observed, human-only, or provenance-adjusted evidence."""
        _require_choice(
            "view",
            view,
            {"observed", "human_only", "lineage_adjusted"},
        )
        when = self.watermark or 0.0 if now is None else _seconds(now)
        rows, projection_audit = self._virtual_rows(float(when), view)
        edges = self._aggregate_rows(rows)
        turns = self._active_turns(view)
        node_ids = {item.actor_id for item in turns}
        for edge in edges:
            node_ids.update((edge["sourceId"], edge["targetId"]))
        nodes: list[dict[str, Any]] = []
        for node_id in sorted(node_ids):
            kind = (
                "room"
                if node_id == self.ROOM
                else self._actor_kinds.get(node_id, "human")
            )
            node = {
                "nodeId": node_id,
                "actorKind": kind,
                "agentRole": self._agent_roles.get(node_id),
            }
            node.update(StreamingConceptMap._position(node_id))
            nodes.append(node)
        snapshot_audit = [dict(item) for item in self._audit]
        for item in projection_audit:
            if item not in snapshot_audit:
                snapshot_audit.append(dict(item))
        return SnaSnapshot(
            generated_at=float(when),
            view=view,
            nodes=tuple(nodes),
            edges=tuple(edges),
            metrics=self._metrics(edges, rows, view),
            watermark=self.watermark,
            requires_replay=tuple(self._requires_replay),
            audit=tuple(snapshot_audit),
        )

    def replay(
        self,
        inputs: Sequence[_NetworkInput] | None = None,
        *,
        now: TimeValue | None = None,
        view: str = "observed",
    ) -> SnaSnapshot:
        """Rebuild in recorded causal order without a lateness cutoff.

        Event time still controls decay.  Arrival order is retained because
        explicit replies and extractor context are causal observations; sorting
        an accepted child ahead of its already-seen parent would change them.
        """
        history = list(self._history if inputs is None else inputs)
        if inputs is not None:
            self._history = list(inputs)
        self._reset_runtime()
        lateness = self.allowed_lateness
        self.allowed_lateness = math.inf
        try:
            for item in history:
                self.apply(
                    item.event,
                    evidence=item.evidence,
                    sources=item.sources,
                    context=item.context,
                    derive_event_relations=item.derive_event_relations,
                    _record_history=False,
                )
        finally:
            self.allowed_lateness = lateness
        return self.snapshot(now=now, view=view)


class _PreExtractedPropositionExtractor:
    """O(1) fixture lookup used to keep the benchmark post-extraction."""

    def __init__(
        self,
        values: dict[str, tuple[CandidateProposition, ...]],
    ) -> None:
        self.values = values

    def extract(
        self,
        event: ChatEvent,
        context: Sequence[ChatEvent],
    ) -> tuple[CandidateProposition, ...]:
        del context
        return self.values.get(event.event_id, ())


def _demo_event(
    event_id: str,
    actor_id: str,
    text: str,
    event_time: float,
    *,
    actor_kind: str = "human",
    reply_to: str | None = None,
    mentions: tuple[str, ...] = (),
    agent_role: str | None = None,
) -> ChatEvent:
    return ChatEvent(
        event_id=event_id,
        session_id="learning-orbit-demo",
        event_time=event_time,
        ingest_time=event_time,
        actor_id=actor_id,
        actor_kind=actor_kind,
        modality="text",
        text=text,
        reply_to=reply_to,
        mentions=mentions,
        agent_role=agent_role,
    )


def run_sample() -> dict[str, Any]:
    """Run a compact deterministic example suitable for direct execution."""
    echo = StreamingConceptMap()
    echo.apply(
        _demo_event(
            "concept-1",
            "human-1",
            "The Sun provides energy to producers.",
            0.0,
        )
    )
    echo.apply(
        _demo_event(
            "concept-2",
            "human-2",
            "我不同意太陽為生產者提供能量。",
            0.0,
        )
    )

    trace = StreamingInteractionNetwork()
    original = _demo_event(
        "turn-1",
        "human-1",
        "Original ecosystem idea.",
        0.0,
    )
    summary = _demo_event(
        "turn-2",
        "agent-1",
        "Summary of the ecosystem idea.",
        1.0,
        actor_kind="agent",
        reply_to="turn-1",
        agent_role="summary",
    )
    uptake = _demo_event(
        "turn-3",
        "human-2",
        "Building on the summary, decomposers return nutrients to soil.",
        2.0,
        reply_to="turn-2",
    )
    trace.apply(original)
    trace.apply(
        summary,
        sources=(
            SourceRef(
                source_id="sample-source-1",
                event_id="turn-1",
                actor_id="human-1",
            ),
        ),
    )
    trace.apply(uptake)
    return {
        "referenceVersion": REFERENCE_VERSION,
        "scope": {
            "extractorClaim": "deterministic fixture, not NLP",
            "networkClaim": "typed evidence; no latent-trait inference",
        },
        "echoCm": echo.snapshot(now=2.0),
        "traceAi": {
            "observed": trace.snapshot(
                now=2.0,
                view="observed",
            ).to_dict(),
            "humanOnly": trace.snapshot(
                now=2.0,
                view="human_only",
            ).to_dict(),
            "lineageAdjusted": trace.snapshot(
                now=2.0,
                view="lineage_adjusted",
            ).to_dict(),
        },
    }


def _percentiles(values: Sequence[float]) -> dict[str, float]:
    ordered = sorted(values)
    if not ordered:
        return {"p50": 0.0, "p95": 0.0}

    def nearest_rank(fraction: float) -> float:
        index = max(0, math.ceil(fraction * len(ordered)) - 1)
        return ordered[index]

    return {
        "p50": round(nearest_rank(0.50), 6),
        "p95": round(nearest_rank(0.95), 6),
    }


def _elapsed_ms(start_ns: int) -> float:
    return (time.perf_counter_ns() - start_ns) / 1_000_000.0


def run_benchmark(event_count: int = 200) -> dict[str, Any]:
    """Benchmark 100--500 post-extraction synthetic events.

    Candidate propositions and typed edge evidence are constructed before the
    timer starts.  The measurements therefore exclude LLM, ASR, OCR, and all
    network access; they cover state application and snapshot materialization.
    """
    if not 100 <= event_count <= 500:
        raise ValueError("event_count must be between 100 and 500")

    echo_events: list[ChatEvent] = []
    extracted: dict[str, tuple[CandidateProposition, ...]] = {}
    trace_inputs: list[tuple[ChatEvent, tuple[EdgeEvidence, ...]]] = []
    for index in range(event_count):
        event_id = f"benchmark-{index:04d}"
        actor_id = f"human-{index % 8}"
        target_id = f"human-{(index + 1) % 8}"
        item = _demo_event(
            event_id,
            actor_id,
            "Pre-extracted synthetic event.",
            float(index),
            mentions=(target_id,),
        )
        ref = EvidenceRef(
            evidence_id=f"benchmark-evidence-{index:04d}",
            event_id=event_id,
            text="pre-extracted fixture",
        )
        candidate = CandidateProposition(
            head=f"concept-{index % 16}",
            link_phrase="relates to",
            tail=f"concept-{(index + 1) % 16}",
            relation_family="synthetic",
            stance="support" if index % 5 else "uncertain",
            confidence=0.9,
            evidence=(ref,),
        )
        communication = EdgeEvidence(
            source_id=actor_id,
            target_id=target_id,
            layer="communication",
            polarity="positive",
            magnitude=1.0,
            confidence=1.0,
            basis="pre_extracted_fixture",
            object_id=event_id,
        )
        relation = EdgeEvidence(
            source_id=actor_id,
            target_id=target_id,
            layer="uptake",
            polarity="positive",
            magnitude=1.0,
            confidence=0.9,
            basis="pre_extracted_fixture",
            object_id=f"idea-{index:04d}",
        )
        echo_events.append(item)
        extracted[event_id] = (candidate,)
        trace_inputs.append((item, (communication, relation)))

    echo = StreamingConceptMap(
        extractor=_PreExtractedPropositionExtractor(extracted),
        allowed_lateness=5.0,
    )
    trace = StreamingInteractionNetwork(allowed_lateness=5.0)
    echo_apply: list[float] = []
    trace_apply: list[float] = []
    for item in echo_events:
        started = time.perf_counter_ns()
        echo.apply(item)
        echo_apply.append(_elapsed_ms(started))
    for item, evidence in trace_inputs:
        started = time.perf_counter_ns()
        trace.apply(
            item,
            evidence=evidence,
            derive_event_relations=False,
        )
        trace_apply.append(_elapsed_ms(started))

    echo_snapshot: list[float] = []
    trace_snapshot: list[float] = []
    benchmark_now = float(event_count - 1)
    for _ in range(20):
        started = time.perf_counter_ns()
        echo.snapshot(now=benchmark_now)
        echo_snapshot.append(_elapsed_ms(started))
        started = time.perf_counter_ns()
        trace.snapshot(now=benchmark_now)
        trace_snapshot.append(_elapsed_ms(started))

    return {
        "eventCount": event_count,
        "scope": "post-extraction only",
        "excluded": ["LLM", "ASR", "OCR", "network"],
        "clock": "time.perf_counter_ns",
        "echoCm": {
            "applyMs": _percentiles(echo_apply),
            "snapshotMs": _percentiles(echo_snapshot),
        },
        "traceAi": {
            "applyMs": _percentiles(trace_apply),
            "snapshotMs": _percentiles(trace_snapshot),
        },
    }


if __name__ == "__main__":
    output = {
        "sample": run_sample(),
        "benchmark": run_benchmark(),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True))
