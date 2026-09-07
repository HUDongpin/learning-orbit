import fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import type { Pool } from "pg";

import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { ServerConfig } from "./config.js";
import { loadServerConfig, testServerConfig } from "./config.js";
import { createDatabasePool } from "./db/pool.js";
import { MagicLinkService, type SendMagicLink } from "./modules/auth/magic-link-service.js";
import { createSmtpMailer, type MailTransport } from "./modules/auth/mailer.js";
import { SessionService } from "./modules/auth/session-service.js";
import { TeacherRoomListService } from "./modules/teacher/teacher-room-list-service.js";
import { RoomService, type RoomCodeSource } from "./modules/rooms/room-service.js";
import { CodeHasher } from "./modules/rooms/seat-codes.js";
import { createCoreEventPayloadRegistry } from "@learning-orbit/contracts";
import { RoomEventRepository } from "./modules/rooms/room-event-repository.js";
import { RoomLifecycleService } from "./modules/rooms/lifecycle-service.js";
import type { ServiceAssertionTrust } from "./modules/security/service-assertion.js";
import { loadServiceAssertionTrust } from "./modules/security/service-assertion.js";
import { JobClaimAuthority } from "./modules/jobs/job-claim-authority.js";
import { MessageService } from "./modules/rooms/message-service.js";
import { CommandService } from "./modules/rooms/command-service.js";
import { noAttachments } from "./modules/rooms/attachment-validator.js";
import { forbidsAnyOrigin, isExactAllowedOrigin, requiresAllowedOrigin } from "./modules/security/origin-policy.js";
import { closedRateLimitError } from "./modules/security/rate-policies.js";
import { registerRoutes } from "./routes.js";
import { RoomHub, type ProjectionDeliveryAuthorizer } from "./modules/realtime/room-hub.js";
import { projectionDeliveryFailureDecision } from "./modules/realtime/projection-delivery-decision.js";
import { RealtimeConnection } from "./modules/realtime/connection.js";
import { RealtimeDeliveryAuthorizer } from "./modules/realtime/realtime-delivery-authorizer.js";
import { OutboxPublisher } from "./modules/realtime/outbox-publisher.js";
import { MediaAttachmentValidator } from "./modules/media/media-attachment-validator.js";
import { MediaRepository } from "./modules/media/media-repository.js";
import type { MediaDeps } from "./modules/media/media-service.js";
import type { MediaStore } from "./modules/media/media-store.js";
import { MediaInternalReconcileRoute } from "./modules/media/media-internal-reconcile-route.js";
import { AnalyticsPolicy } from "./modules/analytics/analytics-policy.js";
import { AnalyticsRepository } from "./modules/analytics/analytics-repository.js";
import { AnalyticsTeacherService } from "./modules/analytics/analytics-teacher-service.js";
import { ProjectionOutboxRepository } from "./modules/analytics/projection-outbox-repository.js";
import { AgentService } from "./modules/agent/agent-service.js";
import { ProviderHealthRepository } from "./modules/agent/provider-health-repository.js";
import { InternalProviderHealthRoute } from "./modules/agent/internal-provider-health-route.js";
import { InternalAgentCompleteRoute } from "./modules/agent/internal-agent-complete-route.js";
import { MediaInternalOutcomeRoute } from "./modules/media/media-internal-outcome-route.js";
import { InternalMediaSurfaceRoute, type MediaSurfaceEraser } from "./modules/lifecycle/internal-media-surface-route.js";
import { registerAnalyticsReviewEventPayloads } from "./modules/analytics/register-analytics-review-event-payloads.js";
import type { GovernanceService } from "./modules/governance/governance-service.js";
import { GovernanceService as DefaultGovernanceService } from "./modules/governance/governance-service.js";

export interface BuildAppOptions {
  databaseUrl?: string;
  pool?: Pool;
  createPool?: (connectionString: string) => Pool;
  clock?: Clock;
  config?: Partial<ServerConfig>;
  sendMagicLink?: SendMagicLink;
  mailTransport?: MailTransport;
  sessions?: SessionService;
  teacherRooms?: Pick<TeacherRoomListService, "list">;
  lifecycle?: RoomLifecycleService;
  realtime?: {
    hub: RoomHub;
    authorizer: RealtimeDeliveryAuthorizer;
    publisher: OutboxPublisher;
  };
  createSmtpMailer?: typeof createSmtpMailer;
  codeHasher?: CodeHasher;
  roomCodeSource?: RoomCodeSource;
  serviceAssertionTrust?: ServiceAssertionTrust;
  jobClaims?: JobClaimAuthority;
  media?: MediaDeps;
  mediaStore?: MediaStore;
  agent?: AgentService;
  agentComplete?: InternalAgentCompleteRoute;
  mediaInternalOutcome?: MediaInternalOutcomeRoute;
  lifecycleMediaSurface?: InternalMediaSurfaceRoute;
  mediaSurfaceEraser?: MediaSurfaceEraser;
  /** Explicitly injected in tests/pilot; production requires LO_AUDIT_SALT. */
  governance?: GovernanceService;
  analytics?: {
    policy: Pick<AnalyticsPolicy, "requireRoomAccess" | "assertProjection">;
    repository: Pick<AnalyticsRepository, "latest" | "patchesAfter" | "timeline">;
  };
  analyticsTeacher?: Pick<AnalyticsTeacherService, "authorize" | "listArtifacts" | "review" | "reviewDetail">;
}

