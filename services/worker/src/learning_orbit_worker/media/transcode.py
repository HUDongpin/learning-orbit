"""Normalise uploaded audio to one format, through a fenced ffmpeg.

Unlike image sanitizing, there is no way to do this without decoding the file,
and decoding attacker-supplied media is the largest attack surface in the whole
pipeline. It is accepted here because there is no alternative that produces
playable audio, and it is fenced accordingly:

* Nothing reaches ffmpeg that has not already passed the malware scan.
* The bytes arrive on stdin and leave on stdout. No temporary file exists to
  be raced, and no path derived from user input is ever an argument.
* `-protocol_whitelist pipe` means a crafted container cannot make ffmpeg open
  a URL, a file, or a device — the classic way a media decoder becomes an
  exfiltration primitive.
* The input format is asserted rather than probed, so a file claiming to be
  audio cannot be routed into a different demuxer.
* A hard timeout and an output ceiling bound what a decompression bomb costs.
* It runs as the image's unprivileged user, like everything else.

The output is Opus in an Ogg container: one format, so a browser never has to
negotiate, and the room never stores an unconverted original as the thing
students play.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from typing import Callable, Mapping, Sequence

from .derivative import write_derivative

#: Input formats this pipeline accepts, mapped to the demuxer name asserted on
#: the command line. Anything else is refused before ffmpeg starts.
INPUT_FORMATS: Mapping[str, str] = {
    "audio/mpeg": "mp3",
    "audio/mp4": "mp4",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
}

#: One output mime, and it is in the server's audio allowlist. The derivative
#: is written under it and described by it; the download path refuses the pair
#: if they ever come apart.
OUTPUT_CONTENT_TYPE = "audio/ogg"

#: A classroom clip. Longer than a lesson is not an upload, it is a mistake or
#: an attack.
MAX_DURATION_SECONDS = 15 * 60
MAX_OUTPUT_BYTES = 25 * 1024 * 1024
TIMEOUT_SECONDS = 120.0


class TranscodeError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class TranscodeResult:
    data: bytes
    content_type: str


Runner = Callable[[Sequence[str], bytes, float], tuple[int, bytes, bytes]]


def _subprocess_runner(argv: Sequence[str], data: bytes, timeout: float) -> tuple[int, bytes, bytes]:
    completed = subprocess.run(  # noqa: S603 - argv is fixed; no shell, no user paths
        list(argv), input=data, capture_output=True, timeout=timeout, check=False,
    )
    return completed.returncode, completed.stdout, completed.stderr


def ffmpeg_argv(input_format: str) -> list[str]:
    """The exact command line, built from constants and one allowlisted token."""
    if input_format not in set(INPUT_FORMATS.values()):
        raise TranscodeError("MEDIA_TRANSCODE_FORMAT_UNSUPPORTED")
    return [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel", "error",
        # A crafted container must not be able to make the decoder open a URL,
        # a file, or a device.
        "-protocol_whitelist", "pipe",
        "-f", input_format,
        "-i", "pipe:0",
        "-vn",
        "-map", "0:a:0",
        "-t", str(MAX_DURATION_SECONDS),
        "-c:a", "libopus",
        "-b:a", "64k",
        "-ac", "1",
        "-ar", "48000",
        "-f", "ogg",
        "pipe:1",
    ]


def transcode_audio(
    data: bytes,
    declared_mime: str | None,
    *,
    runner: Runner | None = None,
    max_output_bytes: int = MAX_OUTPUT_BYTES,
) -> TranscodeResult:
    input_format = INPUT_FORMATS.get((declared_mime or "").split(";", 1)[0].strip().lower())
    if input_format is None:
        raise TranscodeError("MEDIA_TRANSCODE_FORMAT_UNSUPPORTED")
    run = runner or _subprocess_runner
    try:
        code, out, _err = run(ffmpeg_argv(input_format), data, TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        raise TranscodeError("MEDIA_TRANSCODE_TIMEOUT") from None
    except FileNotFoundError:
        # Stated rather than silent: an image without ffmpeg cannot process
        # audio, and reporting that is better than reporting a bad upload.
        raise TranscodeError("MEDIA_TRANSCODE_UNAVAILABLE") from None
    except OSError:
        raise TranscodeError("MEDIA_TRANSCODE_FAILED") from None
    if code != 0:
        # ffmpeg's stderr can quote container metadata, which came from the
        # upload; only the exit status escapes.
        raise TranscodeError("MEDIA_TRANSCODE_REJECTED")
    if not out:
        raise TranscodeError("MEDIA_TRANSCODE_EMPTY")
    if len(out) > max_output_bytes:
        raise TranscodeError("MEDIA_TRANSCODE_OUTPUT_TOO_LARGE")
    return TranscodeResult(out, OUTPUT_CONTENT_TYPE)


class FfmpegTranscoder:
    """The `transcoder` seam the media processor calls for non-image media."""

    def __init__(self, *, runner: Runner | None = None) -> None:
        self._runner = runner

    def __call__(self, *, row, data: bytes, store) -> list[dict[str, object]]:
        result = transcode_audio(data, row.detected_mime, runner=self._runner)
        # `playback_audio` is the kind the server's download path looks for on
        # a non-image asset, and the key is the server's own layout. The
        # previous `normalised_audio` under a suffixed staging key was neither,
        # so every transcoded upload was refused as MEDIA_OUTCOME_INVALID.
        return [write_derivative(
            store, room_id=row.room_id, media_id=row.media_id,
            kind="playback_audio", data=result.data, mime=result.content_type,
        )]
