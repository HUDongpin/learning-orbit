import type { ValidateFunction } from "ajv";

import schema from "../schemas/media-command.schema.json" with { type: "json" };
import type {
  CompleteMediaUploadResponse,
  MediaDownloadGrant,
  MediaUploadGrant,
} from "./generated/media-command.schema.js";
import { makeSchemaAjv } from "./schema-ajv.js";

const ajv = makeSchemaAjv();
ajv.addSchema(schema);

function validator<T>(definition: string): ValidateFunction<T> {
  const value = ajv.getSchema(`${schema.$id}#/$defs/${definition}`) as ValidateFunction<T> | undefined;
  if (!value) throw new Error("MEDIA_COMMAND_SCHEMA_REGISTRATION_FAILED");
  return value;
}

const createUploadValidator = validator<Record<string, unknown>>("CreateMediaUploadInput");
const uploadGrantValidator = validator<MediaUploadGrant>("MediaUploadGrant");
const downloadGrantValidator = validator<MediaDownloadGrant>("MediaDownloadGrant");
const completeValidator = validator<CompleteMediaUploadResponse>("CompleteMediaUploadResponse");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function parse<T>(value: unknown, validate: ValidateFunction<T>, code: string): T {
  if (!isPlainObject(value) || !validate(value)) throw new Error(code);
  return value;
}

export const mediaCommandContract = {
  parseCreateUpload(value: unknown): Record<string, unknown> {
    const parsed = parse(value, createUploadValidator, "INVALID_MEDIA_COMMAND");
    if (parsed.kind === "image" && (typeof parsed.altText !== "string" || parsed.altText.trim().length === 0)) {
      throw new Error("INVALID_MEDIA_COMMAND");
    }
    return parsed;
  },
  parseUploadGrant(value: unknown): MediaUploadGrant {
    return parse(value, uploadGrantValidator, "INVALID_MEDIA_UPLOAD_GRANT");
  },
  parseDownloadGrant(value: unknown): MediaDownloadGrant {
    return parse(value, downloadGrantValidator, "INVALID_MEDIA_DOWNLOAD_GRANT");
  },
  parseComplete(value: unknown): CompleteMediaUploadResponse {
    return parse(value, completeValidator, "INVALID_MEDIA_COMPLETE_RESPONSE");
  },
  encodeUploadGrant(value: unknown): string {
    return JSON.stringify(this.parseUploadGrant(value));
  },
  encodeDownloadGrant(value: unknown): string {
    return JSON.stringify(this.parseDownloadGrant(value));
  },
  encodeComplete(value: unknown): string {
    return JSON.stringify(this.parseComplete(value));
  },
};

export type {
  CompleteMediaUploadResponse,
  CreateMediaUploadInput,
  MediaDownloadGrant,
  MediaUploadGrant,
} from "./generated/media-command.schema.js";
