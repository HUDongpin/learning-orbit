import type { FastifyRequest } from "fastify";

export function isExactAllowedOrigin(value: string | undefined, allowedOrigins: readonly string[]): boolean {
  return typeof value === "string" && allowedOrigins.includes(value);
}

export function requiresAllowedOrigin(request: FastifyRequest): boolean {
  return !(
    request.method === "GET"
    && request.routeOptions.url === "/v1/auth/teacher/magic-link/consume"
  );
}
