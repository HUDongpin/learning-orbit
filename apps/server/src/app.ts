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
import { startOtelRuntime, type OtelRuntime } from "./observability/otel.js";
import { FAULT_NAMES, FaultController, FaultControlError, faultControlsEnabled } from "./modules/security/fault-controls.js";
import { RoomHub, type ProjectionDeliveryAuthorizer } from "./modules/realtime/room-hub.js";
import { projectionDeliveryFailureDecision } from "./modules/realtime/projection-delivery-decision.js";
import { RealtimeConnection } from "./modules/realtime/connection.js";
import { RealtimeDeliveryAuthorizer } from "./modules/realtime/realtime-delivery-authorizer.js";
import { OutboxPublisher } from "./modules/realtime/outbox-publisher.js";
import { MediaAttachmentValidator } from "./modules/media/media-attachment-validator.js";
import { MediaRepository } from "./modules/media/media-repository.js";
import type { MediaDeps } from "./modules/media/media-service.js";
import { SecurityAuditLog } from "./modules/security/security-audit.js";
import { RetentionScheduler } from "./modules/lifecycle/retention-scheduler.js";
import { StudentAnalyticsPolicyListener } from "./modules/lifecycle/student-analytics-policy-listener.js";
import { StudentAnalyticsPromotionService } from "./modules/lifecycle/student-analytics-promotion.js";
import { MediaStagingJanitor } from "./modules/media/media-staging-janitor.js";
import { MediaStoreSurfaceEraser } from "./modules/media/media-surface-eraser.js";
import { S3MediaStore } from "./modules/media/s3-media-store.js";
import { S3HttpTransport, S3_HTTP_TRANSPORT_CAPABILITIES } from "./modules/media/s3-http-transport.js";
import type { MediaStore } from "./modules/media/media-store.js";
import { MediaInternalReconcileRoute } from "./modules/media/media-internal-reconcile-route.js";
import { AnalyticsPolicy } from "./modules/analytics/analytics-policy.js";
import { AnalyticsRepository } from "./modules/analytics/analytics-repository.js";
import { AnalyticsTeacherService } from "./modules/analytics/analytics-teacher-service.js";
import { ProjectionOutboxRepository } from "./modules/analytics/projection-outbox-repository.js";
import { AgentService } from "./modules/agent/agent-service.js";
import { ProviderHealthRepository } from "./modules/agent/provider-health-repository.js";
import { InternalProviderHealthRoute } from "./modules/agent/internal-provider-health-route.js";
import { AgentRunReconciler } from "./modules/agent/agent-run-reconciler.js";
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
  /** Explicitly injected in tests/pilot; production requires config.auditSalt. */
  governance?: GovernanceService;
  analytics?: {
    policy: Pick<AnalyticsPolicy, "requireRoomAccess" | "assertProjection">;
    repository: Pick<AnalyticsRepository, "latest" | "patchesAfter" | "timeline">;
  };
  analyticsTeacher?: Pick<AnalyticsTeacherService, "authorize" | "listArtifacts" | "review" | "reviewDetail">;
  /** Injected by telemetry tests; an injected runtime is owned by its caller. */
  otel?: OtelRuntime;
}

