import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import mediaStatusSchema from "../schemas/media-status.v1.json" with { type: "json" };
import agentStatusSchema from "../schemas/agent-status.v1.json" with { type: "json" };

const addFormats = addFormatsModule as unknown as FormatsPlugin;

export function makeSchemaAjv() {
  const ajv = new Ajv2020({ strict: true, strictNumbers: true, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword({ keyword: "x-learning-orbit-python-ingress", schemaType: "boolean", valid: true });
  // Realtime frames reference this closed, transport-only branch by filename.
  // Register it in the shared factory so callers compiling the realtime schema
  // do not need to maintain a second dependency list.
  ajv.addSchema(mediaStatusSchema);
  ajv.addSchema(agentStatusSchema);
  return ajv;
}
