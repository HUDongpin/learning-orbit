import type { ValidateFunction } from "ajv";

import envelopeSchema from "../schemas/room-event-envelope.v1.json" with { type: "json" };
import roomHttpSchema from "../schemas/room-http.v1.json" with { type: "json" };
import type {
  CreateRoomRequest,
  CreateRoomResponse,
  JoinRoomRequest,
  JoinRoomResponse,
  RoomDetails,
  RoomEventPage,
} from "./generated/room-http.v1.js";
import { makeSchemaAjv } from "./schema-ajv.js";

const ajv = makeSchemaAjv();
ajv.addSchema(envelopeSchema);
ajv.addSchema(roomHttpSchema);

function validator<T>(definition: string): ValidateFunction<T> {
  const result = ajv.getSchema(
    `${roomHttpSchema.$id}#/$defs/${definition}`,
  ) as ValidateFunction<T> | undefined;
  if (!result) throw new Error("ROOM_SCHEMA_REGISTRATION_FAILED");
  return result;
}

const createRequestValidator = validator<CreateRoomRequest>("CreateRoomRequest");
const createResponseValidator = validator<CreateRoomResponse>("CreateRoomResponse");
const joinRequestValidator = validator<JoinRoomRequest>("JoinRoomRequest");
const joinResponseValidator = validator<JoinRoomResponse>("JoinRoomResponse");
const detailsValidator = validator<RoomDetails>("RoomDetails");
const eventsValidator = validator<RoomEventPage>("RoomEventPage");

function parse<T>(value: unknown, validate: ValidateFunction<T>, code: string): T {
  if (!validate(value)) throw new Error(code);
  return value;
}

function encode<T>(value: unknown, validate: ValidateFunction<T>, code: string): string {
  return JSON.stringify(parse(value, validate, code));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export const roomHttpContract = {
  parseCreateRoomRequest(value: unknown): CreateRoomRequest {
    if (
      !isPlainObject(value)
      || Object.keys(value).length !== 1
      || !Object.hasOwn(value, "topic")
      || typeof value.topic !== "string"
    ) throw new Error("INVALID_CREATE_ROOM_REQUEST");
    return parse(
      { topic: value.topic.trim() },
      createRequestValidator,
      "INVALID_CREATE_ROOM_REQUEST",
    );
  },
  encodeCreateRoomRequest(value: unknown): string {
    return encode(value, createRequestValidator, "INVALID_CREATE_ROOM_REQUEST");
  },
  parseCreateRoomResponse(value: unknown): CreateRoomResponse {
    return parse(value, createResponseValidator, "INVALID_CREATE_ROOM_RESPONSE");
  },
  encodeCreateRoomResponse(value: unknown): string {
    return encode(value, createResponseValidator, "INVALID_CREATE_ROOM_RESPONSE");
  },
  parseJoinRoomRequest(value: unknown): JoinRoomRequest {
    return parse(value, joinRequestValidator, "INVALID_JOIN_ROOM_REQUEST");
  },
  encodeJoinRoomRequest(value: unknown): string {
    return encode(value, joinRequestValidator, "INVALID_JOIN_ROOM_REQUEST");
  },
  parseJoinRoomResponse(value: unknown): JoinRoomResponse {
    return parse(value, joinResponseValidator, "INVALID_JOIN_ROOM_RESPONSE");
  },
  encodeJoinRoomResponse(value: unknown): string {
    return encode(value, joinResponseValidator, "INVALID_JOIN_ROOM_RESPONSE");
  },
  parseRoomDetails(value: unknown): RoomDetails {
    return parse(value, detailsValidator, "INVALID_ROOM_DETAILS");
  },
  encodeRoomDetails(value: unknown): string {
    return encode(value, detailsValidator, "INVALID_ROOM_DETAILS");
  },
  parseRoomEventPage(value: unknown): RoomEventPage { return parse(value, eventsValidator, "INVALID_ROOM_EVENT_PAGE"); },
  encodeRoomEventPage(value: unknown): string { return encode(value, eventsValidator, "INVALID_ROOM_EVENT_PAGE"); },
};
