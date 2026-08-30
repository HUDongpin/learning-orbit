/* generated; source is JSON Schema */

export type DerivedTextArtifact = {
  [k: string]: unknown;
} & {
  schemaVersion: 1;
  artifactId: string;
  lineageId: string;
  roomId: string;
  eventId: string;
  roomSeq: number;
  sourceMediaId: string | null;
  sourceModality: "text" | "audio" | "image";
  derivation: "direct" | "asr" | "ocr" | "image_description" | "human_correction";
  text: string;
  normalizedTextSha256: string;
  sourceConfidenceRaw: number;
  sourceConfidenceCalibrated: number | null;
  provider: string;
  modelVersion: string;
  languageTag: string;
  spans: {
    start: number;
    end: number;
    confidence: number;
    startMs?: number;
    endMs?: number;
    /**
     * @minItems 4
     * @maxItems 4
     */
    boundingBox?: [number, number, number, number];
  }[];
  reviewStatus: "unreviewed" | "approved" | "rejected" | "corrected";
  displayStatus: "hidden" | "teacher_shadow" | "student_approved";
  /**
   * @maxItems 32
   */
  warnings: string[];
  supersedesArtifactId: string | null;
  active: boolean;
  createdAt: string;
};
