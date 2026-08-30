import type { ServerPresence, ServerTyping } from "@learning-orbit/contracts";

export class EphemeralSignals {
  readonly #presence = new Map<string, { seq: number; expiresAt: number }>();
  readonly #typing = new Map<string, { seq: number; expiresAt: number }>();
  acceptPresence(actorId: string, state: "active" | "away", seq: number, now = Date.now()): ServerPresence | null {
    const old = this.#presence.get(actorId); if (old && seq <= old.seq) return null;
    const expiresAt = now + 30_000; this.#presence.set(actorId, { seq, expiresAt });
    return { type: "presence", actorId, state, expiresAt: new Date(expiresAt).toISOString() };
  }
  acceptTyping(actorId: string, active: boolean, seq: number, now = Date.now()): ServerTyping | null {
    const old = this.#typing.get(actorId); if (old && seq <= old.seq) return null;
    const expiresAt = now + 5_000; this.#typing.set(actorId, { seq, expiresAt });
    return { type: "typing", actorId, active, expiresAt: new Date(expiresAt).toISOString() };
  }
  expire(now = Date.now()): Array<ServerPresence | ServerTyping> {
    const out: Array<ServerPresence | ServerTyping> = [];
    for (const [actorId, value] of this.#presence) if (value.expiresAt <= now) { this.#presence.delete(actorId); out.push({ type: "presence", actorId, state: "away", expiresAt: new Date(now).toISOString() }); }
    for (const [actorId, value] of this.#typing) if (value.expiresAt <= now) { this.#typing.delete(actorId); out.push({ type: "typing", actorId, active: false, expiresAt: new Date(now).toISOString() }); }
    return out;
  }
  remove(actorId: string, now = Date.now()): Array<ServerPresence | ServerTyping> { this.#presence.delete(actorId); this.#typing.delete(actorId); return [{ type: "presence", actorId, state: "away", expiresAt: new Date(now).toISOString() }, { type: "typing", actorId, active: false, expiresAt: new Date(now).toISOString() }]; }
}
