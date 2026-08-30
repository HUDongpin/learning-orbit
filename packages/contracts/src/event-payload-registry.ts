import type { AnySchema, ValidateFunction } from "ajv";
import catalog from "../schemas/core-room-event-payloads.v1.json" with { type: "json" };
import { makeSchemaAjv } from "./schema-ajv.js";

const eventType = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/;
const corePayloadNames = {
  "room.opened": "RoomOpenedPayload",
  "room.paused": "RoomPausedPayload",
  "room.resumed": "RoomResumedPayload",
  "room.closed": "RoomClosedPayload",
  "message.added": "MessageAddedPayload",
  "message.revised": "MessageRevisedPayload",
  "message.retracted": "MessageRetractedPayload",
} as const;

export class EventPayloadRegistry {
  private readonly ajv = makeSchemaAjv();
  private readonly validators = new Map<string, ValidateFunction>();

  register(type: string, schema: AnySchema): this {
    if (!eventType.test(type)) throw new Error(`INVALID_EVENT_TYPE_NAME:${type}`);
    if (this.validators.has(type)) throw new Error(`EVENT_TYPE_ALREADY_REGISTERED:${type}`);
    this.validators.set(type, this.ajv.compile(schema));
    return this;
  }

  assert(type: string, payload: unknown): asserts payload {
    const validator = this.validators.get(type);
    if (!validator) throw new Error(`UNKNOWN_EVENT_TYPE:${type}`);
    if (!validator(payload)) throw new Error(`INVALID_EVENT_PAYLOAD:${type}`);
  }
}

export function createCoreEventPayloadRegistry(): EventPayloadRegistry {
  const registry = new EventPayloadRegistry();
  const definitions = catalog.$defs as Record<string, AnySchema>;
  for (const [type, definition] of Object.entries(corePayloadNames)) {
    const payloadSchema = definitions[definition];
    if (!payloadSchema || typeof payloadSchema !== "object") throw new Error(`CORE_PAYLOAD_SCHEMA_MISSING:${definition}`);
    registry.register(type, { ...payloadSchema, $defs: { ...definitions } });
  }
  return registry;
}
