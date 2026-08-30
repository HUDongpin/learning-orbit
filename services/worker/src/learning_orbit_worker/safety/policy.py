"""Fail-closed, explainable output policy for Socratic shadow drafts."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True, slots=True)
class SafetyDecision:
    action: Literal["allow", "warn", "hold", "redact"]
    policy_version: str
    reason_codes: tuple[str, ...]


_BLOCK_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("排名", ("FORBIDDEN_PERSONAL_INFERENCE",)),
    ("心理风险", ("FORBIDDEN_PERSONAL_INFERENCE",)),
    ("心理風險", ("FORBIDDEN_PERSONAL_INFERENCE",)),
    ("system prompt", ("PROMPT_EXFILTRATION",)),
    ("系統指令", ("PROMPT_EXFILTRATION",)),
)
_WARN_PATTERNS: tuple[tuple[str, str], ...] = (
    ("一定是", "UNSUPPORTED_CERTAINTY"),
    ("肯定是", "UNSUPPORTED_CERTAINTY"),
)


def evaluate_agent_output(text: str, *, policy_version: str = "socratic-policy-v1") -> SafetyDecision:
    if not isinstance(text, str) or not text.strip():
        return SafetyDecision("hold", policy_version, ("EMPTY_OUTPUT",))
    reasons: set[str] = set()
    for needle, codes in _BLOCK_PATTERNS:
        if needle.casefold() in text.casefold():
            reasons.update(codes)
    if reasons:
        return SafetyDecision("hold", policy_version, tuple(sorted(reasons)))
    for needle, code in _WARN_PATTERNS:
        if needle in text:
            reasons.add(code)
    return SafetyDecision("warn" if reasons else "allow", policy_version, tuple(sorted(reasons)))
