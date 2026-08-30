import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import {
  mediaAttachmentContract,
  mediaCommandContract,
  mediaInternalReconcileContract,
  routes,
  type AuthSession,
} from "@learning-orbit/contracts";
import type { SessionService } from "../auth/session-service.js";
import {
  createDownloadGrant,
  createUploadGrant,
  finalizeUpload,
  getMediaAttachment,
  type MediaDeps,
} from "./media-service.js";
import { MediaError } from "./media-errors.js";
import { MediaInternalReconcileRoute } from "./media-internal-reconcile-route.js";

export interface MediaRouteDependencies {
  readonly media: MediaDeps | undefined;
  readonly sessions: SessionService | undefined;
  readonly internalReconcile: MediaInternalReconcileRoute | undefined;
}

function pathWithParams(path: string): string {
  return path;
}

function sessionFromRequest(request: { cookies: Record<string, string | undefined> }, sessions: SessionService | undefined): Promise<AuthSession | null> {
  return sessions?.get(request.cookies.lo_session) ?? Promise.resolve(null);
}

async function sessionIdentity(request: { cookies: Record<string, string | undefined> }, sessions: SessionService | undefined): Promise<{ identity: AuthSession; sessionId: string } | null> {
  const token = request.cookies.lo_session;
  const identity = await sessionFromRequest(request, sessions);
  if (!identity || !sessions) return null;
  const sessionId = await sessions.getSessionId(token);
  return sessionId ? { identity, sessionId } : null;
}

async function safeSessionIdentity(
  request: { cookies: Record<string, string | undefined> },
  sessions: SessionService | undefined,
): Promise<{ identity: AuthSession; sessionId: string } | null | "failed"> {
  try { return await sessionIdentity(request, sessions); }
  catch { return "failed"; }
}

export function mediaRouteError(error: unknown): { status: number; body: { code: string } } {
  const code = error instanceof MediaError ? String(error.code) : error instanceof Error ? error.message : "";
  if (code === "STORAGE_NOT_CONFIGURED" || code.startsWith("STORAGE_")) {
    return { status: 503, body: { code: "MEDIA_SERVICE_UNAVAILABLE" } };
  }
  const publicStatus: Readonly<Record<string, number>> = {
    AUTH_REQUIRED: 401,
    INVALID_MEDIA_COMMAND: 400,
    MEDIA_NOT_FOUND: 404,
    MEDIA_UPLOAD_NOT_FOUND: 404,
    ALT_REQUIRED: 422,
    SIZE_OUT_OF_RANGE: 422,
    MEDIA_UPLOAD_EXPIRED: 409,
    MEDIA_UPLOAD_NOT_SETTLED: 409,
    MEDIA_QUARANTINED: 409,
    MEDIA_FAILED: 409,
    MEDIA_DELETED: 409,
    MEDIA_NOT_READY: 409,
    ROOM_DELETION_IN_PROGRESS: 409,
    ROOM_NOT_OPEN: 409,
  };
  if (error instanceof MediaError && publicStatus[code] !== undefined) {
    return { status: publicStatus[code]!, body: { code } };
  }
  if (error instanceof Error && ["INVALID_MEDIA_COMMAND", "ALT_REQUIRED", "SIZE_OUT_OF_RANGE"].includes(error.message)) {
    return { status: error.message === "INVALID_MEDIA_COMMAND" ? 400 : 422, body: { code: error.message } };
  }
  return { status: 500, body: { code: "INTERNAL" } };
}

function correlationId(): string {
  return randomUUID();
}

