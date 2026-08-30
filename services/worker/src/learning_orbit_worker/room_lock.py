"""Canonical room advisory/session locks shared with the Node service."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, TypeVar
import re

T = TypeVar("T")
_ROOT = Path(__file__).resolve().parents[4]
_SQL = _ROOT / "apps" / "server" / "src" / "db" / "sql"
LOCK_ROOM_XACT_SQL = (_SQL / "lock_room_xact.sql").read_text(encoding="utf-8")
LOCK_ROOM_SESSION_SQL = (_SQL / "lock_room_session.sql").read_text(encoding="utf-8")
UNLOCK_ROOM_SESSION_SQL = (_SQL / "unlock_room_session.sql").read_text(encoding="utf-8")


def _run(connection: Any, sql: str, room_id: str) -> Any:
    # Canonical SQL accepts exactly one UUID parameter.  Keeping this helper
    # deliberately boring prevents a second UUID→advisory-key implementation.
    return connection.execute(re.sub(r"\$[0-9]+", "%s", sql), (room_id,))


def lock_room_in_transaction(connection: Any, room_id: str) -> None:
    _run(connection, LOCK_ROOM_XACT_SQL, room_id)


def acquire_room_session(connection: Any, room_id: str) -> None:
    _run(connection, LOCK_ROOM_SESSION_SQL, room_id)


def release_room_session(connection: Any, room_id: str) -> None:
    cursor = _run(connection, UNLOCK_ROOM_SESSION_SQL, room_id)
    row = cursor.fetchone()
    unlocked = row[0] if row and not isinstance(row, dict) else (row or {}).get("pg_advisory_unlock")
    if unlocked is not True:
        raise RuntimeError("ROOM_SESSION_UNLOCK_FAILED")


def with_room_session_lock(
    pool: Any,
    room_id: str,
    work: Callable[[Any], T],
) -> T:
    """Acquire a dedicated connection-level room lock and always release it."""

    connection = pool.connection() if hasattr(pool, "connection") else pool.connect()
    poison = False
    callback_error: BaseException | None = None
    result: T | None = None
    acquired = False
    try:
        acquire_room_session(connection, room_id)
        acquired = True
        result = work(connection)
    except BaseException as error:  # preserve callback error until unlock runs
        callback_error = error
    finally:
        if acquired:
            try:
                release_room_session(connection, room_id)
            except BaseException as unlock_error:
                poison = True
                if callback_error is not None:
                    raise RuntimeError("ROOM_SESSION_LOCK_CALLBACK_AND_UNLOCK_FAILED") from unlock_error
                raise
        close = getattr(connection, "close", None)
        if poison and callable(close):
            close()
        else:
            putconn = getattr(pool, "putconn", None)
            if callable(putconn):
                putconn(connection)
            elif callable(close):
                close()
    if callback_error is not None:
        raise callback_error
    return result  # type: ignore[return-value]


__all__ = [
    "LOCK_ROOM_SESSION_SQL", "LOCK_ROOM_XACT_SQL", "UNLOCK_ROOM_SESSION_SQL",
    "acquire_room_session", "lock_room_in_transaction", "release_room_session",
    "with_room_session_lock",
]
