"""Malware scanning over ClamAV's INSTREAM protocol.

The protocol is four bytes of length followed by that many bytes, repeated,
then a zero-length chunk; clamd answers one line. Speaking it directly costs
about forty lines and adds nothing to a hash-pinned lock that handles
classroom uploads, which is the same trade this repository made for SigV4 and
for OTLP export.

Everything here fails closed. A scanner that cannot be reached, answers
something unrecognised, or is handed a file larger than its configured limit
produces "not clean" — never "probably fine". An unscannable upload stays
where it is; it does not become a file students can open.
"""
from __future__ import annotations

import socket
import struct
from dataclasses import dataclass
from typing import Callable, Iterable

#: clamd's own default StreamMaxLength is 25 MB, which is also the media size
#: ceiling in `media_asset`. A larger file is refused rather than truncated.
MAX_SCAN_BYTES = 25 * 1024 * 1024
CHUNK_BYTES = 64 * 1024
DEFAULT_TIMEOUT_SECONDS = 120.0


@dataclass(frozen=True, slots=True)
class ScanResult:
    clean: bool
    #: A bounded code, never clamd's raw line: a signature name is attacker
    #: controlled and would otherwise reach logs verbatim.
    code: str
    signature: str | None = None


class ScanUnavailable(RuntimeError):
    """The scanner could not answer. Retryable; never a pass."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _frames(data: bytes) -> Iterable[bytes]:
    for offset in range(0, len(data), CHUNK_BYTES):
        chunk = data[offset:offset + CHUNK_BYTES]
        yield struct.pack(">I", len(chunk)) + chunk
    yield struct.pack(">I", 0)


def interpret(line: str) -> ScanResult:
    """Turn one clamd response line into a bounded result.

    clamd says `stream: OK`, `stream: <Signature> FOUND`, or
    `stream: <reason> ERROR`. Anything else is a protocol this code does not
    understand, and not understanding the answer is not the same as a pass.
    """
    text = line.strip()
    if not text:
        raise ScanUnavailable("MEDIA_SCAN_EMPTY_RESPONSE")
    if text.endswith("OK") and "FOUND" not in text:
        return ScanResult(True, "MEDIA_SCAN_CLEAN")
    if text.endswith("FOUND"):
        body = text.split(":", 1)[1].strip() if ":" in text else text
        signature = body[: -len("FOUND")].strip() or None
        # The signature is recorded for an operator, but only as a bounded,
        # sanitized token.
        safe = None
        if signature:
            safe = "".join(ch for ch in signature if ch.isalnum() or ch in "._-")[:64] or None
        return ScanResult(False, "MEDIA_SCAN_INFECTED", safe)
    if text.endswith("ERROR"):
        raise ScanUnavailable("MEDIA_SCAN_ENGINE_ERROR")
    raise ScanUnavailable("MEDIA_SCAN_RESPONSE_UNRECOGNISED")


def _default_transport(host: str, port: int, timeout: float) -> Callable[[bytes], str]:
    def send(payload: bytes) -> str:
        with socket.create_connection((host, port), timeout=timeout) as connection:
            connection.settimeout(timeout)
            connection.sendall(b"zINSTREAM\0")
            connection.sendall(payload)
            received = bytearray()
            while len(received) < 4096:
                block = connection.recv(4096)
                if not block:
                    break
                received.extend(block)
                if b"\0" in block or block.endswith(b"\n"):
                    break
        return received.decode("utf-8", "replace").strip("\0\n ")
    return send


class ClamAvScanner:
    """Scan bytes, or say the scan did not happen."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 3310,
        *,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_bytes: int = MAX_SCAN_BYTES,
        transport: Callable[[bytes], str] | None = None,
    ) -> None:
        self.max_bytes = max_bytes
        self._send = transport or _default_transport(host, port, timeout_seconds)

    def scan(self, data: bytes) -> ScanResult:
        if len(data) > self.max_bytes:
            # Truncating to fit would scan something other than the file that
            # was uploaded, and report on it as though it were the file.
            raise ScanUnavailable("MEDIA_SCAN_TOO_LARGE")
        payload = b"".join(_frames(data))
        try:
            line = self._send(payload)
        except ScanUnavailable:
            raise
        except (TimeoutError, socket.timeout) as error:
            raise ScanUnavailable("MEDIA_SCAN_TIMEOUT") from error
        except OSError as error:
            raise ScanUnavailable("MEDIA_SCAN_UNREACHABLE") from error
        return interpret(line)
