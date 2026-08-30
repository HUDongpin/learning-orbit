import type { ValidateFunction } from "ajv";

import authHttpSchema from "../schemas/auth-http.v1.json" with { type: "json" };
import authSessionSchema from "../schemas/auth-session.v1.json" with { type: "json" };
import type { AuthSession } from "./generated/auth-session.v1.js";
import type { TeacherMagicLinkAccepted, TeacherMagicLinkRequest } from "./generated/auth-http.v1.js";
import { makeSchemaAjv } from "./schema-ajv.js";

const ajv = makeSchemaAjv();
ajv.addSchema(authHttpSchema);
ajv.addSchema(authSessionSchema);

function validator<T>(id: string): ValidateFunction<T> {
  const result = ajv.getSchema(id) as ValidateFunction<T> | undefined;
  if (!result) throw new Error("AUTH_SCHEMA_REGISTRATION_FAILED");
  return result;
}

const requestValidator = validator<TeacherMagicLinkRequest>(
  `${authHttpSchema.$id}#/$defs/TeacherMagicLinkRequest`,
);
const acceptedValidator = validator<TeacherMagicLinkAccepted>(
  `${authHttpSchema.$id}#/$defs/TeacherMagicLinkAccepted`,
);
const sessionValidator = validator<AuthSession>(authSessionSchema.$id);

function parse<T>(value: unknown, validate: ValidateFunction<T>, code: string): T {
  if (!validate(value)) throw new Error(code);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export const authContract = {
  parseTeacherMagicLinkRequest(value: unknown): TeacherMagicLinkRequest {
    if (
      !isPlainObject(value)
      || Object.keys(value).length !== 1 || !Object.hasOwn(value, "email") || typeof value.email !== "string"
    ) throw new Error("INVALID_TEACHER_MAGIC_LINK_REQUEST");
    return parse({ email: value.email.trim().toLowerCase() }, requestValidator, "INVALID_TEACHER_MAGIC_LINK_REQUEST");
  },
  encodeTeacherMagicLinkAccepted(value: unknown): string {
    return JSON.stringify(parse(value, acceptedValidator, "INVALID_TEACHER_MAGIC_LINK_ACCEPTED"));
  },
  parseTeacherMagicLinkAccepted(value: unknown): TeacherMagicLinkAccepted {
    return parse(value, acceptedValidator, "INVALID_TEACHER_MAGIC_LINK_ACCEPTED");
  },
  parseSession(value: unknown): AuthSession {
    return parse(value, sessionValidator, "INVALID_AUTH_SESSION");
  },
  encodeSession(value: unknown): string {
    return JSON.stringify(parse(value, sessionValidator, "INVALID_AUTH_SESSION"));
  },
};
