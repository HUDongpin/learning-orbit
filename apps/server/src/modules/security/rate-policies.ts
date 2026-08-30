import { normalizeIP } from "@fastify/rate-limit";
import type { FastifyRequest } from "fastify";

export const ratePolicies = {
  magicLink: { max: 5, timeWindow: "15 minutes" },
  failedJoin: { max: 10, timeWindow: "10 minutes" },
  agentTrigger: { max: 3, timeWindow: "1 minute" },
} as const;

export function closedRateLimitError(
  _request: FastifyRequest,
  context: Readonly<{ statusCode: number }>,
): Readonly<{ code: "RATE_LIMITED"; statusCode: number }> {
  const body = { code: "RATE_LIMITED" } as { code: "RATE_LIMITED"; statusCode: number };
  Object.defineProperty(body, "statusCode", {
    configurable: false,
    enumerable: false,
    value: context.statusCode,
    writable: false,
  });
  return body;
}

export function normalizedRequestIp(request: FastifyRequest): string {
  return normalizeRateIp(request.ip);
}

export function normalizeRateIp(ip: string): string {
  return normalizeIP(ip, 64);
}

export function agentRateKey(request: FastifyRequest): string {
  const query = request.query as { roomId?: unknown; actorId?: unknown };
  const roomId = typeof query.roomId === "string" && /^[0-9a-z-]{1,64}$/i.test(query.roomId) ? query.roomId : undefined;
  const actorId = typeof query.actorId === "string" && /^[0-9a-z-]{1,64}$/i.test(query.actorId) ? query.actorId : undefined;
  if (!roomId || !actorId) throw new Error("AGENT_RATE_KEY_INVALID");
  return `${roomId}:${actorId}`;
}
