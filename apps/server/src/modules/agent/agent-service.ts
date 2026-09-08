import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { agentContract, type AuthSession } from "@learning-orbit/contracts";
import type { Clock } from "../../clock.js";
import { AgentRepository, type AgentRunOwner } from "./agent-repository.js";
import { ProviderHealthRepository } from "./provider-health-repository.js";
import { UNCONFIGURED_PROVIDER_SCOPE, type AgentProviderScope } from "./provider-manifest.js";

export class AgentError extends Error {
  constructor(readonly code: string) { super(code); }
}

export type AgentRequestOptions = Readonly<{ admitCreate?: () => Promise<void> }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AgentService {
  readonly repository: AgentRepository;
  private readonly providerId: string;
  private readonly manifestSha256: string;
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
    private readonly healthRepository: ProviderHealthRepository = new ProviderHealthRepository(pool, clock),
    options: Partial<AgentProviderScope> = {},
  ) {
    this.repository = new AgentRepository(pool, clock);
    // An unsupplied scope is the refusing one, never a permissive default: a
    // caller that forgets to pass the reviewed manifest gets a service that
    // admits nothing rather than one bound to a provider nobody approved.
    this.providerId = options.providerId ?? UNCONFIGURED_PROVIDER_SCOPE.providerId;
    this.manifestSha256 = options.manifestSha256 ?? UNCONFIGURED_PROVIDER_SCOPE.manifestSha256;
  }

  /** Pre-parse room/session authorization; command methods recheck it. */
  async authorize(principal: AuthSession, sessionId: string, roomId: string): Promise<void> {
    await this.authorizeMember(principal, sessionId, roomId);
  }

  async request(principal: AuthSession, sessionId: string, roomId: string, triggerEventId: string, options: AgentRequestOptions = {}) {
    const owner = await this.authorizeMember(principal, sessionId, roomId);
    try {
      return await this.repository.getOrCreateRunAndJob({
        roomId,
        triggerEventId,
        owner,
        sessionId,
        beforeCreate: async (tx) => {
          const providerHealth = await this.healthRepository.current(this.providerId, this.manifestSha256, tx, true);
          if (providerHealth !== "healthy") throw new AgentError("AGENT_SERVICE_UNAVAILABLE");
          await options.admitCreate?.();
        },
      });
    } catch (error) {
      if (error instanceof Error && [
        "ROOM_NOT_FOUND",
        "ROOM_DELETION_IN_PROGRESS",
        "ROOM_NOT_OPEN",
        "AGENT_DISABLED",
        "TRIGGER_EVENT_NOT_FOUND",
        "AGENT_CANNOT_TRIGGER_AGENT",
        "TRIGGER_EVENT_NOT_ACTIVE",
        "EXPLICIT_TRIGGER_REQUIRED",
        "AGENT_RUN_ALREADY_ACTIVE",
      ].includes(error.message)) throw new AgentError(error.message);
      throw error;
    }
  }

  async cancel(principal: AuthSession, sessionId: string, roomId: string, runId: string) {
    if (principal.role !== "teacher") throw new AgentError("FORBIDDEN");
    await this.authorizeMember(principal, sessionId, roomId);
    try { return await this.repository.cancelRun(roomId, runId, principal.teacherId, randomUUID(), sessionId); }
    catch (error) { if (error instanceof Error) throw new AgentError(error.message); throw error; }
  }

  async current(principal: AuthSession, sessionId: string, roomId: string) {
    await this.authorizeMember(principal, sessionId, roomId);
    try {
      return await this.repository.getCurrent(
        roomId,
        () => this.healthRepository.current(this.providerId, this.manifestSha256),
      );
    } catch (error) {
      if (error instanceof Error && ["ROOM_NOT_FOUND", "ROOM_DELETION_IN_PROGRESS"].includes(error.message)) {
        throw new AgentError(error.message);
      }
      throw error;
    }
  }

  async settings(principal: AuthSession, sessionId: string, roomId: string, enabled: boolean) {
    if (principal.role !== "teacher") throw new AgentError("FORBIDDEN");
    await this.authorizeMember(principal, sessionId, roomId);
    try { return await this.repository.setEnabled(roomId, principal.teacherId, enabled, randomUUID(), sessionId); }
    catch (error) { if (error instanceof Error) throw new AgentError(error.message); throw error; }
  }

  private async authorizeMember(principal: AuthSession, sessionId: string, roomId: string): Promise<AgentRunOwner> {
    if (!UUID.test(roomId) || !UUID.test(sessionId)) throw new AgentError("ROOM_NOT_FOUND");
    if (principal.role === "student" && principal.roomId !== roomId) throw new AgentError("ROOM_NOT_FOUND");
    const result = principal.role === "teacher"
      ? await this.pool.query<{ actor_id: string; deletion_active: boolean }>(
        `SELECT r.teacher_id AS actor_id,
                EXISTS (SELECT 1 FROM deletion_job d WHERE d.room_id=r.room_id AND d.status IN ('queued','running','retryable','dead')) AS deletion_active
           FROM classroom_room r
          WHERE r.room_id = $1 AND r.teacher_id = $2
            AND EXISTS (SELECT 1 FROM auth_session WHERE session_id = $3 AND teacher_id = $2 AND principal_kind = 'teacher' AND revoked_at IS NULL AND expires_at > now())`,
        [roomId, principal.teacherId, sessionId],
      )
      : await this.pool.query<{ room_member_id: string; actor_id: string; deletion_active: boolean }>(
        `SELECT m.room_member_id, m.actor_id,
                EXISTS (SELECT 1 FROM deletion_job d WHERE d.room_id=m.room_id AND d.status IN ('queued','running','retryable','dead')) AS deletion_active
           FROM room_member m JOIN auth_session s ON s.room_member_id = m.room_member_id
          WHERE m.room_id = $1 AND m.room_member_id = $2 AND s.session_id = $3
            AND s.principal_kind = 'student' AND s.revoked_at IS NULL AND s.expires_at > now()`,
        [roomId, principal.roomMemberId, sessionId],
      );
    const row = result.rows[0];
    if (!row) throw new AgentError("ROOM_NOT_FOUND");
    if (row.deletion_active !== false) throw new AgentError("ROOM_DELETION_IN_PROGRESS");
    return principal.role === "teacher"
      ? { role: "teacher", teacherId: principal.teacherId, roomMemberId: null, actorId: principal.actorId }
      : { role: "student", teacherId: null, roomMemberId: principal.roomMemberId, actorId: row.actor_id };
  }
}
