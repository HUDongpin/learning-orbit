import { realtimeContract, type AuthSession, type RealtimeFrame } from "@learning-orbit/contracts";
import type { CommandService } from "../rooms/command-service.js";
import type { RealtimeDeliveryAuthorizer, DeliveryAuthorization } from "./realtime-delivery-authorizer.js";
import type { RoomHub } from "./room-hub.js";
import { EphemeralSignals } from "./ephemeral-signals.js";

export interface SocketLike { send(data: string): void; close(code?: number, reason?: string): void; on(event: string, cb: (...args: any[]) => void): void; }
export interface ConnectionIdentity { readonly sessionId: string; readonly roomId: string; readonly principal: AuthSession; readonly actorId: string; }

export class RealtimeConnection {
  readonly signals = new EphemeralSignals();
  #hello = false; #closed = false; #replaying = true; #resumeFrom = 0; #replayThrough = 0;
  #liveBuffer: RealtimeFrame[] = [];
  #lastPresence = 0; #lastTyping = 0; #lastClientSeq = -1;
  #helloTimer!: ReturnType<typeof setTimeout>; #heartbeatTimer!: ReturnType<typeof setInterval>;
  constructor(readonly socket: SocketLike, readonly identity: ConnectionIdentity, private readonly authorizer: RealtimeDeliveryAuthorizer, private readonly commands: CommandService, private readonly hub: RoomHub, private readonly now: () => Date = () => new Date()) {
    this.#helloTimer = setTimeout(() => { if (!this.#hello) this.close(4400, "hello required"); }, 5_000);
    this.#heartbeatTimer = setInterval(() => void this.receive({ type: "heartbeat" }), 15_000);
    socket.on("message", (raw: unknown) => void this.receive(raw)); socket.on("close", () => this.close(1000, "closed"));
  }
  get helloReceived() { return this.#hello; }
  get resumeFrom() { return this.#resumeFrom; }
  send(frame: RealtimeFrame): void { if (!this.#closed) this.socket.send(JSON.stringify(frame)); }
  /** Deliver a durable event only after hello + ordered resume have completed. */
  sendDurable(frame: Extract<RealtimeFrame, { type: "event" }>): void {
    if (this.#closed) return;
    if (!this.#hello || this.#replaying) {
      this.#liveBuffer.push(frame);
      return;
    }
    this.send(frame);
  }

  /** End the replay gate and flush only events not covered by the replay cursor. */
  finishReplay(throughRoomSeq: number): void {
    if (this.#closed) return;
    this.#replayThrough = Math.max(this.#replayThrough, throughRoomSeq);
    this.#replaying = false;
    const pending = this.#liveBuffer.splice(0).sort((a, b) => a.event.roomSeq - b.event.roomSeq);
    for (const frame of pending) {
      if (frame.event.roomSeq > this.#replayThrough) {
        this.send(frame);
        this.#replayThrough = frame.event.roomSeq;
      }
    }
  }
  async receive(raw: unknown): Promise<void> {
    if (this.#closed) return;
    let value: unknown = raw;
    try { if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) value = JSON.parse(Buffer.from(raw).toString("utf8")); else if (typeof raw === "string") value = JSON.parse(raw); const frame = realtimeContract.parseRealtimeFrame(value); await this.#handle(frame); }
    catch { this.close(4400, "invalid frame"); }
  }
  async #reauthorize(): Promise<DeliveryAuthorization & { ok: true }> {
    const result = await this.authorizer.reauthorize(this.identity.sessionId, this.identity.roomId);
    if (!result.ok) { this.close(result.closeCode, "authorization changed"); throw new Error("CLOSED"); }
    return result;
  }
  async #handle(frame: RealtimeFrame): Promise<void> {
    if (!this.#hello) {
      if (frame.type !== "hello") return this.close(4400, "hello required");
      this.#hello = true; this.#resumeFrom = frame.resumeFrom; clearTimeout(this.#helloTimer);
      const authorized = await this.authorizer.reauthorize(this.identity.sessionId, this.identity.roomId);
      if (!authorized.ok) return this.close(authorized.closeCode, "authorization changed");
      const room = await this.hub.roomState(this.identity.roomId); this.send({ type: "welcome", serverTime: this.now().toISOString(), roomId: this.identity.roomId, cursor: room.cursor, status: room.status });
      await this.hub.resume(this); return;
    }
    const auth = await this.#reauthorize();
    if (frame.type === "heartbeat") {
      const expired = this.signals.expire(this.now().getTime());
      for (const signal of expired) void this.hub.broadcastEphemeral(this.identity.roomId, signal);
      this.send({ type: "heartbeat", serverTime: this.now().toISOString() });
      return;
    }
    if (frame.type === "command") {
      try { const result = await this.commands.dispatch(auth.principal, frame.command, this.identity.sessionId); this.send({ type: "ack", commandId: frame.command.commandId, roomSeq: result.roomSeq, revision: result.revision }); }
      catch (error) { const code = error instanceof Error && ["FORBIDDEN","ROOM_NOT_OPEN","MESSAGE_NOT_FOUND","REVISION_CONFLICT","INVALID_COMMAND"].includes(error.message) ? error.message : "INTERNAL"; this.send({ type: "reject", commandId: frame.command.commandId, code: code as any }); }
      return;
    }
    const now = this.now().getTime();
    if (frame.type === "presence" && "clientSeq" in frame) { if (now - this.#lastPresence < 5_000 || frame.clientSeq <= this.#lastClientSeq) return; this.#lastPresence = now; this.#lastClientSeq = frame.clientSeq; const signal = this.signals.acceptPresence(auth.actorId, frame.state, frame.clientSeq, now); if (signal) void this.hub.broadcastEphemeral(this.identity.roomId, signal); return; }
    if (frame.type === "typing" && "clientSeq" in frame) { if (now - this.#lastTyping < 500 || frame.clientSeq <= this.#lastClientSeq) return; this.#lastTyping = now; this.#lastClientSeq = frame.clientSeq; const signal = this.signals.acceptTyping(auth.actorId, frame.active, frame.clientSeq, now); if (signal) void this.hub.broadcastEphemeral(this.identity.roomId, signal); return; }
  }
  close(code = 1000, reason = "closed"): void { if (this.#closed) return; this.#closed = true; this.#liveBuffer = []; clearTimeout(this.#helloTimer); clearInterval(this.#heartbeatTimer); try { this.socket.close(code, reason); } finally { this.hub.leave(this); } }
}
