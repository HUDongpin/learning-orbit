import { describe, expect, it } from "vitest";

import goldenEcho from "../../test-fixtures/analytics/golden-echo-projection.json" with { type: "json" };
import goldenTrace from "../../test-fixtures/analytics/golden-trace-projections.json" with { type: "json" };
import { teacherRoomExportContract } from "../src/index.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const OTHER_ROOM_ID = "00000000-0000-4000-8000-000000000099";
const SOURCE_EVENT_ID = "00000000-0000-4000-8000-000000000101";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000201";
const CORRECTED_ARTIFACT_ID = "00000000-0000-4000-8000-000000000202";
const LINEAGE_ID = "00000000-0000-4000-8000-000000000203";

function roomEvent(
  roomSeq: number,
  type: string,
  payload: Record<string, unknown>,
  actor: Readonly<{
    actorKind: "human" | "system";
    actorRole: "teacher" | "student" | "room_clock";
  }> = { actorKind: "human", actorRole: "teacher" },
) {
  return {
    eventId: roomSeq === 1
      ? SOURCE_EVENT_ID
      : `00000000-0000-4000-8000-${String(100 + roomSeq).padStart(12, "0")}`,
    schemaVersion: 1,
    roomId: ROOM_ID,
    roomSeq,
    type,
    actorId: `00000000-0000-4000-8001-${String(roomSeq).padStart(12, "0")}`,
    ...actor,
    revision: 1,
    operation: "add",
    eventTime: `2026-08-28T09:0${roomSeq}:00.000Z`,
    ingestTime: `2026-08-28T09:0${roomSeq}:00.001Z`,
    causationId: `00000000-0000-4000-8002-${String(roomSeq).padStart(12, "0")}`,
    correlationId: `00000000-0000-4000-8003-${String(roomSeq).padStart(12, "0")}`,
    payload,
  };
}

const events = [
  roomEvent(1, "message.added", {
    messageId: "00000000-0000-4000-8000-000000000301",
    text: "The sun provides energy to producers in this ecosystem.",
    replyTo: null,
    mentions: [],
    mediaIds: [],
  }, { actorKind: "human", actorRole: "student" }),
  roomEvent(2, "room.opened", {
    startsAt: "2026-08-28T09:02:00.000Z",
    closesAt: "2026-08-28T09:47:00.000Z",
  }),
  roomEvent(3, "room.paused", { pausedAt: "2026-08-28T09:03:00.000Z" }),
  roomEvent(4, "analytics.correction.recorded.v1", { changeKind: "correction" }),
  roomEvent(5, "room.closed", { closedAt: "2026-08-28T09:05:00.000Z" }, {
    actorKind: "system",
    actorRole: "room_clock",
  }),
];

const artifacts = [
  {
    artifactId: ARTIFACT_ID,
    lineageId: LINEAGE_ID,
    roomId: ROOM_ID,
    eventId: SOURCE_EVENT_ID,
    roomSeq: 1,
    sourceModality: "text",
    derivation: "direct",
    text: "The sun provides energy to producers in this ecosystem.",
    languageTag: "en",
    reviewStatus: "approved",
    createdAt: "2026-08-28T09:01:01.000Z",
  },
  {
    artifactId: CORRECTED_ARTIFACT_ID,
    lineageId: LINEAGE_ID,
    roomId: ROOM_ID,
    eventId: events[3]!.eventId,
    roomSeq: 4,
    sourceModality: "text",
    derivation: "human_correction",
    text: "Sunlight transfers energy to producers.",
    languageTag: "en",
    reviewStatus: "corrected",
    createdAt: "2026-08-28T09:01:02.000Z",
  },
];

const artifactSources = [
  {
    artifactId: ARTIFACT_ID,
    lineageId: LINEAGE_ID,
    roomId: ROOM_ID,
    eventId: SOURCE_EVENT_ID,
    roomSeq: 1,
    sourceMediaId: null,
    sourceModality: "text",
    derivation: "direct",
    supersedesArtifactId: null,
  },
  {
    artifactId: CORRECTED_ARTIFACT_ID,
    lineageId: LINEAGE_ID,
    roomId: ROOM_ID,
    eventId: events[3]!.eventId,
    roomSeq: 4,
    sourceMediaId: null,
    sourceModality: "text",
    derivation: "human_correction",
    supersedesArtifactId: ARTIFACT_ID,
  },
];

const teacherEcho = structuredClone(goldenEcho);
const teacherTrace = structuredClone(goldenTrace.teacher);
const projectionSources = [teacherEcho, teacherTrace].map((projection) => ({
  projectionKey: projection.projectionKey,
  roomId: projection.roomId,
  analysisEpoch: projection.analysisEpoch,
  algorithmVersion: projection.algorithmVersion,
  projectionVersion: projection.projectionVersion,
  completeThroughRoomSeq: projection.completeThroughRoomSeq,
  watermarkEventTime: projection.watermarkEventTime,
}));

