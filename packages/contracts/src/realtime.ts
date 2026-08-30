import type { ValidateFunction } from "ajv";
import commandSchema from "../schemas/room-command.v1.json" with { type: "json" };
import envelopeSchema from "../schemas/room-event-envelope.v1.json" with { type: "json" };
import realtimeSchema from "../schemas/realtime-frame.v1.json" with { type: "json" };
import type { RoomCommand } from "./generated/room-command.v1.js";
import type { ClientFrame, RealtimeFrame, ServerFrame } from "./generated/realtime-frame.v1.js";
import { parseCoreRoomEvent } from "./core-room-event.js";
import { makeSchemaAjv } from "./schema-ajv.js";

const ajv = makeSchemaAjv();
ajv.addSchema(commandSchema);
ajv.addSchema(envelopeSchema);
ajv.addSchema(realtimeSchema);

const realtimeValidator = ajv.getSchema(realtimeSchema.$id) as ValidateFunction<RealtimeFrame>;
const clientValidator = ajv.getSchema(`${realtimeSchema.$id}#/$defs/ClientFrame`) as ValidateFunction<ClientFrame>;
const serverValidator = ajv.getSchema(`${realtimeSchema.$id}#/$defs/ServerFrame`) as ValidateFunction<ServerFrame>;
const commandValidator = ajv.getSchema(commandSchema.$id) as ValidateFunction<RoomCommand>;
if (!realtimeValidator || !clientValidator || !serverValidator || !commandValidator) throw new Error("REALTIME_SCHEMA_REGISTRATION_FAILED");

function parse<T>(value: unknown, validator: ValidateFunction<T>, code: string): T {
  if (!validator(value)) throw new Error(code);
  return value;
}

function requireAgentStatusIdentity(frame: RealtimeFrame | ServerFrame, code: string): void {
  if (frame.type !== "agent_status") return;
  const idle = frame.state === "idle";
  if ((idle && (frame.agentRunId !== null || frame.failureCode !== null))
    || (!idle && frame.agentRunId === null)) {
    throw new Error(code);
  }
}

export const realtimeContract = {
  parseRealtimeFrame(value: unknown): RealtimeFrame {
    const frame = parse(value, realtimeValidator, "INVALID_REALTIME_FRAME");
    // Generic realtime and HTTP-page transport validates envelopes and extension events; known core payload semantics live in the registry.
    if (frame.type === "event") parseCoreRoomEvent(frame.event);
    requireAgentStatusIdentity(frame, "INVALID_REALTIME_FRAME");
    return frame;
  },
  parseServerFrame(value: unknown): ServerFrame {
    const frame = parse(value, serverValidator, "INVALID_SERVER_FRAME");
    if (frame.type === "event") parseCoreRoomEvent(frame.event);
    requireAgentStatusIdentity(frame, "INVALID_SERVER_FRAME");
    return frame;
  },
  encodeClientFrame(value: unknown): string {
    return JSON.stringify(parse(value, clientValidator, "INVALID_CLIENT_FRAME"));
  },
  encodeRoomCommand(value: unknown): string {
    return JSON.stringify(parse(value, commandValidator, "INVALID_ROOM_COMMAND"));
  },
};
