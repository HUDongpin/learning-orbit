import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats").default;

export function makeSchemaAjv() {
  const ajv = new Ajv2020({ strict: true, strictNumbers: true, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword({ keyword: "x-learning-orbit-python-ingress", schemaType: "boolean", valid: true });
  return ajv;
}
