import type { FastifyInstance } from "fastify";
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
  app.delete("/v1/rooms/:roomId", async (request, reply) => {
    const principal = await sessions.get(request.cookies.lo_session);
    try {
      const roomId = (request.params as { roomId?: string }).roomId ?? "";
      const result = await service.requestDeletion(principal, roomId, request.body);
      return reply.code(202).type("application/json").send(result);
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/v1/deletions/:deletionJobId", async (request, reply) => {
    const principal = await sessions.get(request.cookies.lo_session);
    try {
      const id = (request.params as { deletionJobId?: string }).deletionJobId ?? "";
      return reply.type("application/json").send(await service.deletionStatus(principal, id));
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/v1/rooms/:roomId/deletion", async (request, reply) => {
    const principal = await sessions.get(request.cookies.lo_session);
    try {
      const roomId = (request.params as { roomId?: string }).roomId ?? "";
      return reply.type("application/json").send(await service.deletionStatusForRoom(principal, roomId));
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/v1/rooms/:roomId/export", async (request, reply) => {
    const principal = await sessions.get(request.cookies.lo_session);
    try {
      const query = request.query as Record<string, unknown>;
      const format = query.format === "json" ? "json" : query.format === "csv" ? "csv" : null;
      if (Object.keys(query).some((key) => key !== "format") || !format) {
        throw new GovernanceError("INVALID_EXPORT_FORMAT", 400);
      }
      const roomId = (request.params as { roomId?: string }).roomId ?? "";
      const result = await service.exportRoom(principal, roomId, format);
      return reply.header("Cache-Control", "no-store").header("Content-Disposition", `attachment; filename="${result.filename}"`)
        .type(result.contentType).send(result.body);
    } catch (error) { return sendError(reply, error); }
  });
}
