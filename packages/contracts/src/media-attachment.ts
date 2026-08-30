import type { ValidateFunction } from "ajv";

import schema from "../schemas/media-attachment-view.v1.json" with { type: "json" };
import type { MediaAttachmentView } from "./generated/media-attachment-view.v1.js";
import { makeSchemaAjv } from "./schema-ajv.js";

const ajv = makeSchemaAjv();
ajv.addSchema(schema);
const schemaValidator = ajv.getSchema(schema.$id) as ValidateFunction<MediaAttachmentView> | undefined;
if (!schemaValidator) throw new Error("MEDIA_ATTACHMENT_SCHEMA_REGISTRATION_FAILED");
const validator: ValidateFunction<MediaAttachmentView> = schemaValidator;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function parse(value: unknown): MediaAttachmentView {
  if (!isPlainObject(value) || !validator(value)) throw new Error("INVALID_MEDIA_ATTACHMENT_VIEW");
  if (value.kind === "image" && (typeof value.altText !== "string" || value.altText.trim().length === 0)) {
    throw new Error("INVALID_MEDIA_ATTACHMENT_VIEW");
  }
  return value as MediaAttachmentView;
}

export const mediaAttachmentContract = {
  parse,
  encode(value: unknown): string {
    return JSON.stringify(parse(value));
  },
};

export type { MediaAttachmentView } from "./generated/media-attachment-view.v1.js";
