"""Ed25519 service assertions compatible with the TypeScript verifier."""

from __future__ import annotations

import base64
import json
import math
import os
import stat
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any, Mapping

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat, load_pem_private_key

MAX_DEPTH = 64
MAX_NODES = 10_000
MAX_BYTES = 1_048_576
MAX_STRING_LENGTH = 16_384


def _invalid() -> "NoReturn":
    raise ValueError("CANONICAL_JSON_INVALID")


def _validate(value: Any, depth: int = 0, state: list[int] | None = None, seen: set[int] | None = None) -> None:
    if state is None:
        state = [0]
    if seen is None:
        seen = set()
    state[0] += 1
    if depth > MAX_DEPTH or state[0] > MAX_NODES:
        _invalid()
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, str):
        if len(value) > MAX_STRING_LENGTH:
            _invalid()
        try:
            value.encode("utf-8", "strict")
        except UnicodeError:
            _invalid()
        return
    if isinstance(value, int):
        if value < -(2**53 - 1) or value > 2**53 - 1:
            _invalid()
        return
    if isinstance(value, float):
        # The cross-language contract intentionally permits integers only.
        if not math.isfinite(value) or value.is_integer() is False or value == 0.0 and math.copysign(1.0, value) < 0:
            _invalid()
        _invalid()
    if isinstance(value, list):
        marker = id(value)
        if marker in seen:
            _invalid()
        seen.add(marker)
        try:
            for item in value:
                _validate(item, depth + 1, state, seen)
        finally:
            seen.remove(marker)
        return
    if isinstance(value, dict):
        marker = id(value)
        if marker in seen:
            _invalid()
        seen.add(marker)
        try:
            for key, item in value.items():
                if not isinstance(key, str):
                    _invalid()
                if len(key) > MAX_STRING_LENGTH:
                    _invalid()
                try:
                    key.encode("utf-8", "strict")
                except UnicodeError:
                    _invalid()
                _validate(item, depth + 1, state, seen)
        finally:
            seen.remove(marker)
        return
    _invalid()


def canonical_json(value: Any) -> bytes:
    """Return deterministic UTF-8 JSON bytes (the same closed subset as Node)."""

    _validate(value)
    try:
        result = _serialize(value).encode("utf-8", "strict")
    except (TypeError, ValueError, UnicodeError):
        _invalid()
    if len(result) > MAX_BYTES:
        _invalid()
    return result


def _serialize(value: Any) -> str:
    if value is None or isinstance(value, (bool, int, str)):
        return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(_serialize(item) for item in value) + "]"
    if isinstance(value, dict):
        # ECMAScript Array#sort compares UTF-16 code units, while Python's
        # default ordering compares Unicode scalar values.  Encode keys as
        # UTF-16BE to keep supplementary-plane ordering cross-language.
        keys = sorted(value, key=lambda item: item.encode("utf-16-be", "surrogatepass"))
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False) + ":" + _serialize(value[key])
            for key in keys
        ) + "}"
    _invalid()


def parse_canonical_json(value: bytes | str) -> Any:
    raw = value.encode("utf-8") if isinstance(value, str) else bytes(value)
    if len(raw) > MAX_BYTES:
        _invalid()
    try:
        parsed = json.loads(raw.decode("utf-8"), parse_constant=lambda _: _invalid())
    except Exception as error:
        raise ValueError("CANONICAL_JSON_INVALID") from error
    if canonical_json(parsed) != raw:
        _invalid()
    return parsed


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    if not isinstance(value, str) or not value or any(ch not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for ch in value) or len(value) % 4 == 1:
        raise ValueError("SERVICE_ASSERTION_INVALID")
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if _b64(decoded) != value:
        raise ValueError("SERVICE_ASSERTION_INVALID")
    return decoded


def _rfc3339_millis(value: datetime) -> str:
    value = value.astimezone(timezone.utc)
    # JavaScript Date#toISOString always serializes exactly three fractional
    # digits; matching it keeps signed assertions byte-compatible.
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"


def load_private_ed25519_key(path: Path) -> Ed25519PrivateKey:
    """Load a non-symlink mode-0600 PEM Ed25519 key owned by this process."""

    if os.environ.get("LO_WORKER_ASSERTION_PRIVATE_KEY"):
        raise ValueError("SERVICE_ASSERTION_RAW_KEY_ENV_FORBIDDEN")
    path = Path(path)
    try:
        info = path.lstat()
    except OSError as error:
        raise ValueError("SERVICE_ASSERTION_KEY_FILE_INVALID") from error
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
        raise ValueError("SERVICE_ASSERTION_KEY_FILE_INVALID")
    try:
        key = load_pem_private_key(path.read_bytes(), password=None)
    except Exception as error:
        raise ValueError("SERVICE_ASSERTION_KEY_INVALID") from error
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("SERVICE_ASSERTION_KEY_INVALID")
    return key


