import { createHash } from "node:crypto";

import {
  agentContract,
  type AgentInternalCommandRequest,
  type AgentInternalCommandResponse,
} from "@learning-orbit/contracts";

import type { Clock } from "../../clock.js";
import { JobClaimAuthority, type JobClaimIdentity } from "../jobs/job-claim-authority.js";
import {
  authorizeServiceAssertion,
  verifyServiceAssertionEnvelope,
  type ServiceAssertionTrust,
} from "../security/service-assertion.js";
import type { RoomEventDraft, RoomEventRepository } from "../rooms/room-event-repository.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** Agent-run states from which a worker result may still be admitted. */
const ADMISSIBLE_RUN_STATES = new Set(["queued", "running", "streaming"]);

/**
 * The return leg of an Agent run.
 *
 * The Worker executes the provider call and reports the result here. Nothing
 * downstream of the executor can reach room state any other way: without this
 * route a completed run has no path back to a room event, so Nova can never
 * speak no matter how well the execution went.
 *
 * The route owns no assertion, room-lock or claim SQL of its own. It reuses the
 * canonical room-event transaction (which takes the room advisory lock and
 * allocates roomSeq), the shared service-assertion authority and the singleton
 * JobClaimAuthority, so a stale attempt is refused by the same CAS that governs
 * every other worker family.
 */
export class InternalAgentCompleteRoute {
  constructor(
    private readonly events: RoomEventRepository,
    private readonly clock: Clock,
    private readonly trust: ServiceAssertionTrust,
    private readonly claims: JobClaimAuthority = new JobClaimAuthority(),
  ) {}

  async handle(rawAssertion: unknown, value: unknown): Promise<AgentInternalCommandResponse> {
    // Assertion before parse: an unsigned caller never reaches the generated
    // validator, so schema behaviour cannot be probed without a trusted key.
    let signedBy: string;
    try {
      signedBy = verifyServiceAssertionEnvelope(rawAssertion, value, {
        audience: "internal.agent.complete",
      }, this.trust, this.clock.now());
    } catch {
      return { status: "rejected", code: "SERVICE_ASSERTION_INVALID" };
    }
    let request: AgentInternalCommandRequest;
    try {
      request = agentContract.parseInternalRequest(value);
    } catch {
      return { status: "rejected", code: "AGENT_OUTPUT_INVALID" };
    }
    const claim: JobClaimIdentity = request;
    try {
      if (request.workerId !== signedBy) throw new Error("SERVICE_ASSERTION_INVALID");
      authorizeServiceAssertion(rawAssertion, request, {
        audience: "internal.agent.complete",
        workerId: request.workerId,
        claim,
      }, this.trust, this.clock.now());
    } catch {
      return { status: "rejected", code: "SERVICE_ASSERTION_INVALID" };
    }

    // The server recomputes the digest rather than trusting the worker's own
    // claim about what it produced.
    const digest = createHash("sha256").update(request.text, "utf8").digest("hex");
    if (digest !== request.outputSha256) {
      return { status: "rejected", code: "AGENT_OUTPUT_INVALID" };
    }

    try {
      return await this.events.transact(request.roomId, async (context) => {
        const tx = context.client;
        const jobResult = await tx.query<{
          job_type: string;
          room_id: string | null;
          source_event_id: string | null;
          dedupe_key: string;
          correlation_id: string;
          payload: unknown;
        }>(
          `SELECT job_type, room_id, source_event_id, dedupe_key, correlation_id, payload
           FROM worker_job WHERE job_id = $1 FOR UPDATE`,
          [request.jobId],
        );
        const job = jobResult.rows[0];
        const payload = isPlainRecord(job?.payload) ? job.payload : undefined;
        const identityOk = !!job
          && job.job_type === request.jobType
          && job.room_id === request.roomId
          && job.source_event_id === request.sourceEventId
          && job.dedupe_key === request.dedupeKey
          && job.correlation_id === request.correlationId
          && !!payload
          && payload.agentRunId === request.agentRunId;
        if (!identityOk) return { status: "rejected", code: "AGENT_OUTPUT_INVALID" };

        try {
          await this.claims.requireCurrent(tx, claim);
        } catch {
          return { status: "rejected", code: "JOB_CLAIM_STALE" };
        }

        const runResult = await tx.query<{
          agent_run_id: string;
          room_id: string;
          state: string;
          trigger_event_id: string;
          correlation_id: string;
        }>(
          `SELECT agent_run_id, room_id, state, trigger_event_id, correlation_id
           FROM agent_run WHERE agent_run_id = $1 AND room_id = $2 FOR UPDATE`,
          [request.agentRunId, request.roomId],
        );
        const run = runResult.rows[0];
        if (!run || run.trigger_event_id !== request.sourceEventId
          || run.correlation_id !== request.correlationId) {
          return { status: "rejected", code: "AGENT_OUTPUT_INVALID" };
        }

        // A response lost in transit is retried under the next current claim.
        // The causation ID is the job ID, so the ledger itself carries the
        // idempotency: a second delivery finds the event it already wrote.
        const existing = await context.findByCausation(request.jobId);
        if (existing) {
          await this.claims.completeBusiness(tx, claim, "AGENT_EXECUTION_TERMINAL");
          return { status: "already_applied", eventId: existing.eventId };
        }

        if (!ADMISSIBLE_RUN_STATES.has(run.state)) {
          return { status: "rejected", code: "AGENT_RUN_NOT_ACTIVE" };
        }
        if (context.room.status !== "open" && context.room.status !== "paused") {
          return { status: "rejected", code: "ROOM_NOT_OPEN" };
        }

        const now = this.clock.now();
        const appended = await context.append({
          type: "message.added",
          actorId: context.room.nova_actor_id,
          actorKind: "agent",
          actorRole: "socratic_facilitator",
          revision: 1,
          operation: "add",
          eventTime: now,
          causationId: request.jobId,
          correlationId: request.correlationId as RoomEventDraft["correlationId"],
          payload: {
            messageId: request.agentRunId,
            text: request.text,
            replyTo: null,
            mentions: [],
            mediaIds: [],
            agentRunId: request.agentRunId,
            sourceEventIds: request.sourceEventIds,
            ...(request.warningCodes.length ? { warningCodes: request.warningCodes } : {}),
          },
        });

        await tx.query(
          `UPDATE agent_run SET state = 'completed', failure_code = NULL,
                  updated_at = transaction_timestamp()
           WHERE agent_run_id = $1 AND room_id = $2`,
          [request.agentRunId, request.roomId],
        );
        await tx.query(
          `INSERT INTO agent_run_transition(transition_id, agent_run_id, from_state, to_state,
                                            reason_code, causation_id)
           VALUES($1,$2,$3,'completed','AGENT_EXECUTION_TERMINAL',$4)
           ON CONFLICT (causation_id) DO NOTHING`,
          [appended.eventId, request.agentRunId, run.state, request.jobId],
        );
        await this.claims.completeBusiness(tx, claim, "AGENT_EXECUTION_TERMINAL");
        return { status: "applied", eventId: appended.eventId };
      });
    } catch (error) {
      if (error instanceof Error && error.message === "JOB_CLAIM_STALE") {
        return { status: "rejected", code: "JOB_CLAIM_STALE" };
      }
      throw error;
    }
  }
}
