import type { ValidateFunction } from "ajv";

import schema from "../schemas/lifecycle-internal-media-surface.v1.json" with { type: "json" };
import type {
  Request,
  Response,
} from "./generated/lifecycle-internal-media-surface.v1.js";
import { makeSchemaAjv } from "./schema-ajv.js";

const ajv = makeSchemaAjv();
ajv.addSchema(schema);

function validator<T>(definition: string): ValidateFunction<T> {
  const value = ajv.getSchema(`${schema.$id}#/$defs/${definition}`) as ValidateFunction<T> | undefined;
  if (!value) throw new Error("LIFECYCLE_INTERNAL_MEDIA_SURFACE_SCHEMA_REGISTRATION_FAILED");
  return value;
}

const requestValidator = validator<Request>("Request");
const responseValidator = validator<Response>("Response");

export const lifecycleInternalMediaSurfaceContract = {
  parseRequest(value: unknown): Request {
    if (!requestValidator(value)) throw new Error("INVALID_LIFECYCLE_INTERNAL_MEDIA_SURFACE_REQUEST");
    return value;
  },
  parseResponse(value: unknown): Response {
    if (!responseValidator(value)) throw new Error("INVALID_LIFECYCLE_INTERNAL_MEDIA_SURFACE_RESPONSE");
    return value;
  },
  encodeResponse(value: unknown): string {
    return JSON.stringify(this.parseResponse(value));
  },
};

export type {
  Request as LifecycleInternalMediaSurfaceRequest,
  Response as LifecycleInternalMediaSurfaceResponse,
} from "./generated/lifecycle-internal-media-surface.v1.js";