export async function registerMediaRoutes(
  app: FastifyInstance,
  dependencies: MediaRouteDependencies,
): Promise<void> {
  app.post(pathWithParams("/v1/rooms/:roomId/media/uploads"), async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authenticated = await safeSessionIdentity(request, dependencies.sessions);
    if (authenticated === "failed") return reply.code(500).type("application/json").send({ code: "INTERNAL" });
    if (!authenticated) return reply.code(401).type("application/json").send({ code: "AUTH_REQUIRED" });
    const { identity, sessionId } = authenticated;
    if (!dependencies.media) return reply.code(503).type("application/json").send({ code: "MEDIA_SERVICE_UNAVAILABLE" });
    const params = request.params as { roomId?: unknown };
    const roomId = typeof params.roomId === "string" ? params.roomId : "";
    try {
      const body = mediaCommandContract.parseCreateUpload(request.body);
      const grant = await createUploadGrant(dependencies.media, {
        principal: identity,
        sessionId,
        roomId,
        correlationId: correlationId(),
        kind: body.kind as "image" | "audio",
        originalFileName: body.originalFileName as string,
        mime: body.mime as string,
        sizeBytes: body.sizeBytes as number,
        sha256: body.sha256 as string,
        altText: body.altText as string | null,
        caption: body.caption as string | null,
      });
      reply.header("Cache-Control", "no-store");
      return reply.code(201).type("application/json").send(JSON.parse(mediaCommandContract.encodeUploadGrant(grant)));
    } catch (error) {
      const result = mediaRouteError(error);
      return reply.code(result.status).type("application/json").send(result.body);
    }
  });

  app.post(pathWithParams("/v1/rooms/:roomId/media/:mediaId/complete"), async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authenticated = await safeSessionIdentity(request, dependencies.sessions);
    if (authenticated === "failed") return reply.code(500).type("application/json").send({ code: "INTERNAL" });
    if (!authenticated) return reply.code(401).type("application/json").send({ code: "AUTH_REQUIRED" });
    const { identity, sessionId } = authenticated;
    if (!dependencies.media) return reply.code(503).type("application/json").send({ code: "MEDIA_SERVICE_UNAVAILABLE" });
    const params = request.params as { roomId?: unknown; mediaId?: unknown };
    const roomId = typeof params.roomId === "string" ? params.roomId : "";
    const mediaId = typeof params.mediaId === "string" ? params.mediaId : "";
    const body = request.body;
    if (body !== undefined && body !== null && (!isEmptyObject(body))) {
      return reply.code(400).type("application/json").send({ code: "INVALID_MEDIA_COMMAND" });
    }
    try {
      const result = await finalizeUpload(dependencies.media, {
        principal: identity,
        sessionId,
        roomId,
        mediaId,
        correlationId: correlationId(),
      });
      reply.header("Cache-Control", "no-store");
      return reply.code(200).type("application/json").send(JSON.parse(mediaCommandContract.encodeComplete(result)));
    } catch (error) {
      const result = mediaRouteError(error);
      return reply.code(result.status).type("application/json").send(result.body);
    }
  });

  app.get(pathWithParams("/v1/rooms/:roomId/media/:mediaId"), async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authenticated = await safeSessionIdentity(request, dependencies.sessions);
    if (authenticated === "failed") return reply.code(500).type("application/json").send({ code: "INTERNAL" });
    if (!authenticated) return reply.code(401).type("application/json").send({ code: "AUTH_REQUIRED" });
    const { identity, sessionId } = authenticated;
    if (!dependencies.media) return reply.code(503).type("application/json").send({ code: "MEDIA_SERVICE_UNAVAILABLE" });
    const params = request.params as { roomId?: unknown; mediaId?: unknown };
    const roomId = typeof params.roomId === "string" ? params.roomId : "";
    const mediaId = typeof params.mediaId === "string" ? params.mediaId : "";
    try {
      const view = await getMediaAttachment(dependencies.media, { principal: identity, sessionId, roomId, mediaId });
      if (!view) return reply.code(404).type("application/json").send({ code: "MEDIA_NOT_FOUND" });
      reply.header("Cache-Control", "no-store");
      return reply.code(200).type("application/json").send(JSON.parse(mediaAttachmentJson(view)));
    } catch (error) {
      const result = mediaRouteError(error);
      return reply.code(result.status).type("application/json").send(result.body);
    }
  });

  app.get(pathWithParams("/v1/rooms/:roomId/media/:mediaId/download"), async (request, reply) => {
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    const authenticated = await safeSessionIdentity(request, dependencies.sessions);
    if (authenticated === "failed") return reply.code(500).type("application/json").send({ code: "INTERNAL" });
    if (!authenticated) return reply.code(401).type("application/json").send({ code: "AUTH_REQUIRED" });
    const { identity, sessionId } = authenticated;
    if (!dependencies.media) return reply.code(503).type("application/json").send({ code: "MEDIA_SERVICE_UNAVAILABLE" });
    const params = request.params as { roomId?: unknown; mediaId?: unknown };
    const roomId = typeof params.roomId === "string" ? params.roomId : "";
    const mediaId = typeof params.mediaId === "string" ? params.mediaId : "";
    try {
      const grant = await createDownloadGrant(dependencies.media, { principal: identity, sessionId, roomId, mediaId });
      reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
      return reply.code(200).type("application/json").send(JSON.parse(mediaCommandContract.encodeDownloadGrant(grant)));
    } catch (error) {
      const result = mediaRouteError(error);
      return reply.code(result.status).type("application/json").send(result.body);
    }
  });

  if (dependencies.internalReconcile) {
    app.post(routes.internal.media.reconcileUpload(), async (request, reply) => {
      let result;
      try {
        result = await dependencies.internalReconcile!.handle(
          request.headers["x-lo-service-assertion"],
          request.body,
        );
      } catch {
        return reply.code(500).type("application/json").send({ code: "INTERNAL" });
      }
      const status = result.status === "completed" || result.status === "retryable"
        ? 200
        : result.code === "SERVICE_ASSERTION_INVALID" ? 401 : 409;
      return reply.code(status).type("application/json").send(JSON.parse(
        mediaInternalResponseJson(result),
      ));
    });
  }
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 0;
}

function mediaAttachmentJson(value: unknown): string {
  return mediaAttachmentContract.encode(value);
}

function mediaInternalResponseJson(value: unknown): string {
  return mediaInternalReconcileContract.encodeResponse(value);
}

export { routes };