const validExport = {
  schemaVersion: 1,
  exportKind: "teacher_room",
  roomId: ROOM_ID,
  throughRoomSeq: 5,
  events,
  artifacts,
  projections: [teacherEcho, teacherTrace],
  provenance: {
    artifactSources,
    projectionSources,
  },
};

function clone(): any {
  return structuredClone(validExport);
}

describe("teacher room JSON export contract", () => {
  it("parses and canonically encodes complete teacher-authorized room data", () => {
    expect(teacherRoomExportContract.parse(validExport)).toEqual(validExport);
    expect(JSON.parse(teacherRoomExportContract.encode(validExport))).toEqual(validExport);
    expect(validExport.artifacts.map(({ reviewStatus }) => reviewStatus)).toEqual(["approved", "corrected"]);
  });

  it("binds every event and exported object to one room and one continuous room cursor", () => {
    for (const mutate of [
      (value: any) => { value.events[1].roomId = OTHER_ROOM_ID; },
      (value: any) => { value.events[1].roomSeq = 4; },
      (value: any) => { value.throughRoomSeq = 6; },
      (value: any) => { value.artifacts[0].roomId = OTHER_ROOM_ID; },
      (value: any) => { value.artifacts[0].eventId = "00000000-0000-4000-8000-000000000999"; },
      (value: any) => { value.artifacts[0].roomSeq = 2; },
    ]) {
      const candidate = clone();
      mutate(candidate);
      expect(() => teacherRoomExportContract.parse(candidate)).toThrow("INVALID_TEACHER_ROOM_EXPORT");
    }
  });

  it("exports only approved or corrected artifact content and closed, content-free provenance", () => {
    for (const mutate of [
      (value: any) => { value.artifacts[0].reviewStatus = "unreviewed"; },
      (value: any) => { value.artifacts[0].sourceConfidenceRaw = 0.99; },
      (value: any) => { value.provenance.artifactSources[0].text = "student content leak"; },
      (value: any) => { value.provenance.artifactSources[0].sourceConfidenceRaw = 0.99; },
      (value: any) => { value.provenance.artifactSources[0].providerSecret = "secret"; },
      (value: any) => { value.provenance.artifactSources[0].uploadUrl = "https://signed.example/upload?token=secret"; },
      (value: any) => { value.provenance.artifactSources[0].eventId = events[1]!.eventId; },
      (value: any) => { value.provenance.artifactSources[0].roomId = OTHER_ROOM_ID; },
      (value: any) => { value.provenance.artifactSources.pop(); },
    ]) {
      const candidate = clone();
      mutate(candidate);
      expect(() => teacherRoomExportContract.parse(candidate)).toThrow("INVALID_TEACHER_ROOM_EXPORT");
    }
  });

  it("accepts only teacher-role projection branches with exact provenance", () => {
    for (const mutate of [
      (value: any) => { value.projections[0].projectionKey = "echo.student_approved"; },
      (value: any) => { value.projections[1] = structuredClone(goldenTrace.student); },
      (value: any) => { value.projections[0].roomId = OTHER_ROOM_ID; },
      (value: any) => { value.projections.push(structuredClone(value.projections[0])); },
      (value: any) => { value.projections[0].completeThroughRoomSeq = 6; },
      (value: any) => { value.provenance.projectionSources[0].projectionVersion = 2; },
      (value: any) => { value.provenance.projectionSources[0].parameterHash = "a".repeat(64); },
      (value: any) => { value.provenance.projectionSources.pop(); },
    ]) {
      const candidate = clone();
      mutate(candidate);
      expect(() => teacherRoomExportContract.parse(candidate)).toThrow("INVALID_TEACHER_ROOM_EXPORT");
    }
  });

  it("accepts only known closed RoomEvent payloads and unique identities", () => {
    for (const mutate of [
      (value: any) => { value.events[0].payload.uploadUrl = "https://signed.example/upload?token=secret"; },
      (value: any) => { value.events[0].type = "provider.secret.recorded.v1"; },
      (value: any) => { value.events[1].eventId = value.events[0].eventId; },
      (value: any) => { value.events[0].providerToken = "secret"; },
      (value: any) => {
        value.artifacts[0].eventId = value.events[1].eventId;
        value.artifacts[0].roomSeq = value.events[1].roomSeq;
        value.provenance.artifactSources[0].eventId = value.events[1].eventId;
        value.provenance.artifactSources[0].roomSeq = value.events[1].roomSeq;
      },
    ]) {
      const candidate = clone();
      mutate(candidate);
      expect(() => teacherRoomExportContract.parse(candidate)).toThrow("INVALID_TEACHER_ROOM_EXPORT");
    }
  });
});
