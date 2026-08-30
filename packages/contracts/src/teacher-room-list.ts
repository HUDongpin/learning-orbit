import type { ValidateFunction } from "ajv";

import schema from "../schemas/teacher-room-list.v1.json" with { type: "json" };
import type { TeacherRoomListResponse } from "./generated/teacher-room-list.v1.js";
import { makeSchemaAjv } from "./schema-ajv.js";

const ajv = makeSchemaAjv();
const validate = ajv.compile(schema) as ValidateFunction<TeacherRoomListResponse>;

function parse(value: unknown): TeacherRoomListResponse {
  if (!validate(value)) throw new Error("INVALID_TEACHER_ROOM_LIST_RESPONSE");
  return value;
}

export const teacherRoomListContract = {
  parse,
  encode(value: unknown): string {
    return JSON.stringify(parse(value));
  },
};
