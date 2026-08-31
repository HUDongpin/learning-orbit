import type { FastifyRequest } from "fastify";

export function isExactAllowedOrigin(value: string | undefined, allowedOrigins: readonly string[]): boolean {
  return typeof value === "string" && allowedOrigins.includes(value);
}

export function requiresAllowedOrigin(request: FastifyRequest): boolean {
  if (request.method === "POST" && [
    "/internal/rooms/auto-close",
    "/internal/media/reconcile-upload",
  ].includes(request.routeOptions.url ?? "")) return false;
  if (request.headers.upgrade?.toLowerCase() === "websocket") return true;
  return !["GET", "OPTIONS"].includes(request.method);
}
