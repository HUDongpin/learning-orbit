import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { agentContract, type AuthSession } from "@learning-orbit/contracts";
import type { Clock } from "../../clock.js";
import { AgentRepository, type AgentRunOwner } from "./agent-repository.js";
import { ProviderHealthRepository } from "./provider-health-repository.js";

export class AgentError extends Error {
  constructor(readonly code: string) { super(code); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AgentService {
  readonly repository: AgentRepository;
  private readonly providerId: string;
  private readonly manifestSha256: string;
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
    private readonly healthRepository: ProviderHealthRepository = new ProviderHealthRepository(pool, clock),
    options: Readonly<{ providerId?: string; manifestSha256?: string }> = {},
  ) {
    this.repository = new AgentRepository(pool, clock);
    this.providerId = options.providerId ?? "fixture";
    this.manifestSha256 = options.manifestSha256 ?? "0".repeat(64);
  }

  async request(principal: AuthSession, sessionId: string, roomId: string, triggerEventId: string) {
    const owner = await this.authorizeMember(principal, sessionId, roomId);
    const room = await this.pool.query<{ status: string; agent_enabled: boolean; nova_actor_id: string }>("SELECT status, agent_enabled, nova_actor_id FROM classroom_room WHERE room_id = $1", [roomId]);
    const roomRow = room.rows[0];
    if (!roomRow) throw new AgentError("ROOM_NOT_FOUND");
    if (roomRow.status !== "open") throw new AgentError("ROOM_NOT_OPEN");
    if (!roomRow.agent_enabled) throw new AgentError("AGENT_DISABLED");
    const trigger = await this.pool.query<{ event_id: string; actor_kind: string; operation: string; payload: { mentions?: unknown }; correlation_id: string }>(
      "SELECT event_id, actor_kind, operation, payload, correlation_id FROM room_event WHERE room_id = $1 AND event_id = $2", [roomId, triggerEventId],
    );
    const event = trigger.rows[0];
    if (!event) throw new AgentError("TRIGGER_EVENT_NOT_FOUND");
    if (event.actor_kind === "agent") throw new AgentError("AGENT_CANNOT_TRIGGER_AGENT");
    if (event.operation === "retract") throw new AgentError("TRIGGER_EVENT_NOT_ACTIVE");
    const mentions = Array.isArray(event.payload?.mentions) ? event.payload.mentions : [];
    if (owner.role !== "teacher" && !mentions.includes(roomRow.nova_actor_id)) throw new AgentError("EXPLICIT_TRIGGER_REQUIRED");
    try {
      return await this.repository.getOrCreateRunAndJob({ roomId, triggerEventId, correlationId: event.correlation_id, owner, sessionId });
    } catch (error) {
      if (error instanceof Error && ["AGENT_RUN_ALREADY_ACTIVE", "TRIGGER_EVENT_NOT_FOUND"].includes(error.message)) throw new AgentError(error.message);
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
    return this.repository.getCurrent(roomId, () => this.healthRepository.current(this.providerId, this.manifestSha256));
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
      ? await this.pool.query<{ actor_id: string }>(`SELECT teacher_id AS actor_id FROM classroom_room WHERE room_id = $1 AND teacher_id = $2 AND EXISTS (SELECT 1 FROM auth_session WHERE session_id = $3 AND teacher_id = $2 AND principal_kind = 'teacher' AND revoked_at IS NULL AND expires_at > now())`, [roomId, principal.teacherId, sessionId])
      : await this.pool.query<{ room_member_id: string; actor_id: string }>(`SELECT m.room_member_id, m.actor_id FROM room_member m JOIN auth_session s ON s.room_member_id = m.room_member_id WHERE m.room_id = $1 AND m.room_member_id = $2 AND s.session_id = $3 AND s.principal_kind = 'student' AND s.revoked_at IS NULL AND s.expires_at > now()`, [roomId, principal.roomMemberId, sessionId]);
    const row = result.rows[0];
    if (!row) throw new AgentError("ROOM_NOT_FOUND");
    return principal.role === "teacher"
      ? { role: "teacher", teacherId: principal.teacherId, roomMemberId: null, actorId: principal.actorId }
      : { role: "student", teacherId: null, roomMemberId: principal.roomMemberId, actorId: row.actor_id };
  }
}
