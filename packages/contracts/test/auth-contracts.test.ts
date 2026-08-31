import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeSchemaAjv, routes } from "../src/index.js";

const schemasDir = fileURLToPath(new URL("../schemas/", import.meta.url));
const generatedDir = fileURLToPath(new URL("../src/generated/", import.meta.url));
const uuid = "11111111-1111-4111-8111-111111111111";
const laterUuid = "22222222-2222-4222-8222-222222222222";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): JsonObject {
  if (!isObject(value)) {
    throw new Error("EXPECTED_JSON_OBJECT");
  }
  return value;
}

function objects(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw new Error("EXPECTED_JSON_OBJECT_ARRAY");
  return value.map(object);
}

async function json(path: string): Promise<JsonObject> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return object(parsed);
}

async function schema(name: string) {
  return json(join(schemasDir, `${name}.json`));
}

describe("auth wire contracts", () => {
  it("owns closed student and teacher session branches", async () => {
    const source = await schema("auth-session.v1");
    expect([source.$schema, source.$id, source.title]).toEqual([
      "https://json-schema.org/draft/2020-12/schema",
      "https://learning-orbit.local/schemas/auth-session.v1.json",
      "AuthSession",
    ]);
    const branches = objects(source.oneOf);
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch.additionalProperties).toBe(false);
    }

    const validate = makeSchemaAjv().compile(source);
    const nova = {
      actorId: laterUuid,
      actorKind: "agent",
      actorRole: "socratic_facilitator",
      displayName: "Nova Agent",
    };
    const student = {
      role: "student",
      roomId: uuid,
      roomMemberId: laterUuid,
      actorId: uuid,
      pseudonym: "探索者 A",
      nova,
    };
    const teacher = { role: "teacher", teacherId: uuid, actorId: uuid };

    expect(validate(student)).toBe(true);
    expect(validate({ ...student, pseudonym: "王同學" })).toBe(false);
    expect(validate(teacher)).toBe(true);
    expect(validate({ ...student, extra: true })).toBe(false);
    expect(validate({ ...student, nova: { ...nova, displayName: "Other Agent" } })).toBe(false);
    expect(validate({ ...teacher, roomId: laterUuid })).toBe(false);
  });

  it("owns the closed teacher magic-link request and accepted response", async () => {
    const source = await schema("auth-http.v1");
    expect([source.$schema, source.$id, source.title, source.additionalProperties, source.maxProperties]).toEqual([
      "https://json-schema.org/draft/2020-12/schema",
      "https://learning-orbit.local/schemas/auth-http.v1.json",
      "AuthHttpCatalog",
      false,
      0,
    ]);
    const definitions = object(source.$defs);
    expect(Object.keys(definitions).sort()).toEqual([
      "TeacherMagicLinkAccepted",
      "TeacherMagicLinkRequest",
    ]);

    const ajv = makeSchemaAjv();
    ajv.addSchema(source);
    const request = ajv.getSchema(`${String(source.$id)}#/$defs/TeacherMagicLinkRequest`)!;
    const accepted = ajv.getSchema(`${String(source.$id)}#/$defs/TeacherMagicLinkAccepted`)!;
    expect(request({ email: "teacher@example.edu" })).toBe(true);
    expect(request({ email: "not-an-email" })).toBe(false);
    expect(request({ email: `${"a".repeat(243)}@example.edu` })).toBe(false);
    expect(request({ email: "teacher@example.edu", allowed: true })).toBe(false);
    expect(accepted({ accepted: true })).toBe(true);
    expect(accepted({ accepted: false })).toBe(false);
    expect(accepted({ accepted: true, email: "teacher@example.edu" })).toBe(false);
  });

  it("auto-discovers both auth schemas and generated modules", async () => {
    const manifest = await json(join(generatedDir, "manifest.json"));
    const sources = objects(manifest.sourceSchemas);
    const modules = objects(manifest.generatedModules);
    expect(sources.map(({ file }) => file)).toContain("auth-session.v1.json");
    expect(sources.map(({ file }) => file)).toContain("auth-http.v1.json");
    expect(modules).toEqual(expect.arrayContaining([
      { sourceFile: "auth-session.v1.json", moduleFile: "auth-session.v1.ts", language: "typescript" },
      { sourceFile: "auth-http.v1.json", moduleFile: "auth-http.v1.ts", language: "typescript" },
    ]));
  });

  it("builds exact auth and implemented room routes with encoded path segments", () => {
    expect(routes.auth.session()).toBe("/v1/auth/session");
    expect(routes.auth.teacherMagicLink()).toBe("/v1/auth/teacher/magic-link");
    const token = "abc &?=/%redirect=evil";
    const consume = routes.auth.teacherMagicLinkConsume(token);
    expect(consume).toBe(
      "/v1/auth/teacher/magic-link/consume?token=abc%20%26%3F%3D%2F%25redirect%3Devil",
    );
    const parsed = new URL(consume, "https://learning-orbit.local");
    expect(parsed.searchParams.get("token")).toBe(token);
    expect(parsed.searchParams.get("redirect")).toBeNull();
    expect(routes.rooms.create()).toBe("/v1/rooms");
    expect(routes.rooms.join()).toBe("/v1/rooms/join");
    expect(routes.rooms.get("a/b")).toBe("/v1/rooms/a%2Fb");
    expect(routes.rooms.events("a/b", { afterSeq: 4, limit: 500 })).toBe(
      "/v1/rooms/a%2Fb/events?afterSeq=4&limit=500",
    );
    expect(routes.rooms.websocket("a/b")).toBe("/v1/rooms/a%2Fb/realtime");
  });
});