def load_private_ed25519_key_from_owner_only_regular_file(path: Path) -> Ed25519PrivateKey:
    """Descriptive alias used by the implementation plan and adapters."""
    return load_private_ed25519_key(path)


@dataclass(frozen=True, slots=True)
class AssertionClock:
    def now(self) -> datetime:
        return datetime.now(timezone.utc)


class ServiceAssertionSigner:
    def __init__(self, issuer: str, key_id: str, private_key_file: Path, clock: Any | None = None) -> None:
        self.issuer = issuer
        self.key_id = key_id
        self.clock = clock or AssertionClock()
        if not issuer or not key_id:
            raise ValueError("SERVICE_ASSERTION_CONFIG_INVALID")
        self.key = load_private_ed25519_key(Path(private_key_file))

    @classmethod
    def from_key(cls, issuer: str, key_id: str, key: Ed25519PrivateKey, clock: Any | None = None) -> "ServiceAssertionSigner":
        obj = object.__new__(cls)
        obj.issuer, obj.key_id, obj.clock, obj.key = issuer, key_id, clock or AssertionClock(), key
        return obj

    def sign(self, audience: str, subject: str, body: Mapping[str, Any], lifetime_seconds: int = 60) -> str:
        if not isinstance(lifetime_seconds, int) or lifetime_seconds < 1 or lifetime_seconds > 60:
            raise ValueError("SERVICE_ASSERTION_LIFETIME_INVALID")
        now = self.clock.now().astimezone(timezone.utc)
        if now.tzinfo is None:
            raise ValueError("SERVICE_ASSERTION_CLOCK_INVALID")
        issued = _rfc3339_millis(now)
        expires = _rfc3339_millis(now + timedelta(seconds=lifetime_seconds))
        protected = {
            "alg": "Ed25519", "keyId": self.key_id, "issuer": self.issuer,
            "subject": subject, "audience": audience, "issuedAt": issued,
            "expiresAt": expires, "bodySha256": sha256(canonical_json(dict(body))).hexdigest(),
        }
        signature = self.key.sign(canonical_json(protected))
        envelope = {**protected, "signature": _b64(signature)}
        return _b64(canonical_json(envelope))

    def public_key_pem(self) -> bytes:
        return self.key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)


def verify_assertion(raw: str, body: Mapping[str, Any], public_key: Ed25519PublicKey, *, audience: str, subject: str, now: datetime, max_clock_skew_seconds: float = 0.0) -> None:
    try:
        if not isinstance(max_clock_skew_seconds, (int, float)) or not 0 <= max_clock_skew_seconds <= 5:
            raise ValueError
        parsed = parse_canonical_json(_unb64(raw))
        if not isinstance(parsed, dict) or set(parsed) != {"alg", "keyId", "issuer", "subject", "audience", "issuedAt", "expiresAt", "bodySha256", "signature"}:
            raise ValueError
        if parsed["alg"] != "Ed25519" or parsed["audience"] != audience or parsed["subject"] != subject:
            raise ValueError
        issued = datetime.fromisoformat(str(parsed["issuedAt"]).replace("Z", "+00:00"))
        expires = datetime.fromisoformat(str(parsed["expiresAt"]).replace("Z", "+00:00"))
        if expires - issued < timedelta(seconds=1) or expires - issued > timedelta(seconds=60):
            raise ValueError
        if issued - now > timedelta(seconds=max_clock_skew_seconds) or now - expires > timedelta(seconds=max_clock_skew_seconds):
            raise ValueError
        public_key.verify(_unb64(parsed["signature"]), canonical_json({key: parsed[key] for key in parsed if key != "signature"}))
        if sha256(canonical_json(dict(body))).hexdigest() != parsed["bodySha256"]:
            raise ValueError
    except Exception as error:
        raise ValueError("SERVICE_ASSERTION_INVALID") from error


__all__ = ["AssertionClock", "ServiceAssertionSigner", "canonical_json", "load_private_ed25519_key", "load_private_ed25519_key_from_owner_only_regular_file", "parse_canonical_json", "verify_assertion"]
