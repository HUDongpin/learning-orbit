import type { FastifyRequest } from "fastify";

import { routes } from "@learning-orbit/contracts";

export function isExactAllowedOrigin(value: string | undefined, allowedOrigins: readonly string[]): boolean {
  return typeof value === "string" && allowedOrigins.includes(value);
}

/**
 * Every canonical internal path, read from the route table rather than
 * restated here. A hand-kept list silently locks out each new worker route -
 * the provider-health probe was already unreachable behind one - so the
 * exemption is derived from the same builders the routes register.
 */
function canonicalInternalPaths(): ReadonlySet<string> {
  const paths = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === "function") {
      const value = (node as () => unknown)();
      if (typeof value === "string" && value.startsWith("/internal/")) paths.add(value);
      return;
    }
    if (node !== null && typeof node === "object") for (const child of Object.values(node)) walk(child);
  };
  walk(routes.internal);
  if (paths.size === 0) throw new Error("INTERNAL_ROUTE_TABLE_EMPTY");
  return paths;
}

const INTERNAL_PATHS = canonicalInternalPaths();

export function isInternalRoutePath(value: string | undefined): boolean {
  return typeof value === "string" && INTERNAL_PATHS.has(value);
}

export function requiresAllowedOrigin(request: FastifyRequest): boolean {
  // Internal routes are authenticated by a signed service assertion, never by
  // a browser Origin, and a worker sends none.
  if (request.method === "POST" && isInternalRoutePath(request.routeOptions.url)) return false;
  if (request.headers.upgrade?.toLowerCase() === "websocket") return true;
  return !["GET", "OPTIONS"].includes(request.method);
}

/**
 * A request carrying any browser Origin is, by construction, not the worker.
 * Internal routes refuse it even when the origin is one the product allows,
 * so a page on the product origin can never reach the worker surface.
 */
export function forbidsAnyOrigin(request: FastifyRequest): boolean {
  return isInternalRoutePath(request.routeOptions.url);
}
