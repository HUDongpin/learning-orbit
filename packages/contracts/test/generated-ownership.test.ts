import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AuthSession,
  CreateRoomRequest,
  CreateRoomResponse,
  JoinRoomRequest,
  JoinRoomResponse,
  MessageAddedPayload,
  RoomClosedPayload,
  RoomDetails,
  RoomEventPage,
  RoomOpenedPayload,
  RoomPausedPayload,
  RoomResumedPayload,
  TeacherMagicLinkAccepted,
  TeacherMagicLinkRequest,
} from "../src/index.js";
import { parseCoreRoomEvent, realtimeContract, routes } from "../src/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const generatedDir = join(root, "src/generated");
const schemasDir = join(root, "schemas");
const uuid = "11111111-1111-4111-8111-111111111111";
const at = "2026-08-30T00:00:00.000Z";
const run = promisify(execFile);
const generator = join(root, "scripts/generate-types.mjs");
const generatorRunner = "const { generateTypes } = await import(process.argv[1]); await generateTypes({ schemasDir: process.argv[2], outDir: process.argv[3] });";

type PublicGeneratedWires = [
  AuthSession, TeacherMagicLinkAccepted, TeacherMagicLinkRequest,
  JoinRoomRequest, JoinRoomResponse, CreateRoomRequest, CreateRoomResponse,
  RoomDetails, RoomEventPage, MessageAddedPayload, RoomOpenedPayload,
  RoomPausedPayload, RoomResumedPayload, RoomClosedPayload,
];

function expectedModules(schemaFiles: string[]) {
  return schemaFiles.map((file) => ({ sourceFile: file, moduleFile: file.replace(/\.json$/, ".ts"), language: "typescript" }));
}

async function directoryBytes(path: string) {
  const files = (await readdir(path)).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update(await readFile(join(path, file)));
  }
  return hash.digest("hex");
}

