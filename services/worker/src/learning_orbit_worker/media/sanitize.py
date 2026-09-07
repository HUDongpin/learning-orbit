"""Strip identifying metadata from images without recompressing them.

A photo a student takes on a phone carries GPS coordinates, a device serial,
and a capture timestamp. None of that is part of what they meant to share, and
all of it survives every other step of the pipeline. Stripping it is the whole
job here.

It is done by dropping segments and chunks rather than by decoding and
re-encoding through an imaging library. Two reasons, and the second is the one
that matters:

* Re-encoding a JPEG loses quality every time. A student's photograph of their
  own work should not get visibly worse because the system had a privacy rule.
* Decoding attacker-supplied image data is one of the most reliably exploitable
  operations there is. This code never decodes pixels — it walks a length-
  prefixed structure, copies the parts that are needed to render, and drops the
  rest. A malformed file produces a refusal, not a decode.

What survives is what an image needs to look right: colour space, gamma,
transparency, physical dimensions. What does not survive is anything that
describes the camera, the place, or the time.
"""
from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass

JPEG_SOI = b"\xff\xd8"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

#: JPEG markers with no payload length, which are copied as-is.
_STANDALONE = {0xD8, 0xD9, *range(0xD0, 0xD8), 0x01}

#: APP1 is EXIF and XMP; APP2 can hold ICC, which is kept for colour accuracy.
#: APP13 is IPTC/Photoshop; COM is a free-text comment. All of those describe
#: the capture, not the picture.
_JPEG_DROP = {0xE1, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xEB,
              0xEC, 0xED, 0xEE, 0xEF, 0xFE}

#: PNG chunks worth keeping: the critical four plus what affects rendering.
_PNG_KEEP = {
    b"IHDR", b"PLTE", b"IDAT", b"IEND",
    b"tRNS", b"gAMA", b"cHRM", b"sRGB", b"iCCP", b"sBIT", b"bKGD", b"pHYs",
}


class SanitizeError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class SanitizeResult:
    data: bytes
    #: What was removed, by name, so a teacher's question about a missing
    #: caption has an answer.
    removed: tuple[str, ...]
    format: str


def sanitize_jpeg(data: bytes) -> SanitizeResult:
    if not data.startswith(JPEG_SOI):
        raise SanitizeError("MEDIA_SANITIZE_NOT_JPEG")
    out = bytearray(JPEG_SOI)
    removed: list[str] = []
    index = 2
    length = len(data)
    while index < length:
        if data[index] != 0xFF:
            raise SanitizeError("MEDIA_SANITIZE_JPEG_MALFORMED")
        # Fill bytes are legal between segments.
        while index < length and data[index] == 0xFF:
            index += 1
        if index >= length:
            raise SanitizeError("MEDIA_SANITIZE_JPEG_TRUNCATED")
        marker = data[index]
        index += 1
        if marker in _STANDALONE:
            out += bytes((0xFF, marker))
            continue
        if marker == 0xDA:
            # Start of scan: everything from here to the end is entropy-coded
            # image data, which is copied verbatim and never parsed.
            out += bytes((0xFF, marker)) + data[index:]
            return SanitizeResult(bytes(out), tuple(removed), "jpeg")
        if index + 2 > length:
            raise SanitizeError("MEDIA_SANITIZE_JPEG_TRUNCATED")
        size = struct.unpack(">H", data[index:index + 2])[0]
        if size < 2 or index + size > length:
            raise SanitizeError("MEDIA_SANITIZE_JPEG_MALFORMED")
        segment = data[index:index + size]
        index += size
        if marker in _JPEG_DROP:
            removed.append(f"APP{marker - 0xE0}" if 0xE0 <= marker <= 0xEF else "COM")
            continue
        out += bytes((0xFF, marker)) + segment
    raise SanitizeError("MEDIA_SANITIZE_JPEG_TRUNCATED")


def sanitize_png(data: bytes) -> SanitizeResult:
    if not data.startswith(PNG_MAGIC):
        raise SanitizeError("MEDIA_SANITIZE_NOT_PNG")
    out = bytearray(PNG_MAGIC)
    removed: list[str] = []
    index = len(PNG_MAGIC)
    length = len(data)
    saw_end = False
    while index + 8 <= length:
        size = struct.unpack(">I", data[index:index + 4])[0]
        name = data[index + 4:index + 8]
        end = index + 8 + size + 4
        if size > length or end > length:
            raise SanitizeError("MEDIA_SANITIZE_PNG_MALFORMED")
        chunk = data[index:end]
        declared = struct.unpack(">I", data[end - 4:end])[0]
        if zlib.crc32(data[index + 4:end - 4]) & 0xFFFFFFFF != declared:
            # A bad CRC means the file is damaged or was tampered with; either
            # way it is not the file to keep.
            raise SanitizeError("MEDIA_SANITIZE_PNG_CRC")
        index = end
        if name in _PNG_KEEP:
            out += chunk
        else:
            removed.append(name.decode("ascii", "replace"))
        if name == b"IEND":
            saw_end = True
            break
    if not saw_end:
        raise SanitizeError("MEDIA_SANITIZE_PNG_TRUNCATED")
    return SanitizeResult(bytes(out), tuple(removed), "png")


def sanitize_image(data: bytes) -> SanitizeResult:
    """Strip metadata from a JPEG or PNG, or refuse.

    The format is decided by the file's own magic bytes, never by the declared
    MIME type: a caller that could choose the parser could choose the wrong one
    on purpose.
    """
    if data.startswith(JPEG_SOI):
        return sanitize_jpeg(data)
    if data.startswith(PNG_MAGIC):
        return sanitize_png(data)
    raise SanitizeError("MEDIA_SANITIZE_FORMAT_UNSUPPORTED")
