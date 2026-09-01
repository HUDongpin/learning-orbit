import { describe, expect, it, vi } from "vitest";
import { realtimeContract } from "@learning-orbit/contracts";
import { RealtimeConnection } from "../../src/modules/realtime/connection.js";

const ROOM = "00000000-0000-4000-8000-000000000010";
const SESSION = "00000000-0000-4000-8000-000000000011";
const ACTOR = "00000000-0000-4000-8000-000000000012";
const principal = { role: "student", roomId: ROOM, roomMemberId: "00000000-0000-4000-8000-000000000013", actorId: ACTOR, pseudonym: "A", nova: { actorId: "00000000-0000-4000-8000-000000000014", actorKind: "agent", actorRole: "socratic_facilitator", displayName: "Nova Agent" } } as any;
class Socket { sent: string[] = []; closed?: number; handlers = new Map<string, (...args: any[]) => void>(); send(v: string) { this.sent.push(v); } close(c?: number) { this.closed = c; } on(e: string, cb: (...args: any[]) => void) { this.handlers.set(e, cb); } }
function deps() { const authorizer = { reauthorize: vi.fn(async () => ({ ok: true, principal, actorId: ACTOR })) } as any; const hub = { roomState: vi.fn(async () => ({ cursor: 0, status: "open" })), resume: vi.fn(async (connection: { send: (frame: unknown) => void; finishReplay?: (through: number) => void }) => { connection.send({ type: "resume_complete", throughRoomSeq: 0 }); connection.finishReplay?.(0); }), leave: vi.fn(), broadcastEphemeral: vi.fn(async () => undefined) } as any; const commands = { dispatch: vi.fn(async () => ({ roomSeq: 1, revision: 1 })) } as any; return { authorizer, hub, commands }; }
describe("realtime protocol", () => {
  it("buffers durable events until hello and ordered resume finish", async () => {
    const socket = new Socket(); const d = deps();
    const c = new RealtimeConnection(socket as any, { sessionId: SESSION, roomId: ROOM, principal, actorId: ACTOR }, d.authorizer, d.commands, d.hub, () => new Date(0));
    const event = { eventId: "00000000-0000-4000-8000-000000000099", roomId: ROOM, roomSeq: 1 } as any;
    c.sendDurable({ type: "event", event });
    expect(socket.sent).toHaveLength(0);
    await c.receive({ type: "hello", clientId: "00000000-0000-4000-8000-000000000015", resumeFrom: 0 });
    expect(JSON.parse(socket.sent[0]!).type).toBe("welcome");
    expect(JSON.parse(socket.sent[1]!).type).toBe("resume_complete");
    expect(JSON.parse(socket.sent[2]!).type).toBe("event");
  });

  it("holds a live event that arrives during resume behind resume_complete", async () => {
    const socket = new Socket(); const d = deps();
    d.hub.resume = vi.fn(async (connection: { send: (frame: unknown) => void; sendDurable: (frame: any) => void; finishReplay: (through: number) => void }) => {
      connection.sendDurable({ type: "event", event: { eventId: "00000000-0000-4000-8000-000000000098", roomId: ROOM, roomSeq: 1 } });
      connection.send({ type: "resume_complete", throughRoomSeq: 0 });
      connection.finishReplay(0);
    });
    const c = new RealtimeConnection(socket as any, { sessionId: SESSION, roomId: ROOM, principal, actorId: ACTOR }, d.authorizer, d.commands, d.hub, () => new Date(0));
    await c.receive({ type: "hello", clientId: "00000000-0000-4000-8000-000000000015", resumeFrom: 0 });
    expect(JSON.parse(socket.sent[1]!).type).toBe("resume_complete");
    expect(JSON.parse(socket.sent[2]!).type).toBe("event");
  });

  it("expires ephemeral typing on the heartbeat clock and broadcasts the tombstone", async () => {
    const socket = new Socket(); const d = deps(); let now = new Date(0);
    const c = new RealtimeConnection(socket as any, { sessionId: SESSION, roomId: ROOM, principal, actorId: ACTOR }, d.authorizer, d.commands, d.hub, () => now);
    await c.receive({ type: "hello", clientId: "00000000-0000-4000-8000-000000000015", resumeFrom: 0 });
    now = new Date(1_000);
    await c.receive({ type: "typing", active: true, clientSeq: 1 });
    now = new Date(6_001);
    await c.receive({ type: "heartbeat" });
    expect(d.hub.broadcastEphemeral).toHaveBeenCalledWith(ROOM, expect.objectContaining({ type: "typing", actorId: ACTOR, active: false }));
  });

  it.each([
    ["ROOM_DELETION_IN_PROGRESS", "ROOM_DELETION_IN_PROGRESS"],
    ["ROOM_NOT_OPEN", "ROOM_NOT_OPEN"],
    ["FORBIDDEN", "FORBIDDEN"],
    ["MESSAGE_NOT_FOUND", "MESSAGE_NOT_FOUND"],
    ["REVISION_CONFLICT", "REVISION_CONFLICT"],
    ["INVALID_COMMAND", "INVALID_COMMAND"],
    ["SOME_UNMAPPED_INTERNAL_FAULT", "INTERNAL"],
  ] as const)(
    // A code outside the frozen ServerReject enum serialises to a frame the
    // client's own parser refuses, which it escalates to a protocol failure and
    // closes the socket over. Every reject must survive that parser.
    "rejects %s as an on-contract frame the client can parse",
    async (thrown, expected) => {
      const socket = new Socket(); const d = deps();
      d.commands.dispatch = vi.fn(async () => { throw new Error(thrown); });
      const c = new RealtimeConnection(socket as any, { sessionId: SESSION, roomId: ROOM, principal, actorId: ACTOR }, d.authorizer, d.commands, d.hub, () => new Date(0));
      await c.receive({ type: "hello", clientId: "00000000-0000-4000-8000-000000000015", resumeFrom: 0 });
      await c.receive({ type: "command", command: { commandId: "00000000-0000-4000-8000-000000000201", roomId: ROOM, type: "message.add", clientTime: "2026-08-30T09:00:00.000Z", payload: { text: "x", mentions: [], mediaIds: [], replyTo: null } } });
      const frame = JSON.parse(socket.sent.at(-1)!);
      expect(frame).toMatchObject({ type: "reject", code: expected });
      expect(() => realtimeContract.parseServerFrame(frame)).not.toThrow();
      expect(socket.closed).toBeUndefined();
    },
  );

  it("requires hello first and accepts Buffer frames", async () => { const socket = new Socket(); const d = deps(); const c = new RealtimeConnection(socket as any, { sessionId: SESSION, roomId: ROOM, principal, actorId: ACTOR }, d.authorizer, d.commands, d.hub, () => new Date(0)); await c.receive(Buffer.from(JSON.stringify({ type: "hello", clientId: "00000000-0000-4000-8000-000000000015", resumeFrom: 0 }))); expect(socket.sent.length).toBeGreaterThanOrEqual(2); expect(JSON.parse(socket.sent[0]!).type).toBe("welcome"); expect(JSON.parse(socket.sent[1]!).type).toBe("resume_complete"); c.close(); });
  it("closes malformed or pre-hello input with 4400", async () => { const socket = new Socket(); const d = deps(); const c = new RealtimeConnection(socket as any, { sessionId: SESSION, roomId: ROOM, principal, actorId: ACTOR }, d.authorizer, d.commands, d.hub); await c.receive({ type: "heartbeat" }); expect(socket.closed).toBe(4400); });
  it("reauthorizes before command and does not dispatch revoked sessions", async () => { const socket = new Socket(); const d = deps(); const c = new RealtimeConnection(socket as any, { sessionId: SESSION, roomId: ROOM, principal, actorId: ACTOR }, d.authorizer, d.commands, d.hub); await c.receive({ type: "hello", clientId: "00000000-0000-4000-8000-000000000015", resumeFrom: 0 }); d.authorizer.reauthorize.mockResolvedValue({ ok: false, closeCode: 4401 }); await c.receive({ type: "heartbeat" }); expect(socket.closed).toBe(4401); expect(d.commands.dispatch).not.toHaveBeenCalled(); });
  it.each([4403, 4410] as const)("maps authorization loss to close code %i", async (code) => { const socket = new Socket(); const d = deps(); const c = new RealtimeConnection(socket as any, { sessionId: SESSION, roomId: ROOM, principal, actorId: ACTOR }, d.authorizer, d.commands, d.hub); await c.receive({ type: "hello", clientId: "00000000-0000-4000-8000-000000000015", resumeFrom: 0 }); d.authorizer.reauthorize.mockResolvedValue({ ok: false, closeCode: code }); await c.receive({ type: "heartbeat" }); expect(socket.closed).toBe(code); });
});