describe("generated contract ownership", () => {
  it("uses exactly the v1 manifest shape and raw schema ownership", async () => {
    const manifest = JSON.parse(await readFile(join(generatedDir, "manifest.json"), "utf8"));
    const schemaFiles = (await readdir(schemasDir)).filter((file) => file.endsWith(".json")).sort();
    expect(Object.keys(manifest).sort()).toEqual(["generatedModules", "schemaVersion", "sourceSchemas"]);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest).not.toHaveProperty("sourceSchemaFiles");
    expect(manifest).not.toHaveProperty("schemaSha256");
    expect(manifest.sourceSchemas.map((source: { file: string }) => source.file)).toEqual(schemaFiles);
    expect(manifest.generatedModules).toEqual(expectedModules(schemaFiles));
    for (const source of manifest.sourceSchemas as Array<{ file: string; id: string; sha256: string }>) {
      const raw = await readFile(join(schemasDir, source.file));
      const schema = JSON.parse(raw.toString("utf8"));
      expect(source.id).toBe(schema.$id);
      expect(source.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    }
  });

  it("removes only a temporary orphan through the actual exported generator", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "learning-orbit-contract-generator-"));
    const temporarySchemas = join(temporaryRoot, "schemas");
    const temporaryOutput = join(temporaryRoot, "generated");
    const orphan = join(temporaryOutput, "orphan.ts");
    try {
      await cp(schemasDir, temporarySchemas, { recursive: true });
      await mkdir(temporaryOutput);
      await writeFile(orphan, "export const orphan = true;\n");
      await access(orphan);
      await run(process.execPath, ["--input-type=module", "-e", generatorRunner, generator, temporarySchemas, temporaryOutput]);
      await expect(access(orphan)).rejects.toThrow();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("keeps temporary published output intact when schema validation fails", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "learning-orbit-contract-generator-failure-"));
    const temporarySchemas = join(temporaryRoot, "schemas");
    const temporaryOutput = join(temporaryRoot, "generated");
    const sentinel = join(temporaryOutput, "sentinel.ts");
    const manifest = join(temporaryOutput, "manifest.json");
    try {
      await cp(schemasDir, temporarySchemas, { recursive: true });
      await mkdir(temporaryOutput);
      await writeFile(join(temporarySchemas, "invalid.json"), "{}\n");
      await writeFile(sentinel, "export const sentinel = true;\n");
      await writeFile(manifest, "{\"sentinel\":true}\n");
      const before = await directoryBytes(temporaryOutput);
      await expect(run(process.execPath, ["--input-type=module", "-e", generatorRunner, generator, temporarySchemas, temporaryOutput])).rejects.toThrow("SCHEMA_ID_MISSING:invalid.json");
      await expect(readFile(sentinel, "utf8")).resolves.toBe("export const sentinel = true;\n");
      await expect(readFile(manifest, "utf8")).resolves.toBe("{\"sentinel\":true}\n");
      expect(await directoryBytes(temporaryOutput)).toBe(before);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fails deterministically on a temporary output lock without touching that output", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "learning-orbit-contract-generator-lock-"));
    const temporarySchemas = join(temporaryRoot, "schemas");
    const temporaryOutput = join(temporaryRoot, "generated");
    try {
      await cp(schemasDir, temporarySchemas, { recursive: true });
      await mkdir(temporaryOutput);
      await writeFile(join(temporaryOutput, "sentinel.ts"), "export const sentinel = true;\n");
      await writeFile(join(temporaryRoot, "generated.lock"), "held\n");
      const before = await directoryBytes(temporaryOutput);
      await expect(run(process.execPath, ["--input-type=module", "-e", generatorRunner, generator, temporarySchemas, temporaryOutput])).rejects.toThrow("GENERATOR_OUTPUT_LOCKED");
      expect(await directoryBytes(temporaryOutput)).toBe(before);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("has exactly one generated TypeScript module for each source schema", async () => {
    const schemaFiles = (await readdir(schemasDir)).filter((file) => file.endsWith(".json")).sort();
    const disk = (await readdir(generatedDir)).filter((file) => file.endsWith(".ts")).sort();
    const expected = expectedModules(schemaFiles).map((module) => module.moduleFile).sort();
    expect(disk).toEqual(expected);
  });

  it("exports generated public wires and narrows only known core events", () => {
    expectTypeOf<PublicGeneratedWires>().not.toEqualTypeOf<never>();
    expect(routes.rooms.events("a/b", { afterSeq: 4, limit: 500 })).toBe("/v1/rooms/a%2Fb/events?afterSeq=4&limit=500");
    const envelope = { eventId: uuid, schemaVersion: 1 as const, roomId: uuid, roomSeq: 1, type: "message.added", actorId: uuid, actorKind: "human" as const, actorRole: "student" as const, revision: 1, operation: "add" as const, eventTime: at, ingestTime: at, causationId: uuid, correlationId: uuid, payload: { messageId: uuid, text: "hello", replyTo: null, mentions: [], mediaIds: [] } };
    expect(parseCoreRoomEvent(envelope)?.type).toBe("message.added");
    expect(parseCoreRoomEvent({ ...envelope, type: "extension.sampled" })).toBeNull();
    expect(() => parseCoreRoomEvent({ ...envelope, payload: { bad: true } })).toThrow("INVALID_EVENT_PAYLOAD:message.added");
  });

  it("validates the complete unknown core envelope before registry narrowing", () => {
    const envelope = { eventId: uuid, schemaVersion: 1, roomId: uuid, roomSeq: 1, type: "message.added", actorId: uuid, actorKind: "human", actorRole: "student", revision: 1, operation: "add", eventTime: at, ingestTime: at, causationId: uuid, correlationId: uuid, payload: { messageId: uuid, text: "hello", replyTo: null, mentions: [], mediaIds: [] } };
    expect(() => parseCoreRoomEvent(null)).toThrow("INVALID_ROOM_EVENT");
    expect(() => parseCoreRoomEvent("not an event")).toThrow("INVALID_ROOM_EVENT");
    const { correlationId: _correlationId, ...withoutCorrelation } = envelope;
    expect(() => parseCoreRoomEvent(withoutCorrelation)).toThrow("INVALID_ROOM_EVENT");
    expect(parseCoreRoomEvent({ ...envelope, type: "extension.sampled", payload: { future: true } })).toBeNull();
    expect(() => parseCoreRoomEvent({ ...envelope, payload: { messageId: uuid } })).toThrow("INVALID_EVENT_PAYLOAD:message.added");
  });

  it("applies core payload semantics to realtime events while retaining extension transport", () => {
    const envelope = { eventId: uuid, schemaVersion: 1, roomId: uuid, roomSeq: 1, type: "message.added", actorId: uuid, actorKind: "human", actorRole: "student", revision: 1, operation: "add", eventTime: at, ingestTime: at, causationId: uuid, correlationId: uuid, payload: { messageId: uuid, text: "hello", replyTo: null, mentions: [], mediaIds: [] } };
    expect(() => realtimeContract.parseRealtimeFrame({ type: "event", event: { ...envelope, payload: { messageId: uuid } } })).toThrow("INVALID_EVENT_PAYLOAD:message.added");
    const extension = { ...envelope, type: "extension.sampled", payload: { arbitrary: { future: true } } };
    expect(realtimeContract.parseRealtimeFrame({ type: "event", event: extension })).toEqual({ type: "event", event: extension });
    expect(parseCoreRoomEvent(extension)).toBeNull();
  });
});
