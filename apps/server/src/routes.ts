import type { FastifyInstance } from "fastify";

import { authContract } from "@learning-orbit/contracts";
import type { MagicLinkService } from "./modules/auth/magic-link-service.js";
import type { SessionService } from "./modules/auth/session-service.js";
import { normalizedRequestIp, ratePolicies } from "./modules/security/rate-policies.js";

interface AuthRouteDependencies {
  magicLinks: MagicLinkService | undefined;
  sessions: SessionService | undefined;
}

const genericAccepted = { accepted: true };
const recoveryBody = "This sign-in link is no longer available. Request a new link.";

function sessionCookie(token: string): { value: string; options: { httpOnly: true; secure: true; sameSite: "lax"; path: "/"; maxAge: number } } {
  return { value: token, options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 8 * 60 * 60 } };
}

export async function registerRoutes(app: FastifyInstance, dependencies: AuthRouteDependencies): Promise<void> {
  app.post("/v1/auth/teacher/magic-link", {
    config: { rateLimit: { ...ratePolicies.magicLink, keyGenerator: normalizedRequestIp } },
  }, async (request, reply) => {
    try {
      const input = authContract.parseTeacherMagicLinkRequest(request.body);
      await dependencies.magicLinks?.request(input.email);
    } catch {
      // The public response intentionally does not distinguish invalid input, lookup, or delivery.
    }
    return reply.code(202).type("application/json").send(authContract.encodeTeacherMagicLinkAccepted(genericAccepted));
  });

  app.get("/v1/auth/teacher/magic-link/consume", async (request, reply) => {
    const query = request.query as { token?: unknown };
    const token = typeof query.token === "string" ? query.token : "";
    const result = await dependencies.magicLinks?.consume(token) ?? null;
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    if (!result) return reply.code(400).type("text/plain; charset=utf-8").send(recoveryBody);
    const cookie = sessionCookie(result.token);
    reply.setCookie("lo_session", cookie.value, cookie.options);
    return reply.code(303).header("Location", "/teacher").send();
  });

  app.get("/v1/auth/session", async (request, reply) => {
    const session = await dependencies.sessions?.get(request.cookies.lo_session);
    if (!session) return reply.code(401).type("application/json").send({ code: "AUTH_REQUIRED" });
    return reply.type("application/json").send(authContract.encodeSession(session));
  });

  app.delete("/v1/auth/session", async (request, reply) => {
    await dependencies.sessions?.revoke(request.cookies.lo_session);
    reply.clearCookie("lo_session", { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    return reply.code(204).send();
  });

}
