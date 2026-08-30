"""Deterministic ASR/OCR/vision ports for shadow-mode tests.

These fixtures never read files or perform network I/O.  A production adapter
must be selected by a reviewed manifest and persist a provider lifecycle record
before opening a request (Plan 04 Task 4/6).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class PrivateMedia:
    media_id: str
    source_event_id: str
    modality: str
    sha256: str


@dataclass(frozen=True, slots=True)
class AsrResult:
    text: str
    confidence: float
    timestamps: tuple[tuple[float, float], ...] = ()


@dataclass(frozen=True, slots=True)
class OcrResult:
    text: str
    confidence: float
    boxes: tuple[tuple[int, int, int, int], ...] = ()


@dataclass(frozen=True, slots=True)
class ImageDescriptionResult:
    text: str
    confidence: float
    user_alt: str


class AsrProvider(Protocol):
    provider_id: str
    processor_version: str

    def transcribe(self, media: PrivateMedia) -> AsrResult: ...


class OcrProvider(Protocol):
    provider_id: str
    processor_version: str

    def recognize(self, media: PrivateMedia) -> OcrResult: ...


class ImageDescriptionProvider(Protocol):
    provider_id: str
    processor_version: str

    def describe(self, media: PrivateMedia, user_alt: str) -> ImageDescriptionResult: ...


class DeterministicMultimodalProvider:
    provider_id = "fixture-multimodal-v1"
    processor_version = "fixture-2026-08"

    def __init__(self, *, asr: AsrResult | None = None, ocr: OcrResult | None = None, image: ImageDescriptionResult | None = None) -> None:
        self.asr = asr or AsrResult("分解者让养分回到土壤", 0.82, ((0.0, 1.4),))
        self.ocr = ocr or OcrResult("生产者 → 消费者", 0.79, ((0, 0, 240, 48),))
        self.image = image or ImageDescriptionResult("一张生态系统观察图", 0.76, "学生上传的生态系统观察图")

    def transcribe(self, media: PrivateMedia) -> AsrResult:
        self._check(media, "audio")
        return self.asr

    def recognize(self, media: PrivateMedia) -> OcrResult:
        self._check(media, "image")
        return self.ocr

    def describe(self, media: PrivateMedia, user_alt: str) -> ImageDescriptionResult:
        self._check(media, "image")
        return ImageDescriptionResult(self.image.text, self.image.confidence, user_alt)

    @staticmethod
    def _check(media: PrivateMedia, expected: str) -> None:
        if media.modality != expected:
            raise ValueError("MODALITY_MISMATCH")
