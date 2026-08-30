import type { FastifyInstance } from "fastify";

import { authContract, roomHttpContract } from "@learning-orbit/contracts";
import type { MagicLinkService } from "./modules/auth/magic-link-service.js";
import type { SessionService } from "./modules/auth/session-service.js";
import { RoomServiceError, type RoomService } from "./modules/rooms/room-service.js";
import { RoomError } from "./modules/rooms/errors.js";
import { normalizedRequestIp, ratePolicies } from "./modules/security/rate-policies.js";
import type { RoomLifecycleService } from "./modules/rooms/lifecycle-service.js";
import { InternalAutoCloseRoute } from "./modules/rooms/internal-auto-close-route.js";
import type { ServiceAssertionTrust } from "./modules/security/service-assertion.js";
import {
  roomInternalAutoCloseContract,
  routes,
  type RoomInternalAutoCloseResponse,
} from "@learning-orbit/contracts";
import type { JobClaimAuthority } from "./modules/jobs/job-claim-authority.js";
import type { CommandService } from "./modules/rooms/command-service.js";
import type { RoomHub } from "./modules/realtime/room-hub.js";
import type { RealtimeDeliveryAuthorizer } from "./modules/realtime/realtime-delivery-authorizer.js";
import type { OutboxPublisher } from "./modules/realtime/outbox-publisher.js";
import type { SocketLike } from "./modules/realtime/connection.js";
import { registerMediaRoutes } from "./modules/media/media-routes.js";
import type { MediaDeps } from "./modules/media/media-service.js";
import type { MediaInternalReconcileRoute } from "./modules/media/media-internal-reconcile-route.js";

interface AuthRouteDependencies {
  magicLinks: MagicLinkService | undefined;
  sessions: SessionService | undefined;
  rooms: RoomService | undefined;
  lifecycle: RoomLifecycleService | undefined;
  serviceAssertionTrust: ServiceAssertionTrust | undefined;
  jobClaims: JobClaimAuthority;
  commands: CommandService | undefined;
  realtime: { hub: RoomHub; authorizer: RealtimeDeliveryAuthorizer; publisher: OutboxPublisher } | undefined;
  media: MediaDeps | undefined;
  mediaInternalReconcile: MediaInternalReconcileRoute | undefined;
}

const genericAccepted = { accepted: true };
const recoveryBody = "This sign-in link is no longer available. Request a new link.";

function sessionCookie(token: string): { value: string; options: { httpOnly: true; secure: true; sameSite: "lax"; path: "/"; maxAge: number } } {
  return { value: token, options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 8 * 60 * 60 } };
}

