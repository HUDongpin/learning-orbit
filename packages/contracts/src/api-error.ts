import type { ValidateFunction } from "ajv";

import schema from "../schemas/api-error.v1.json" with { type: "json" };
import type { ApiError } from "./generated/api-error.v1.js";
import { makeSchemaAjv } from "./schema-ajv.js";

const ajv = makeSchemaAjv();
const validate = ajv.compile(schema) as ValidateFunction<ApiError>;

export const apiErrorContract = {
  parse(value: unknown): ApiError {
    if (!validate(value)) throw new Error("INVALID_API_ERROR");
    return value;
  },
};
