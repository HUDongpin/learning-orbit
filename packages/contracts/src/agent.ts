import type { ValidateFunction } from "ajv";
import schema from "../schemas/agent-command.v1.json" with { type: "json" };
import runSchema from "../schemas/agent-run.schema.json" with { type: "json" };
import currentSchema from "../schemas/agent-current-state.v1.json" with { type: "json" };
import healthSchema from "../schemas/agent-provider-health.v1.json" with { type: "json" };
import moderationSchema from "../schemas/moderation-decision.schema.json" with { type: "json" };
import type { ModerationDecision } from "./generated/moderation-decision.schema.js";
import type { AgentCurrentState } from "./generated/agent-current-state.v1.js";
import type { AgentRun } from "./generated/agent-run.schema.js";
import type { AgentSettingsInput, AgentSettingsResponse, AgentRunAccepted, CancelAgentRunAccepted, RequestAgentRunInput, CancelAgentRunInput } from "./generated/agent-command.v1.js";
import type { Request as AgentProviderHealthRequest, Response as AgentProviderHealthResponse } from "./generated/agent-provider-health.v1.js";
import internalSchema from "../schemas/agent-internal-command.v1.json" with { type: "json" };
import type { Request as AgentInternalCommandRequest, Response as AgentInternalCommandResponse } from "./generated/agent-internal-command.v1.js";
import { makeSchemaAjv } from "./schema-ajv.js";

const ajv = makeSchemaAjv();
for (const item of [schema, runSchema, currentSchema, healthSchema, moderationSchema, internalSchema]) ajv.addSchema(item);
function validator<T>(id: string): ValidateFunction<T> {
  const value = ajv.getSchema(id) as ValidateFunction<T> | undefined;
  if (!value) throw new Error("AGENT_SCHEMA_REGISTRATION_FAILED");
  return value;
}
function parse<T>(value: unknown, validate: ValidateFunction<T>, code: string): T {
  if (!validate(value)) throw new Error(code);
  return value;
}
const requestRun = validator<RequestAgentRunInput>(`${schema.$id}#/$defs/RequestAgentRunInput`);
const cancelRun = validator<CancelAgentRunInput>(`${schema.$id}#/$defs/CancelAgentRunInput`);
const accepted = validator<AgentRunAccepted>(`${schema.$id}#/$defs/AgentRunAccepted`);
const cancelAccepted = validator<CancelAgentRunAccepted>(`${schema.$id}#/$defs/CancelAgentRunAccepted`);
const settings = validator<AgentSettingsInput>(`${schema.$id}#/$defs/AgentSettingsInput`);
const settingsResponse = validator<AgentSettingsResponse>(`${schema.$id}#/$defs/AgentSettingsResponse`);
const run = validator<AgentRun>(runSchema.$id);
const current = validator<AgentCurrentState>(currentSchema.$id);
const healthRequest = validator<AgentProviderHealthRequest>(`${healthSchema.$id}#/$defs/Request`);
const healthResponse = validator<AgentProviderHealthResponse>(`${healthSchema.$id}#/$defs/Response`);
const moderation = validator<ModerationDecision>(moderationSchema.$id);
const internalRequest = validator<AgentInternalCommandRequest>(`${internalSchema.$id}#/$defs/Request`);
const internalResponse = validator<AgentInternalCommandResponse>(`${internalSchema.$id}#/$defs/Response`);

export const agentContract = {
  parseRequest(value: unknown) { return parse(value, requestRun, "INVALID_AGENT_COMMAND"); },
  parseCancel(value: unknown) { return parse(value ?? {}, cancelRun, "INVALID_AGENT_COMMAND"); },
  parseAccepted(value: unknown) { return parse(value, accepted, "INVALID_AGENT_RESPONSE"); },
  parseCancelAccepted(value: unknown) { return parse(value, cancelAccepted, "INVALID_AGENT_RESPONSE"); },
  parseSettings(value: unknown) { return parse(value, settings, "INVALID_AGENT_COMMAND"); },
  parseSettingsResponse(value: unknown) { return parse(value, settingsResponse, "INVALID_AGENT_RESPONSE"); },
  parseRun(value: unknown) { return parse(value, run, "INVALID_AGENT_RUN"); },
  parseCurrent(value: unknown) { return parse(value, current, "INVALID_AGENT_CURRENT_STATE"); },
  parseHealthRequest(value: unknown) { return parse(value, healthRequest, "INVALID_AGENT_PROVIDER_HEALTH"); },
  parseHealthResponse(value: unknown) { return parse(value, healthResponse, "INVALID_AGENT_PROVIDER_HEALTH_RESPONSE"); },
  parseModerationDecision(value: unknown) { return parse(value, moderation, "INVALID_MODERATION_DECISION"); },
  parseInternalRequest(value: unknown) { return parse(value, internalRequest, "INVALID_AGENT_INTERNAL_COMMAND"); },
  parseInternalResponse(value: unknown) { return parse(value, internalResponse, "INVALID_AGENT_INTERNAL_RESPONSE"); },
  encodeAccepted(value: unknown) { return JSON.stringify(this.parseAccepted(value)); },
  encodeCancelAccepted(value: unknown) { return JSON.stringify(this.parseCancelAccepted(value)); },
  encodeSettingsResponse(value: unknown) { return JSON.stringify(this.parseSettingsResponse(value)); },
  encodeCurrent(value: unknown) { return JSON.stringify(this.parseCurrent(value)); },
  encodeHealthResponse(value: unknown) { return JSON.stringify(this.parseHealthResponse(value)); },
};

export type { AgentCurrentState } from "./generated/agent-current-state.v1.js";
export type { AgentRun } from "./generated/agent-run.schema.js";
export type { AgentSettingsInput, AgentSettingsResponse, AgentRunAccepted, CancelAgentRunAccepted, RequestAgentRunInput, CancelAgentRunInput } from "./generated/agent-command.v1.js";
export type { Request as AgentProviderHealthRequest, Response as AgentProviderHealthResponse } from "./generated/agent-provider-health.v1.js";
export type { ModerationDecision } from "./generated/moderation-decision.schema.js";
export type { Request as AgentInternalCommandRequest, Response as AgentInternalCommandResponse } from "./generated/agent-internal-command.v1.js";
