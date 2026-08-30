import type { ValidateFunction } from "ajv";

import schema from "../schemas/media-status.v1.json" with { type: "json" };
import type { MediaStatusFrame } from "./generated/media-status.v1.js";
import { makeSchemaAjv } from "./schema-ajv.js";

const ajv = makeSchemaAjv();
const validator = ajv.getSchema(schema.$id) as ValidateFunction<MediaStatusFrame> | undefined;
if (!validator) throw new Error("MEDIA_STATUS_SCHEMA_REGISTRATION_FAILED");

export const mediaStatusContract = {
  parse(value: unknown): MediaStatusFrame {
    if (!validator(value)) throw new Error("INVALID_MEDIA_STATUS");
    return value;
  },
  encode(value: unknown): string {
    return JSON.stringify(this.parse(value));
  },
};

export type { MediaStatusFrame } from "./generated/media-status.v1.js";
