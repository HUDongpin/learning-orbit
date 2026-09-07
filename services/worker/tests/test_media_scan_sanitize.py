"""Scanning uploads and stripping what a student did not mean to share."""
import struct
import unittest
import zlib

from learning_orbit_worker.media.sanitize import (
    SanitizeError,
    sanitize_image,
    sanitize_jpeg,
    sanitize_png,
)
from learning_orbit_worker.media.scan import (
    ClamAvScanner,
    ScanUnavailable,
    interpret,
)

SCAN_DATA = b"\xd2\xcf\x20"


def jpeg(*, exif: bytes | None = b"GPS 51.5074 -0.1278 iPhone-serial-ABC123", comment: bytes | None = None) -> bytes:
    parts = [b"\xff\xd8"]
    parts.append(b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")
    if exif is not None:
        payload = b"Exif\x00\x00" + exif
        parts.append(b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload)
    if comment is not None:
        parts.append(b"\xff\xfe" + struct.pack(">H", len(comment) + 2) + comment)
    parts.append(b"\xff\xc0" + struct.pack(">H", 11) + b"\x08\x00\x01\x00\x01\x01\x01\x11\x00")
    parts.append(b"\xff\xda" + struct.pack(">H", 8) + b"\x01\x01\x00\x00\x3f\x00" + SCAN_DATA + b"\xff\xd9")
    return b"".join(parts)


def chunk(name: bytes, payload: bytes) -> bytes:
    body = name + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def png(extra: list[bytes] | None = None) -> bytes:
    parts = [b"\x89PNG\r\n\x1a\n", chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))]
    parts.extend(extra or [])
    parts.append(chunk(b"gAMA", struct.pack(">I", 45455)))
    parts.append(chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff")))
    parts.append(chunk(b"IEND", b""))
    return b"".join(parts)


class SanitizeImageTest(unittest.TestCase):
    def test_a_photo_loses_its_gps_and_keeps_its_pixels(self) -> None:
        result = sanitize_jpeg(jpeg())
        self.assertEqual(result.removed, ("APP1",))
        # None of this is part of what a student meant to share.
        self.assertNotIn(b"51.5074", result.data)
        self.assertNotIn(b"iPhone-serial", result.data)
        # All of this is needed to render the picture they did mean to share.
        self.assertIn(b"JFIF", result.data)
        self.assertIn(SCAN_DATA, result.data)
        self.assertTrue(result.data.startswith(b"\xff\xd8"))
        self.assertTrue(result.data.endswith(b"\xff\xd9"))

    def test_a_free_text_comment_goes_too(self) -> None:
        result = sanitize_jpeg(jpeg(exif=None, comment=b"taken at home, 3pm"))
        self.assertEqual(result.removed, ("COM",))
        self.assertNotIn(b"taken at home", result.data)

    def test_a_jpeg_with_nothing_to_strip_is_returned_intact(self) -> None:
        original = jpeg(exif=None)
        result = sanitize_jpeg(original)
        self.assertEqual(result.removed, ())
        # Byte-identical: a file with no metadata is not silently rewritten.
        self.assertEqual(result.data, original)

    def test_png_text_and_exif_chunks_are_dropped(self) -> None:
        source = png([
            chunk(b"tEXt", b"Author\x00Student Name"),
            chunk(b"eXIf", b"GPS 51.5074"),
            chunk(b"tIME", struct.pack(">HBBBBB", 2026, 9, 7, 10, 0, 0)),
        ])
        result = sanitize_png(source)
        self.assertEqual(set(result.removed), {"tEXt", "eXIf", "tIME"})
        self.assertNotIn(b"Student Name", result.data)
        self.assertNotIn(b"51.5074", result.data)
        # Colour and pixels survive.
        self.assertIn(b"gAMA", result.data)
        self.assertIn(b"IDAT", result.data)
        self.assertIn(b"IEND", result.data)

    def test_the_format_comes_from_the_bytes_not_from_a_claim(self) -> None:
        # A caller that could pick the parser could pick the wrong one on
        # purpose, so the file's own magic decides.
        self.assertEqual(sanitize_image(jpeg()).format, "jpeg")
        self.assertEqual(sanitize_image(png()).format, "png")
        with self.assertRaises(SanitizeError) as raised:
            sanitize_image(b"GIF89a and then some")
        self.assertEqual(raised.exception.code, "MEDIA_SANITIZE_FORMAT_UNSUPPORTED")

    def test_a_truncated_or_malformed_file_is_refused_not_repaired(self) -> None:
        with self.assertRaises(SanitizeError):
            sanitize_jpeg(jpeg()[:10])
        with self.assertRaises(SanitizeError):
            sanitize_png(png()[:20])
        with self.assertRaises(SanitizeError) as raised:
            sanitize_jpeg(b"\xff\xd8\x00\x00")
        self.assertEqual(raised.exception.code, "MEDIA_SANITIZE_JPEG_MALFORMED")

    def test_a_png_with_a_bad_crc_is_refused(self) -> None:
        source = bytearray(png([chunk(b"tEXt", b"Author\x00Student Name")]))
        source[-5] ^= 0xFF
        with self.assertRaises(SanitizeError) as raised:
            sanitize_png(bytes(source))
        self.assertEqual(raised.exception.code, "MEDIA_SANITIZE_PNG_CRC")

    def test_stripping_never_decodes_pixel_data(self) -> None:
        # The scan segment is copied verbatim from the marker to the end, so
        # attacker-supplied entropy-coded data is never interpreted.
        hostile = jpeg()[:-3] + b"\xde\xad\xbe\xef" + b"\xff\xd9"
        result = sanitize_jpeg(hostile)
        self.assertIn(b"\xde\xad\xbe\xef", result.data)


class ScanTest(unittest.TestCase):
    def scanner(self, answer, **kwargs):
        def transport(_payload: bytes) -> str:
            if isinstance(answer, Exception):
                raise answer
            return answer
        return ClamAvScanner(transport=transport, **kwargs)

    def test_a_clean_file_passes(self) -> None:
        result = self.scanner("stream: OK").scan(b"harmless")
        self.assertTrue(result.clean)
        self.assertEqual(result.code, "MEDIA_SCAN_CLEAN")

    def test_an_infected_file_is_reported_with_a_bounded_signature(self) -> None:
        result = self.scanner("stream: Eicar-Test-Signature FOUND").scan(b"x")
        self.assertFalse(result.clean)
        self.assertEqual(result.code, "MEDIA_SCAN_INFECTED")
        self.assertEqual(result.signature, "Eicar-Test-Signature")

    def test_a_signature_name_cannot_smuggle_anything_into_a_log(self) -> None:
        # The name comes from signature data, which is not ours.
        result = self.scanner("stream: Bad\n\rName;rm -rf / FOUND").scan(b"x")
        self.assertFalse(result.clean)
        # Newlines, semicolons, spaces and slashes are all gone, so the name
        # cannot forge a log line or reach a shell.
        self.assertEqual(result.signature, "BadNamerm-rf")
        for forbidden in "\n\r; /":
            self.assertNotIn(forbidden, result.signature or "")

    def test_an_engine_error_is_not_a_pass(self) -> None:
        with self.assertRaises(ScanUnavailable) as raised:
            self.scanner("stream: INSTREAM size limit exceeded ERROR").scan(b"x")
        self.assertEqual(raised.exception.code, "MEDIA_SCAN_ENGINE_ERROR")

    def test_an_answer_nobody_understands_is_not_a_pass(self) -> None:
        for answer in ("", "stream: maybe", "PONG"):
            with self.assertRaises(ScanUnavailable):
                interpret(answer)

    def test_an_unreachable_scanner_is_not_a_pass(self) -> None:
        with self.assertRaises(ScanUnavailable) as raised:
            self.scanner(OSError("connection refused")).scan(b"x")
        self.assertEqual(raised.exception.code, "MEDIA_SCAN_UNREACHABLE")

    def test_a_timed_out_scanner_is_not_a_pass(self) -> None:
        with self.assertRaises(ScanUnavailable) as raised:
            self.scanner(TimeoutError()).scan(b"x")
        self.assertEqual(raised.exception.code, "MEDIA_SCAN_TIMEOUT")

    def test_a_file_larger_than_the_engine_accepts_is_refused_not_truncated(self) -> None:
        # Truncating to fit would scan something other than the uploaded file
        # and report on it as though it were the file.
        with self.assertRaises(ScanUnavailable) as raised:
            self.scanner("stream: OK", max_bytes=8).scan(b"0123456789")
        self.assertEqual(raised.exception.code, "MEDIA_SCAN_TOO_LARGE")

    def test_the_stream_is_framed_the_way_clamd_expects(self) -> None:
        seen: list[bytes] = []

        def transport(payload: bytes) -> str:
            seen.append(payload)
            return "stream: OK"

        ClamAvScanner(transport=transport).scan(b"abcdef")
        payload = seen[0]
        self.assertEqual(struct.unpack(">I", payload[:4])[0], 6)
        self.assertEqual(payload[4:10], b"abcdef")
        # A zero-length frame is what tells clamd the file is finished.
        self.assertEqual(payload[-4:], struct.pack(">I", 0))


if __name__ == "__main__":
    unittest.main()
