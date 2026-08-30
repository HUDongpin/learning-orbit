import type { FastifyRequest } from "fastify";

import { isExactAllowedOrigin } from "./modules/security/origin-policy.js";

/** Reused by the later websocket registration; no socket endpoint exists in Task 4. */
export function assertRealtimeOrigin(request: FastifyRequest, allowedOrigins: readonly string[]): void {
  if (!isExactAllowedOrigin(request.headers.origin, allowedOrigins)) throw new Error("ORIGIN_FORBIDDEN");
}