function resolvedConfig(options: BuildAppOptions): ServerConfig {
  if (options.config) return testServerConfig({ ...options.config, databaseUrl: options.databaseUrl ?? options.config.databaseUrl });
  return loadServerConfig();
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = resolvedConfig(options);
  // The reviewed provider, resolved once by `loadServerConfig` from the one
  // manifest the worker also reads: a malformed or unreadable manifest fails
  // there, before any resource exists, rather than leaving a running server
  // scoped to a provider nobody approved.  An injected config that names no
  // scope keeps the refusing one, so this never reaches past what it was
  // handed into the ambient environment.
  const agentProviderScope = config.agentProviderScope;
  // Telemetry starts before Fastify and every plugin so startup work is inside
  // the trace, and is shut down with the server.  With no approved collector
  // configured this is an inert facade, which is a supported deployment.
  // Checked before Fastify exists, so a production process that was handed
  // LEARNING_ORBIT_TEST_FAULTS refuses to boot rather than quietly ignoring it.
  const faults = faultControlsEnabled(process.env) ? new FaultController() : undefined;
  const otel: OtelRuntime = options.otel ?? startOtelRuntime({
    environment: config.environment,
    ...(config.otlpEndpoint ? { endpoint: config.otlpEndpoint } : {}),
  });
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
  // One audit writer for every authorization decision the process makes.
  const securityAudit = pool && config.auditSalt
    ? new SecurityAuditLog(pool, config.auditSalt)
    : undefined;
  const analytics = options.analytics ?? (pool ? {
    policy: new AnalyticsPolicy(pool, securityAudit),
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
      publisher: new OutboxPublisher(pool, hub, undefined, projection, otel.telemetry, faults),
    };
  })() : undefined);
  const publisherTimer = realtime ? setInterval(() => { void realtime.publisher.tick().catch(() => undefined); }, 250) : undefined;
  // A configured store is built here so production gets a real transport
  // without a test having to inject one; an injected store still wins.
  const configuredStore = options.mediaStore ?? (config.storage
    ? new S3MediaStore({
      transport: new S3HttpTransport({
        endpoint: config.storage.endpoint,
        bucket: config.storage.bucket,
        credentials: {
          accessKeyId: config.storage.accessKeyId,
          secretAccessKey: config.storage.secretAccessKey,
          region: config.storage.region,
        },
      }),
      capabilities: S3_HTTP_TRANSPORT_CAPABILITIES,
    })
    : undefined);
  // Staging objects outlive their write fence until something sweeps them.
  // A minute is far finer than the five-minute upload TTL and coarse enough
  // that an idle room costs one indexed query.
  const janitor = pool && configuredStore
    ? new MediaStagingJanitor(pool, configuredStore, clock)
    : undefined;
  const janitorTimer = janitor
    ? setInterval(() => { void janitor.sweep().catch(() => undefined); }, 60_000)
    : undefined;
  // A run whose job died, or whose room closed underneath it, has no other
  // owner. Left alone it also blocks every future run in that room.
  const agentReconciler = pool ? new AgentRunReconciler(pool, clock) : undefined;
  const agentReconcileTimer = agentReconciler
    ? setInterval(() => { void agentReconciler.reconcile().catch(() => undefined); }, 30_000)
    : undefined;

  // Retention is the half of the privacy promise nobody presses a button for.
  // An hour is far finer than a window measured in days, and coarse enough
  // that an idle deployment costs one indexed query an hour.
  const retention = pool && config.auditSalt
    ? new RetentionScheduler(pool, clock, config.auditSalt)
    : undefined;
  const retentionTimer = retention
    ? setInterval(() => { void retention.sweep().catch(() => undefined); }, 3_600_000)
    : undefined;

  // Student analytics visibility. The read path is already fail-closed; this
  // is the writer and the listener that makes a withdrawal reach sockets that
  // are already open, rather than only the next request.
  const studentPromotions = pool ? new StudentAnalyticsPromotionService(pool) : undefined;
  const policyListener = pool && realtime && studentPromotions
    ? new StudentAnalyticsPolicyListener(pool, {
      hub: realtime.hub,
      promotions: studentPromotions,
      clock,
    })
    : undefined;
  if (policyListener) await policyListener.start().catch(() => undefined);
  const media: MediaDeps | undefined = config.storageBrowserOrigins.length === 0
    ? undefined
    : options.media
      ? {
        ...options.media,
        config: { ...(options.media.config ?? {}), storageBrowserOrigins: config.storageBrowserOrigins },
      }
      : pool && configuredStore ? {
        pool,
        store: configuredStore,
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
  // Both agent consumers are handed the same scope object, so the health the
  // worker reports and the health a run is admitted against cannot name
  // different providers.
  const agent = options.agent ?? (pool ? new AgentService(pool, clock, undefined, agentProviderScope) : undefined);
  const agentProviderHealth = pool && assertionTrust ? new InternalProviderHealthRoute(
    new ProviderHealthRepository(pool, clock), assertionTrust, clock, agentProviderScope,
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
  // The eraser exists only where a real media surface does. `media` is the one
  // place that decides a store is present and usable, so deriving from it is
  // what keeps the two in step: with no store there is no eraser, and the
  // surface route keeps answering retryable instead of issuing a receipt for a
  // remote deletion nobody performed.
  const mediaSurfaceEraser = options.mediaSurfaceEraser
    ?? (media ? new MediaStoreSurfaceEraser(media.store, clock) : undefined);
  const lifecycleMediaSurface = options.lifecycleMediaSurface ?? (pool && assertionTrust
    ? new InternalMediaSurfaceRoute(pool, clock, assertionTrust, jobClaims, mediaSurfaceEraser)
    : undefined);
  const governance = options.governance ?? (pool && config.auditSalt
    ? new DefaultGovernanceService(pool, {
      auditSalt: config.auditSalt,
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
    commands: pool && lifecycle ? new CommandService(new MessageService(lifecycle.events, media ? new MediaAttachmentValidator() : noAttachments, clock), lifecycle, otel.telemetry) : undefined,
    realtime,
    media,
    mediaInternalReconcile,
    agent,
    agentProviderHealth,
    agentComplete,
    mediaInternalOutcome,
    lifecycleMediaSurface,
    securityAudit,
    analytics,
    analyticsTeacher,
    governance,
  });
  if (faults) registerFaultControls(app, faults);
  app.addHook("onClose", async () => {
    if (publisherTimer) clearInterval(publisherTimer);
    if (janitorTimer) clearInterval(janitorTimer);
    if (retentionTimer) clearInterval(retentionTimer);
    if (agentReconcileTimer) clearInterval(agentReconcileTimer);
    if (policyListener) await policyListener.stop();
    if (ownsPool) await pool?.end();
    if (smtp) await smtp.transport.close();
    if (!options.otel) await otel.shutdown();
  });
  return app;
}

/**
 * Fault-control routes, registered only when the gate above allowed them.
 *
 * They are POST-only and answer with the whole fault state, so a scenario can
 * assert what is armed instead of assuming. `DELETE` resets everything: a
 * scenario that failed part-way must not leave the next one running against a
 * half-broken server.
 */
function registerFaultControls(app: FastifyInstance, faults: FaultController): void {
  for (const name of FAULT_NAMES) {
    app.post(`/test/faults/${name}`, async (request, reply) => {
      const body = request.body as { value?: unknown } | undefined;
      try {
        faults.arm(name, body?.value);
      } catch (error) {
        const code = error instanceof FaultControlError ? error.code : "FAULT_VALUE_INVALID";
        return reply.code(400).type("application/json").send({ code });
      }
      return reply.type("application/json").send(faults.snapshot());
    });
  }
  app.delete("/test/faults", async (_request, reply) => {
    faults.reset();
    return reply.type("application/json").send(faults.snapshot());
  });
}
