import type { ValidateFunction } from "ajv";

import schema from "../schemas/room-internal-auto-close.v1.json" with { type: "json" };
import type {
  Request,
  Response,
} from "./generated/room-internal-auto-close.v1.js";
import { makeSchemaAjv } from "./schema-ajv.js";

const ajv = makeSchemaAjv();
ajv.addSchema(schema);

function validator<Type>(definition: string): ValidateFunction<Type> {
  const result = ajv.getSchema(
    `${schema.$id}#/$defs/${definition}`,
  ) as ValidateFunction<Type> | undefined;
  if (!result) throw new Error("ROOM_INTERNAL_AUTO_CLOSE_SCHEMA_REGISTRATION_FAILED");
  return result;
}

const requestValidator = validator<Request>("Request");
const responseValidator = validator<Response>("Response");

function parse<Type>(
  value: unknown,
  validate: ValidateFunction<Type>,
  code: string,
): Type {
  if (!validate(value)) throw new Error(code);
  return value;
}

export const roomInternalAutoCloseContract = {
  parseRequest(value: unknown): Request {
    return parse(
      value,
      requestValidator,
      "INVALID_ROOM_INTERNAL_AUTO_CLOSE_REQUEST",
    );
  },
  parseResponse(value: unknown): Response {
    return parse(
      value,
      responseValidator,
      "INVALID_ROOM_INTERNAL_AUTO_CLOSE_RESPONSE",
    );
  },
  encodeResponse(value: unknown): string {
    return JSON.stringify(parse(
      value,
      responseValidator,
      "INVALID_ROOM_INTERNAL_AUTO_CLOSE_RESPONSE",
    ));
  },
};
