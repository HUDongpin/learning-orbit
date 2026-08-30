import { JobClaimAuthority, type JobClaimIdentity } from "../jobs/job-claim-authority.js";
import { authorizeServiceAssertion, type ServiceAssertionTrust } from "../security/service-assertion.js";
import { roomInternalAutoCloseContract, type RoomInternalAutoCloseRequest, type RoomInternalAutoCloseResponse } from "@learning-orbit/contracts";
import type { Clock } from "../../clock.js";
import { appendAutomaticClose } from "./lifecycle-service.js";
import type { RoomEventRepository } from "./room-event-repository.js";
import type { RoomEventDraft } from "./room-event-repository.js";

export class InternalAutoCloseRoute {
  constructor(
    private readonly events: RoomEventRepository,
    private readonly clock: Clock,
    private readonly trust: ServiceAssertionTrust,
    private readonly claims: JobClaimAuthority = new JobClaimAuthority(),
  ) {}

  async handle(rawAssertion: unknown, value: unknown): Promise<RoomInternalAutoCloseResponse> {
    let request: RoomInternalAutoCloseRequest;
    try { request = roomInternalAutoCloseContract.parseRequest(value); }
    catch { return { status: "rejected", code: "JOB_FAMILY_IDENTITY_INVALID" }; }
    const claim: JobClaimIdentity = request;
    try {
      authorizeServiceAssertion(rawAssertion, request, {
        audience: "internal.rooms.autoClose", workerId: request.workerId, claim,
      }, this.trust, this.clock.now());
    } catch {
      return { status: "rejected", code: "SERVICE_ASSERTION_INVALID" };
    }
    try {
      return await this.events.transact(request.roomId, async (context) => {
        const tx = context.client;
        const job = await tx.query<{
          job_id: string; job_type: string; room_id: string | null; source_event_id: string | null;
          dedupe_key: string; correlation_id: string; payload: unknown; status: string; run_after: Date;
        }>(`SELECT job_id, job_type, room_id, source_event_id, dedupe_key, correlation_id, payload, status, run_after
            FROM worker_job WHERE job_id = $1 FOR UPDATE`, [request.jobId]);
        const row = job.rows[0];
        const payload = isPlainRecord(row?.payload) ? row?.payload : undefined;
        const source = row?.source_event_id ? await tx.query<{ type: string; room_id: string; actor_kind: string; actor_role: string; revision: number; operation: string; correlation_id: string; payload: Record<string, unknown> }>(
          `SELECT type, room_id, actor_kind, actor_role, revision, operation, correlation_id, payload FROM room_event WHERE event_id = $1`, [row.source_event_id],
        ) : { rows: [] };
        const sourceRow = source.rows[0];
        const generationOk = (() => { try { const n = BigInt(request.claimGeneration); return n > 0n && n <= 9223372036854775807n; } catch { return false; } })();
        const identityOk = generationOk && !!row && row.job_type === request.jobType && row.room_id === request.roomId
          && row.source_event_id === request.sourceEventId && row.dedupe_key === request.dedupeKey
          && row.correlation_id === request.correlationId
          && row.run_after.toISOString() === request.closesAt
          && sourceRow?.type === "room.opened" && sourceRow.room_id === request.roomId
          && sourceRow.actor_kind === "human" && sourceRow.actor_role === "teacher"
          && sourceRow.revision === 1 && sourceRow.operation === "add"
          && sourceRow.correlation_id === request.correlationId
          && isPlainRecord(sourceRow?.payload) && sourceRow.payload.closesAt === request.closesAt
          && payload && Object.keys(payload).length === 2 && payload.roomId === request.roomId
          && payload.closesAt === request.closesAt;
        if (!identityOk) return { status: "rejected", code: "JOB_FAMILY_IDENTITY_INVALID" };
        try { await this.claims.requireCurrent(tx, claim); }
        catch { return { status: "rejected", code: "JOB_CLAIM_STALE" }; }
        const closesAt = new Date(request.closesAt);
        if (this.clock.now().getTime() < closesAt.getTime()) {
          return { status: "retryable", code: "ROOM_CLOSE_NOT_DUE" };
        }
        const room = await tx.query<{ status: string }>("SELECT status FROM classroom_room WHERE room_id = $1 FOR UPDATE", [request.roomId]);
        const status = room.rows[0]?.status;
        let code: "ROOM_CLOSED" | "ALREADY_CLOSED" = "ALREADY_CLOSED";
        if (status === "open" || status === "paused") {
          await appendAutomaticClose(context, request.roomId, request.jobId, closesAt, this.clock, request.correlationId as RoomEventDraft["correlationId"], request.jobId);
          code = "ROOM_CLOSED";
        } else if (status !== "closed") {
          return { status: "rejected", code: "ROOM_DELETION_IN_PROGRESS" };
        }
        await this.claims.completeBusiness(tx, claim, "ROOM_AUTO_CLOSE_COMPLETED");
        return { status: "completed", code };
      });
    } catch (error) {
      if (error instanceof Error && error.message === "JOB_CLAIM_STALE") return { status: "rejected", code: "JOB_CLAIM_STALE" };
      throw error;
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
