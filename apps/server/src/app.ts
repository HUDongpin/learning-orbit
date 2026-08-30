import fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { Pool } from "pg";

import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { ServerConfig } from "./config.js";
import { loadServerConfig, testServerConfig } from "./config.js";
import { createDatabasePool } from "./db/pool.js";
import { MagicLinkService, type SendMagicLink } from "./modules/auth/magic-link-service.js";
import { createSmtpMailer, type MailTransport } from "./modules/auth/mailer.js";
import { SessionService } from "./modules/auth/session-service.js";
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
import { isExactAllowedOrigin, requiresAllowedOrigin } from "./modules/security/origin-policy.js";
import { registerRoutes } from "./routes.js";

export interface BuildAppOptions {
  databaseUrl?: string;
  pool?: Pool;
  createPool?: (connectionString: string) => Pool;
  clock?: Clock;
  config?: Partial<ServerConfig>;
  sendMagicLink?: SendMagicLink;
  mailTransport?: MailTransport;
  createSmtpMailer?: typeof createSmtpMailer;
  codeHasher?: CodeHasher;
  roomCodeSource?: RoomCodeSource;
  serviceAssertionTrust?: ServiceAssertionTrust;
  jobClaims?: JobClaimAuthority;
}

function resolvedConfig(options: BuildAppOptions): ServerConfig {
  if (options.config) return testServerConfig({ ...options.config, databaseUrl: options.databaseUrl ?? options.config.databaseUrl });
  return loadServerConfig();
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = resolvedConfig(options);
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
    errorResponseBuilder: () => ({ statusCode: 429, code: "RATE_LIMITED" }),
  });
  app.addHook("onRequest", async (request, reply) => {
    const requestOrigin = request.headers.origin;
    if (requiresAllowedOrigin(request)) {
      if (!isExactAllowedOrigin(requestOrigin, config.allowedOrigins)) return reply.code(403).send({ code: "ORIGIN_FORBIDDEN" });
    } else if (requestOrigin && !isExactAllowedOrigin(requestOrigin, config.allowedOrigins)) {
      return reply.code(403).send({ code: "ORIGIN_FORBIDDEN" });
    }
  });
  const clock = options.clock ?? systemClock;
  const configuredHasher = config.roomCodePepperCurrentVersion !== undefined
    && config.roomCodePeppers !== undefined
    ? new CodeHasher(config.roomCodePepperCurrentVersion, config.roomCodePeppers)
    : undefined;
  const codeHasher = options.codeHasher ?? configuredHasher;
  const lifecycle = pool ? new RoomLifecycleService(new RoomEventRepository(pool, createCoreEventPayloadRegistry(), clock), clock) : undefined;
  const assertionTrust = options.serviceAssertionTrust ?? (config.serviceAssertionTrustFile
    ? loadServiceAssertionTrust({ trustFile: config.serviceAssertionTrustFile }) : undefined);
  await registerRoutes(app, {
    magicLinks: pool ? new MagicLinkService(pool, clock, config.publicBaseOrigin, sender) : undefined,
    sessions: pool ? new SessionService(pool) : undefined,
    rooms: pool && codeHasher
      ? new RoomService(pool, codeHasher, clock, options.roomCodeSource, lifecycle)
      : undefined,
    lifecycle,
    serviceAssertionTrust: assertionTrust,
    jobClaims: options.jobClaims ?? new JobClaimAuthority(),
    commands: pool && lifecycle ? new CommandService(new MessageService(lifecycle.events, noAttachments, clock), lifecycle) : undefined,
  });
  app.addHook("onClose", async () => {
    if (ownsPool) await pool?.end();
    if (smtp) await smtp.transport.close();
  });
  return app;
}
