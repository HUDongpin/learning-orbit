import type { ValidateFunction } from "ajv";
import envelopeSchema from "../schemas/room-event-envelope.v1.json" with { type: "json" };
import type { RoomEventEnvelope } from "./generated/room-event-envelope.v1.js";
import type {
  MessageAddedPayload,
  MessageRetractedPayload,
  MessageRevisedPayload,
  RoomClosedPayload,
  RoomOpenedPayload,
  RoomPausedPayload,
  RoomResumedPayload,
} from "./generated/core-room-event-payloads.v1.js";
import { createCoreEventPayloadRegistry, EventPayloadRegistry } from "./event-payload-registry.js";
import { makeSchemaAjv } from "./schema-ajv.js";

type CoreEvent<T extends string, Payload> = Omit<RoomEventEnvelope, "type" | "payload"> & { type: T; payload: Payload };

export type CoreRoomEvent =
  | CoreEvent<"room.opened", RoomOpenedPayload>
  | CoreEvent<"room.paused", RoomPausedPayload>
  | CoreEvent<"room.resumed", RoomResumedPayload>
  | CoreEvent<"room.closed", RoomClosedPayload>
  | CoreEvent<"message.added", MessageAddedPayload>
  | CoreEvent<"message.revised", MessageRevisedPayload>
  | CoreEvent<"message.retracted", MessageRetractedPayload>;

const coreTypes = [
  "room.opened", "room.paused", "room.resumed", "room.closed",
  "message.added", "message.revised", "message.retracted",
] as const satisfies readonly CoreRoomEvent["type"][];
const coreTypeSet = new Set<string>(coreTypes);
const corePayloads: EventPayloadRegistry = createCoreEventPayloadRegistry();
const ajv = makeSchemaAjv();
ajv.addSchema(envelopeSchema);
const envelopeValidator = ajv.getSchema(envelopeSchema.$id) as ValidateFunction<RoomEventEnvelope>;
if (!envelopeValidator) throw new Error("ROOM_EVENT_SCHEMA_REGISTRATION_FAILED");

export function parseCoreRoomEvent(input: unknown): CoreRoomEvent | null {
  if (!envelopeValidator(input)) throw new Error("INVALID_ROOM_EVENT");
  const envelope = input as RoomEventEnvelope;
  if (!coreTypeSet.has(envelope.type)) return null;
  corePayloads.assert(envelope.type, envelope.payload);
  return envelope as unknown as CoreRoomEvent;
}
