import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthSession } from "@learning-orbit/contracts";
import type { SessionService } from "../auth/session-service.js";
import { GovernanceError, GovernanceService } from "./governance-service.js";

function sendError(reply: any, error: unknown) {
  if (error instanceof GovernanceError) return reply.code(error.statusCode).type("application/json").send({ code: error.code });
  return reply.code(500).type("application/json").send({ code: "INTERNAL" });
}

/**
 * Register the teacher-owned lifecycle boundary.  The service performs the
 * second authorization check inside the room transaction; these handlers do
 * not trust actor IDs, room IDs, or ownership supplied by a browser.
 */
export async function registerGovernanceRoutes(
  app: FastifyInstance,
  service: GovernanceService,
  sessions: SessionService,
): Promise<void> {
  const deletionAuth = new WeakMap<object, AuthSession>();
  const authenticateDeletion = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const principal = await sessions.get(request.cookies.lo_session);
      const roomId = (request.params as { roomId?: string }).roomId ?? "";
      if (!principal) return reply.code(401).type("application/json").send({ code: "AUTH_REQUIRED" });
      await service.authorizeRoom(principal, roomId);
      deletionAuth.set(request, principal);
    } catch (error) { return sendError(reply, error); }
  };
  const deletionBodyError = (error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    if (["FST_ERR_CTP_INVALID_JSON_BODY", "FST_ERR_CTP_EMPTY_JSON_BODY"].includes(error.code)) {
      return reply.code(400).type("application/json").send({ code: "INVALID_DELETE_REQUEST" });
    }
    return reply.code(500).type("application/json").send({ code: "INTERNAL" });
  };
  app.delete("/v1/rooms/:roomId", {
    onRequest: authenticateDeletion,
    errorHandler: deletionBodyError,
  }, async (request, reply) => {
    const principal = deletionAuth.get(request);
    if (!principal) return reply.code(500).type("application/json").send({ code: "INTERNAL" });
    try {
      const roomId = (request.params as { roomId?: string }).roomId ?? "";
      const result = await service.requestDeletion(principal, roomId, request.body);
      return reply.code(202).type("application/json").send(result);
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/v1/deletions/:deletionJobId", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const principal = await sessions.get(request.cookies.lo_session);
      const id = (request.params as { deletionJobId?: string }).deletionJobId ?? "";
      return reply.type("application/json").send(await service.deletionStatus(principal, id));
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/v1/rooms/:roomId/deletion", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const principal = await sessions.get(request.cookies.lo_session);
      const roomId = (request.params as { roomId?: string }).roomId ?? "";
      return reply.type("application/json").send(await service.deletionStatusForRoom(principal, roomId));
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/v1/rooms/:roomId/export", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const principal = await sessions.get(request.cookies.lo_session);
      const roomId = (request.params as { roomId?: string }).roomId ?? "";
      const result = await service.exportRoom(principal, roomId, request.query);
      return reply.header("Content-Disposition", `attachment; filename="${result.filename}"`)
        .type(result.contentType).send(result.body);
    } catch (error) { return sendError(reply, error); }
  });
}
