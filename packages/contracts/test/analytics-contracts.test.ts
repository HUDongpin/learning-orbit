import { describe, expect, it } from "vitest";
import { analyticsContract } from "../src/index.js";
import goldenEcho from "../../test-fixtures/analytics/golden-echo-projection.json" with { type: "json" };

const uuid = "00000000-0000-4000-8000-000000000010";

describe("analytics contract spine", () => {
  it("accepts an evidence-backed ECHO snapshot and rejects collapsed fields", () => {
    expect(analyticsContract.parseEchoSnapshot(goldenEcho)).toMatchObject({ projectionKey: "echo.teacher_shadow" });
    expect(() => analyticsContract.parseEchoSnapshot({ ...goldenEcho, confidence: 0.9 })).toThrow("INVALID_ECHO_PROJECTION");
  });

  it("keeps derived confidence/status separate and closes artifact pages", () => {
    const artifact = {
      schemaVersion: 1, artifactId: uuid, lineageId: "00000000-0000-4000-8000-000000000011", roomId: uuid,
      eventId: "00000000-0000-4000-8000-000000000012", roomSeq: 1, sourceMediaId: null,
      sourceModality: "text", derivation: "direct", text: "太陽提供能量。", normalizedTextSha256: "a".repeat(64),
      sourceConfidenceRaw: 1, sourceConfidenceCalibrated: null, provider: "learner-authored", modelVersion: "direct-text-v1",
      languageTag: "zh-Hant", spans: [], reviewStatus: "unreviewed", displayStatus: "hidden", warnings: [],
      supersedesArtifactId: null, active: true, createdAt: "2026-08-30T09:00:00.000Z",
    };
    expect(analyticsContract.parseArtifactPage({ items: [artifact], throughRoomSeq: 1, nextAfterArtifactId: null, includeHistory: false }).items).toHaveLength(1);
    expect(() => analyticsContract.parseArtifact({ ...artifact, prompt: "secret" })).toThrow("INVALID_DERIVED_TEXT_ARTIFACT");
  });
});
