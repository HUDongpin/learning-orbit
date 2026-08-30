"""Small closed-validation helpers used by generated Python ingress codecs."""
from __future__ import annotations

from datetime import datetime
from uuid import UUID


def fail(code: str) -> None:
    raise ValueError(code)


def uuid(value: object, code: str) -> str:
    if not isinstance(value, str):
        fail(code)
    try:
        UUID(value)
    except (ValueError, AttributeError):
        fail(code)
    return value


def integer(value: object, code: str, *, minimum: int | None = None) -> int:
    # bool is an int subclass, but is never a JSON Schema integer here.
    if isinstance(value, bool) or not isinstance(value, int):
        fail(code)
    if minimum is not None and value < minimum:
        fail(code)
    return value


def number(value: object, code: str, *, minimum: float | None = None, maximum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        fail(code)
    result = float(value)
    if minimum is not None and result < minimum or maximum is not None and result > maximum:
        fail(code)
    return result


def timestamp(value: object, code: str) -> str:
    if not isinstance(value, str):
        fail(code)
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail(code)
    return value


def exact_object(value: object, fields: set[str], code: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != fields:
        fail(code)
    return value


def optional_uuid(value: object, code: str) -> str | None:
    if value is None:
        return None
    return uuid(value, code)