function resolvedConfig(options: BuildAppOptions): ServerConfig {
  if (options.config) return testServerConfig({ ...options.config, databaseUrl: options.databaseUrl ?? options.config.databaseUrl });
  return loadServerConfig();
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = resolvedConfig(options);
  if (options.mediaStore && config.storageBrowserOrigins.length === 0) {
    throw new Error("LO_STORAGE_BROWSER_ORIGINS_REQUIRED");
  }
  const pool = options.pool ?? (config.databaseUrl ? (options.createPool ?? createDatabasePool)(config.databaseUrl) : undefined);
  const ownsPool = Boolean(pool && !options.pool);
  const smtp = !options.sendMagicLink && !options.mailTransport && config.smtpHost && config.smtpPort && config.smtpFrom
    ? (options.createSmtpMailer ?? createSmtpMailer)(config.smtpHost, config.smtpPort, config.smtpFrom) : undefined;
  const sender = options.sendMagicLink ?? (options.mailTransport
    ? async (email: string, url: string) => { await options.mailTransport?.sendMail({ from: config.smtpFrom ?? "no-reply@localhost", to: email, subject: "Learning Orbit sign-in link", text: url }); }
    : smtp?.sender ?? (async () => undefined));
  const app = fastify({ trustProxy: config.trustProxy === false ? false : [...config.trustProxy] });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false, skipOnError: false,
    errorResponseBuilder: closedRateLimitError,
  });
  await app.register(websocket, { options: { maxPayload: RealtimeConnection.MAX_INBOUND_FRAME_BYTES } });
  app.addHook("onRequest", async (request, reply) => {
    const requestOrigin = request.headers.origin;
    if (forbidsAnyOrigin(request)) {
      if (requestOrigin) return reply.code(403).send({ code: "ORIGIN_FORBIDDEN" });
    } else if (requiresAllowedOrigin(request)) {
      if (!isExactAllowedOrigin(requestOrigin, config.allowedOrigins)) return reply.code(403).send({ code: "ORIGIN_FORBIDDEN" });
    } else if (requestOrigin && !isExactAllowedOrigin(requestOrigin, config.allowedOrigins)) {
      return reply.code(403).send({ code: "ORIGIN_FORBIDDEN" });
    }
  });
  const clock = options.clock ?? systemClock;
  const eventPayloadRegistry = createCoreEventPayloadRegistry();
  registerAnalyticsReviewEventPayloads(eventPayloadRegistry);
  const configuredHasher = config.roomCodePepperCurrentVersion !== undefined
    && config.roomCodePeppers !== undefined
    ? new CodeHasher(config.roomCodePepperCurrentVersion, config.roomCodePeppers)
    : undefined;
  const codeHasher = options.codeHasher ?? configuredHasher;
  const lifecycle = options.lifecycle
    ?? (pool ? new RoomLifecycleService(new RoomEventRepository(pool, eventPayloadRegistry, clock), clock) : undefined);
  const assertionTrust = options.serviceAssertionTrust ?? (config.serviceAssertionTrustFile
    ? loadServiceAssertionTrust({ trustFile: config.serviceAssertionTrustFile }) : undefined);
  const jobClaims = options.jobClaims ?? new JobClaimAuthority();
  const analytics = options.analytics ?? (pool ? {
    policy: new AnalyticsPolicy(pool),
    repository: new AnalyticsRepository(pool),
  } : undefined);
  const realtime = options.realtime ?? (pool ? (() => {
    const authorizer = new RealtimeDeliveryAuthorizer(pool);
    const hub = new RoomHub(pool, authorizer, () => clock.now());
    const authorizeProjection: ProjectionDeliveryAuthorizer = async ({ connection, frame, principal }) => {
      if (!analytics) return { allow: false as const };
      try {
        const grant = await analytics.policy.requireRoomAccess(
          principal, frame.roomId, "projection_frame", connection.identity.sessionId,
        );
        analytics.policy.assertProjection(grant, frame.projectionKey);
        return { allow: true as const };
      } catch (error) {
        return projectionDeliveryFailureDecision(error);
      }
    };
    const projection = analytics ? {
      repository: new ProjectionOutboxRepository(pool),
      authorize: authorizeProjection,
    } : undefined;
    return {
      authorizer,
      hub,
      publisher: new OutboxPublisher(pool, hub, undefined, projection),
    };
  })() : undefined);
  const publisherTimer = realtime ? setInterval(() => { void realtime.publisher.tick().catch(() => undefined); }, 250) : undefined;
  const media: MediaDeps | undefined = config.storageBrowserOrigins.length === 0
    ? undefined
    : options.media
      ? {
        ...options.media,
        config: { ...(options.media.config ?? {}), storageBrowserOrigins: config.storageBrowserOrigins },
      }
      : pool && options.mediaStore ? {
        pool,
        store: options.mediaStore,
        repo: new MediaRepository(pool, clock),
        clock,
        config: { storageBrowserOrigins: config.storageBrowserOrigins },
      } : undefined;
  const mediaInternalReconcile = pool && media && assertionTrust
    ? new MediaInternalReconcileRoute(
      lifecycle?.events ?? new RoomEventRepository(pool, eventPayloadRegistry, clock),
      media.repo ?? new MediaRepository(pool, clock),
      media.store,
      clock,
      assertionTrust,
      jobClaims,
    )
    : undefined;
  const analyticsTeacher = options.analyticsTeacher ?? (pool && lifecycle && analytics?.policy instanceof AnalyticsPolicy
    ? new AnalyticsTeacherService(pool, lifecycle.events, analytics.policy) : undefined);
  const agent = options.agent ?? (pool ? new AgentService(pool, clock) : undefined);
  const agentProviderHealth = pool && assertionTrust ? new InternalProviderHealthRoute(
    new ProviderHealthRepository(pool, clock), assertionTrust, clock,
    { providerId: "fixture", manifestSha256: "0".repeat(64) },
  ) : undefined;

  // The three worker return paths. Each needs the same two authorities the
  // outbound families already use - the room-event transaction and the signed
  // service assertion - so each is absent for exactly the same reason its
  // outbound sibling would be.
  const events = lifecycle?.events
    ?? (pool ? new RoomEventRepository(pool, eventPayloadRegistry, clock) : undefined);
  const agentComplete = options.agentComplete ?? (events && assertionTrust
    ? new InternalAgentCompleteRoute(events, clock, assertionTrust, jobClaims)
    : undefined);
  const mediaInternalOutcome = options.mediaInternalOutcome ?? (events && assertionTrust
    ? new MediaInternalOutcomeRoute(events, clock, assertionTrust, jobClaims, realtime?.hub)
    : undefined);
  const lifecycleMediaSurface = options.lifecycleMediaSurface ?? (pool && assertionTrust
    ? new InternalMediaSurfaceRoute(pool, clock, assertionTrust, jobClaims, options.mediaSurfaceEraser)
    : undefined);
  const governance = options.governance ?? (pool && process.env.LO_AUDIT_SALT
    ? new DefaultGovernanceService(pool, {
      auditSalt: process.env.LO_AUDIT_SALT,
      clock: () => clock.now(),
      ...(realtime
        ? { evictRoom: (roomId: string, code?: number) => { realtime.hub.evictRoom(roomId, code); } }
        : {}),
    })
    : undefined);
  await registerRoutes(app, {
    magicLinks: pool ? new MagicLinkService(pool, clock, config.publicBaseOrigin, sender) : undefined,
    sessions: options.sessions ?? (pool ? new SessionService(pool) : undefined),
    teacherRooms: options.teacherRooms ?? (pool ? new TeacherRoomListService(pool) : undefined),
    rooms: pool && codeHasher
      ? new RoomService(pool, codeHasher, clock, options.roomCodeSource, lifecycle)
      : undefined,
    lifecycle,
    serviceAssertionTrust: assertionTrust,
    jobClaims,
    commands: pool && lifecycle ? new CommandService(new MessageService(lifecycle.events, media ? new MediaAttachmentValidator() : noAttachments, clock), lifecycle) : undefined,
    realtime,
    media,
    mediaInternalReconcile,
    agent,
    agentProviderHealth,
    agentComplete,
    mediaInternalOutcome,
    lifecycleMediaSurface,
    analytics,
    analyticsTeacher,
    governance,
  });
  app.addHook("onClose", async () => {
    if (publisherTimer) clearInterval(publisherTimer);
    if (ownsPool) await pool?.end();
    if (smtp) await smtp.transport.close();
  });
  return app;
}
