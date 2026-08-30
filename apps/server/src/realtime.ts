import type { FastifyRequest } from "fastify";

import { isExactAllowedOrigin } from "./modules/security/origin-policy.js";
export { RoomHub } from "./modules/realtime/room-hub.js";
export { RealtimeConnection } from "./modules/realtime/connection.js";
export { EphemeralSignals } from "./modules/realtime/ephemeral-signals.js";
export { RealtimeDeliveryAuthorizer } from "./modules/realtime/realtime-delivery-authorizer.js";
export { OutboxPublisher } from "./modules/realtime/outbox-publisher.js";

/** Reused by the later websocket registration; no socket endpoint exists in Task 4. */
export function assertRealtimeOrigin(request: FastifyRequest, allowedOrigins: readonly string[]): void {
  if (!isExactAllowedOrigin(request.headers.origin, allowedOrigins)) throw new Error("ORIGIN_FORBIDDEN");
}
