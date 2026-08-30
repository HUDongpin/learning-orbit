import fastify from "fastify";
import rateLimit from "@fastify/rate-limit";

import { agentRateKey, closedRateLimitError, normalizedRequestIp, ratePolicies } from "../../src/modules/security/rate-policies.js";

export async function buildRatePolicyHarness(trustProxy: false | string[] = false) {
  const app = fastify({ trustProxy });
  await app.register(rateLimit, {
    global: false, skipOnError: false,
    errorResponseBuilder: closedRateLimitError,
  });
  app.post("/magic", { config: { rateLimit: { ...ratePolicies.magicLink, keyGenerator: normalizedRequestIp } } }, async (_request, reply) => reply.code(204).send());
  app.post("/failed-join", { config: { rateLimit: { ...ratePolicies.failedJoin, keyGenerator: normalizedRequestIp } } }, async (_request, reply) => reply.code(204).send());
  app.post("/agent", { config: { rateLimit: { ...ratePolicies.agentTrigger, keyGenerator: agentRateKey } } }, async (_request, reply) => reply.code(204).send());
  return app;
}
