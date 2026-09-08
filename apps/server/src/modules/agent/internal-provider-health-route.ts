import type { FastifyRequest } from "fastify";
import { agentContract } from "@learning-orbit/contracts";
import type { Clock } from "../../clock.js";
import { authorizeProviderHealthAssertion, type ServiceAssertionTrust } from "../security/service-assertion.js";
import { ProviderHealthRepository } from "./provider-health-repository.js";
import type { AgentProviderScope } from "./provider-manifest.js";

/** The reviewed provider scope this route admits samples for, and nothing else. */
export type ProviderHealthRouteOptions = AgentProviderScope;

export class InternalProviderHealthRoute {
  constructor(
    private readonly repository: ProviderHealthRepository,
    private readonly trust: ServiceAssertionTrust,
    private readonly clock: Clock,
    private readonly options: ProviderHealthRouteOptions,
  ) {}

  async handle(rawAssertion: unknown, value: unknown): Promise<unknown> {
    let body;
    try { body = agentContract.parseHealthRequest(value); } catch { return { status: "rejected", code: "PROBE_ASSERTION_INVALID" }; }
    if (body.providerId !== this.options.providerId || body.manifestSha256 !== this.options.manifestSha256) {
      return { status: "rejected", code: "PROVIDER_SCOPE_MISMATCH" };
    }
    const checkedAt = new Date(body.checkedAt);
    if (!Number.isFinite(checkedAt.getTime()) || checkedAt.getTime() > this.clock.now().getTime() + 5_000) {
      return { status: "rejected", code: "HEALTH_SAMPLE_TIME_INVALID" };
    }
    let identity;
    try {
      identity = authorizeProviderHealthAssertion(rawAssertion, body, this.options, this.trust, this.clock.now());
    } catch { return { status: "rejected", code: "PROBE_ASSERTION_INVALID" }; }
    let signature: Buffer;
    try {
      const encoded = Buffer.from(String(rawAssertion), "base64url").toString("utf8");
      const envelope = JSON.parse(encoded) as { signature?: string };
      if (typeof envelope.signature !== "string") throw new Error("signature");
      signature = Buffer.from(envelope.signature, "base64url");
      if (signature.length !== 64) throw new Error("signature");
    } catch {
      return { status: "rejected", code: "PROBE_ASSERTION_INVALID" };
    }
    const status = await this.repository.upsert({
      providerId: body.providerId, manifestSha256: body.manifestSha256, health: body.health,
      checkedAt, reasonCode: body.reasonCode, signatureKeyId: identity.keyId,
      signature,
    });
    return { status };
  }
}

export function requestAssertion(request: FastifyRequest): unknown { return request.headers["x-lo-service-assertion"]; }
