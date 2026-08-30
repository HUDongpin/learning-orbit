import { parseRoomEventEnvelope, type ProjectionFrame, type RealtimeFrame, type Status } from "@learning-orbit/contracts";
import type { Pool } from "pg";
import { RealtimeConnection, type SocketLike } from "./connection.js";
import type { CommandService } from "../rooms/command-service.js";
import { RealtimeDeliveryAuthorizer } from "./realtime-delivery-authorizer.js";

export type ProjectionDeliveryDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly closeCode?: 4401 | 4403 | 4410 };

export type ProjectionDeliveryAuthorizer = (input: {
  readonly connection: RealtimeConnection;
  readonly frame: ProjectionFrame;
  readonly principal: import("@learning-orbit/contracts").AuthSession;
  readonly actorId: string;
}) => Promise<ProjectionDeliveryDecision>;

export class RoomHub {
  readonly #rooms = new Map<string, Set<RealtimeConnection>>();
  constructor(private readonly pool: Pool, readonly authorizer: RealtimeDeliveryAuthorizer) {}
  connect(socket: SocketLike, identity: ConstructorParameters<typeof RealtimeConnection>[1], commands: CommandService): RealtimeConnection { const connection = new RealtimeConnection(socket, identity, this.authorizer, commands, this); let set = this.#rooms.get(identity.roomId); if (!set) this.#rooms.set(identity.roomId, set = new Set()); set.add(connection); return connection; }
  leave(connection: RealtimeConnection): void { const set = this.#rooms.get(connection.identity.roomId); if (!set) return; set.delete(connection); if (!set.size) this.#rooms.delete(connection.identity.roomId); }
  async roomState(roomId: string): Promise<{ cursor: number; status: Status }> { const result = await this.pool.query<{ next_room_seq: string; status: Status }>("SELECT next_room_seq,status FROM classroom_room WHERE room_id=$1", [roomId]); const row = result.rows[0]; if (!row) throw new Error("ROOM_NOT_FOUND"); return { cursor: Math.max(0, Number(row.next_room_seq) - 1), status: row.status }; }
  async broadcastEphemeral(roomId: string, frame: RealtimeFrame): Promise<void> { for (const connection of [...(this.#rooms.get(roomId) ?? [])]) { if (!connection.helloReceived) continue; const result = await this.authorizer.reauthorize(connection.identity.sessionId, roomId); if (!result.ok) { connection.close(result.closeCode, "authorization changed"); continue; } connection.send(frame); } }
  async broadcastAuthorized(roomId: string, frame: RealtimeFrame): Promise<number> { let sent = 0; for (const connection of [...(this.#rooms.get(roomId) ?? [])]) { const result = await this.authorizer.reauthorize(connection.identity.sessionId, roomId); if (!result.ok) { connection.close(result.closeCode, "authorization changed"); continue; } if (frame.type === "event") connection.sendDurable(frame); else connection.send(frame); sent += 1; } return sent; }
  /**
   * Deliver a durable analytics pointer only after the caller has evaluated
   * the exact projection grant for this socket.  A denied student promotion
   * is a silent skip; an expired session/room is closed with its protocol
   * code.  The pointer itself contains no projection payload, so reconnects
   * can safely hydrate it through the authenticated latest endpoint.
   */
  async broadcastProjectionAuthorized(
    roomId: string,
    frame: ProjectionFrame,
    authorize: ProjectionDeliveryAuthorizer,
  ): Promise<number> {
    if (frame.roomId !== roomId) return 0;
    let sent = 0;
    for (const connection of [...(this.#rooms.get(roomId) ?? [])]) {
      if (!connection.helloReceived) continue;
      const base = await this.authorizer.reauthorize(connection.identity.sessionId, roomId);
      if (!base.ok) {
        connection.close(base.closeCode, "authorization changed");
        continue;
      }
      let decision: ProjectionDeliveryDecision;
      try {
        decision = await authorize({ connection, frame, principal: base.principal, actorId: base.actorId });
      } catch {
        // A policy/database failure must not leak a pointer.  The socket stays
        // connected so a transient promotion read can recover on heartbeat.
        continue;
      }
      if (!decision.allow) {
        if (decision.closeCode !== undefined) connection.close(decision.closeCode, "authorization changed");
        continue;
      }
      connection.send(frame);
      sent += 1;
    }
    return sent;
  }
  async resume(connection: RealtimeConnection): Promise<void> {
    const resumeFrom = connection.resumeFrom;
    const roomId = connection.identity.roomId;
    const result = await this.pool.query<{ room_seq: string; envelope: unknown }>(
      "SELECT o.room_seq,o.envelope FROM outbox_event o WHERE o.room_id=$1 AND o.room_seq>$2 ORDER BY o.room_seq ASC LIMIT 501",
      [roomId, resumeFrom],
    );
    if (result.rows.length > 500) {
      const through = Number(result.rows.at(-1)!.room_seq);
      connection.send({ type: "snapshot_required", afterSeq: resumeFrom, throughRoomSeq: through });
      // No durable rows were sent.  Closing makes the cursor semantics
      // explicit: the client must rebuild from a snapshot and reconnect.
      return connection.close(4409, "snapshot required");
    }
    let through = resumeFrom;
    for (const row of result.rows) {
      const rowSeq = Number(row.room_seq);
      // The outbox is expected to be contiguous by room sequence.  Treat a
      // gap (or an unsafe/corrupt sequence value) exactly like a malformed
      // envelope: do not advance the replay cursor or announce completion;
      // the client must rebuild from an authenticated snapshot.
      if (!Number.isSafeInteger(rowSeq) || rowSeq !== through + 1) {
        connection.send({ type: "snapshot_required", afterSeq: resumeFrom, throughRoomSeq: through });
        return connection.close(4409, "invalid durable sequence");
      }
      const auth = await this.authorizer.reauthorize(connection.identity.sessionId, roomId);
      if (!auth.ok) return connection.close(auth.closeCode, "authorization changed");
      let event;
      try { event = parseRoomEventEnvelope(row.envelope); }
      catch {
        connection.send({ type: "snapshot_required", afterSeq: resumeFrom, throughRoomSeq: through });
        return connection.close(4409, "invalid durable event");
      }
      if (event.roomSeq !== rowSeq) {
        connection.send({ type: "snapshot_required", afterSeq: resumeFrom, throughRoomSeq: through });
        return connection.close(4409, "invalid durable event");
      }
      through = event.roomSeq;
      connection.send({ type: "event", event });
    }
    connection.send({ type: "resume_complete", throughRoomSeq: through });
    connection.finishReplay(through);
  }
  evictRoom(roomId: string, code = 4410): void { for (const connection of [...(this.#rooms.get(roomId) ?? [])]) connection.close(code, "room closed"); }
}