export async function registerRoutes(app: FastifyInstance, dependencies: AuthRouteDependencies): Promise<void> {
  const failedJoinLimit = app.createRateLimit({
    ...ratePolicies.failedJoin,
    keyGenerator: normalizedRequestIp,
  });

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

  app.post("/v1/rooms", async (request, reply) => {
    const identity = await dependencies.sessions?.get(request.cookies.lo_session);
    if (!identity) return reply.code(401).type("application/json").send({ code: "AUTH_REQUIRED" });
    if (!dependencies.rooms) {
      return reply.code(503).type("application/json").send({ code: "ROOM_SERVICE_UNAVAILABLE" });
    }
    try {
      const result = await dependencies.rooms.createRoom(identity, request.body);
      return reply.code(201).type("application/json")
        .send(roomHttpContract.encodeCreateRoomResponse(result));
    } catch (error) {
      if (error instanceof RoomServiceError && error.code === "ROOM_FORBIDDEN") {
        return reply.code(403).type("application/json").send({ code: "ROOM_FORBIDDEN" });
      }
      if (error instanceof RoomServiceError && error.code === "ROOM_CODE_UNAVAILABLE") {
        return reply.code(503).type("application/json").send({ code: "ROOM_CODE_UNAVAILABLE" });
      }
      if (error instanceof Error && error.message === "INVALID_CREATE_ROOM_REQUEST") {
        return reply.code(400).type("application/json").send({ code: "INVALID_ROOM_REQUEST" });
      }
      throw error;
    }
  });

  app.post("/v1/rooms/join", async (request, reply) => {
    if (!dependencies.rooms) {
      return reply.code(503).type("application/json").send({ code: "ROOM_SERVICE_UNAVAILABLE" });
    }
    const limit = await failedJoinLimit(request, { increment: false });
    if (!limit.isAllowed && limit.isExceeded) {
      return reply.code(429).type("application/json").send({ code: "RATE_LIMITED" });
    }
    try {
      const joined = await dependencies.rooms.joinRoom(request.body);
      const cookie = sessionCookie(joined.sessionToken);
      reply.setCookie("lo_session", cookie.value, cookie.options);
      return reply.type("application/json")
        .send(roomHttpContract.encodeJoinRoomResponse(joined.response));
    } catch (error) {
      const isInvalid = error instanceof Error && error.message === "INVALID_JOIN_ROOM_REQUEST";
      const isForbidden = error instanceof RoomServiceError && error.code === "JOIN_FORBIDDEN";
      if (isInvalid || isForbidden) {
        const consumed = await failedJoinLimit(request);
        if (!consumed.isAllowed && consumed.isExceeded) {
          return reply.code(429).type("application/json").send({ code: "RATE_LIMITED" });
        }
      }
      if (isInvalid) {
        return reply.code(400).type("application/json").send({ code: "INVALID_JOIN_REQUEST" });
      }
      if (isForbidden) {
        return reply.code(403).type("application/json").send({ code: "JOIN_FORBIDDEN" });
      }
      throw error;
    }
  });

  app.post("/v1/rooms/:roomId/commands", async (request, reply) => {
    const identity = await dependencies.sessions?.get(request.cookies.lo_session);
    if (!identity) return reply.code(401).send({ code: "AUTH_REQUIRED" });
    if (!dependencies.commands) return reply.code(503).send({ code: "ROOM_SERVICE_UNAVAILABLE" });
    const pathRoomId = (request.params as { roomId?: string }).roomId;
    if (typeof pathRoomId !== "string" || (request.body as { roomId?: string })?.roomId !== pathRoomId) return reply.code(409).send({ code: "INVALID_COMMAND" });
    try {
      const sessionId = await dependencies.sessions?.getSessionId(request.cookies.lo_session);
      if (!sessionId) return reply.code(401).type("application/json").send({ code: "AUTH_REQUIRED" });
      const result = await dependencies.commands.dispatch(identity, request.body, sessionId);
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof RoomError) {
        const body = error.currentRevision === undefined
          ? { code: error.code }
          : { code: error.code, currentRevision: error.currentRevision };
        return reply.code(error.code === "FORBIDDEN" ? 403 : 409)
          .type("application/json").send(body);
      }
      return reply.code(500).type("application/json").send({ code: "INTERNAL" });
    }
  });

  app.get("/v1/rooms/:roomId", async (request, reply) => {
    const identity = await dependencies.sessions?.get(request.cookies.lo_session);
    if (!identity) return reply.code(401).type("application/json").send({ code: "AUTH_REQUIRED" });
    if (!dependencies.rooms) {
      return reply.code(503).type("application/json").send({ code: "ROOM_SERVICE_UNAVAILABLE" });
    }
    const params = request.params as { roomId?: unknown };
    const roomId = typeof params.roomId === "string" ? params.roomId : "";
    try {
      const details = await dependencies.rooms.getRoom(identity, roomId);
      return reply.type("application/json").send(roomHttpContract.encodeRoomDetails(details));
    } catch (error) {
      if (error instanceof RoomServiceError && error.code === "ROOM_NOT_FOUND") {
        return reply.code(404).type("application/json").send({ code: "ROOM_NOT_FOUND" });
      }
      throw error;
    }
  });

  app.get("/v1/rooms/:roomId/events", async (request, reply) => {
    const roomId = (request.params as { roomId?: string }).roomId ?? "";
    const identity = await dependencies.sessions?.get(request.cookies.lo_session);
    if (!identity) return reply.code(401).send({ code: "AUTH_REQUIRED" });
    const token = request.cookies.lo_session;
    const auth = await dependencies.realtime?.authorizer.authenticateToken(token, roomId);
    if (!auth?.ok) return reply.code(auth?.closeCode === 4403 ? 403 : 401).send({ code: auth?.closeCode === 4403 ? "FORBIDDEN" : "AUTH_REQUIRED" });
    if (!dependencies.lifecycle) return reply.code(503).send({ code: "ROOM_SERVICE_UNAVAILABLE" });
    const query = request.query as { afterSeq?: string; limit?: string };
    const afterSeq = query.afterSeq === undefined ? 0 : Number(query.afterSeq);
    const limit = query.limit === undefined ? 500 : Number(query.limit);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) return reply.code(400).send({ code: "INVALID_QUERY" });
    const events = await dependencies.lifecycle.events.eventsAfter(roomId, afterSeq, limit);
    const throughRoomSeq = events.length ? events[events.length - 1]!.roomSeq : afterSeq;
    return reply.type("application/json").send(roomHttpContract.encodeRoomEventPage({ events, throughRoomSeq, ...(events.length === limit ? { nextAfterSeq: throughRoomSeq } : {}) }));
  });

  if (dependencies.realtime && dependencies.sessions && dependencies.commands) {
    const websocketHandler = async (socket: any, request: any) => {
      const roomId = (request.params as { roomId?: string }).roomId ?? "";
      const auth = await dependencies.realtime!.authorizer.authenticateToken(request.cookies.lo_session, roomId);
      if (!auth.ok || !auth.sessionId) { socket.close(auth.ok ? 4401 : auth.closeCode, "authorization required"); return; }
      dependencies.realtime!.hub.connect(socket as unknown as SocketLike, { sessionId: auth.sessionId, roomId, principal: auth.principal, actorId: auth.actorId }, dependencies.commands!);
    };
    app.get("/v1/rooms/:roomId/realtime", { websocket: true }, websocketHandler);
    app.get("/v1/rooms/:roomId/ws", { websocket: true }, websocketHandler);
  }

  if (dependencies.lifecycle && dependencies.serviceAssertionTrust) {
    const internal = new InternalAutoCloseRoute(
      dependencies.lifecycle.events,
      dependencies.lifecycle.clock,
      dependencies.serviceAssertionTrust,
      dependencies.jobClaims,
    );
    app.post(routes.internal.rooms.autoClose(), async (request, reply) => {
      const assertion = request.headers["x-lo-service-assertion"];
      let result: RoomInternalAutoCloseResponse;
      try {
        result = await internal.handle(assertion, request.body);
      } catch {
        // Internal failures are deliberately content-free at the HTTP boundary.
        // Do not let Fastify serialize database/validation details from an
        // assertion-bearing request; the worker can retry from its claim.
        return reply.code(500).type("application/json").send({ code: "INTERNAL" });
      }
      const status = result.status === "completed" || result.status === "retryable" ? 200
        : result.code === "SERVICE_ASSERTION_INVALID" ? 401 : 409;
      return reply.code(status).type("application/json").send(JSON.parse(roomInternalAutoCloseContract.encodeResponse(result)));
    });
  }

  if (dependencies.media) {
    await registerMediaRoutes(app, {
      media: dependencies.media,
      sessions: dependencies.sessions,
      internalReconcile: dependencies.mediaInternalReconcile,
    });
  }

}
