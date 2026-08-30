import { describe, expect, it, vi } from "vitest";

import { RoomSocket, roomWebSocketUrl, type SocketLike } from "../src/lib/realtime/room-socket.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const EVENT_ID = "00000000-0000-4000-8000-000000000101";
const COMMAND_ID = "00000000-0000-4000-8000-000000000201";
const ACTOR_ID = "00000000-0000-4000-8000-000000000301";
const CORRELATION = "00000000-0000-4000-8000-000000000401";
const AT = "2026-08-30T09:00:00.000Z";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function command() {
  return {
    commandId: COMMAND_ID,
    roomId: ROOM_ID,
    type: "message.add" as const,
    clientTime: AT,
    payload: { text: "hello", mentions: [], mediaIds: [], replyTo: null },
  };
}

function event(roomSeq: number) {
  return {
    type: "event" as const,
    event: {
      eventId: `00000000-0000-4000-8001-${String(roomSeq).padStart(12, "0")}`,
      schemaVersion: 1 as const,
      roomId: ROOM_ID,
      roomSeq,
      type: "message.added",
      actorId: ACTOR_ID,
      actorKind: "human" as const,
      actorRole: "student" as const,
      revision: 1,
      operation: "add" as const,
      eventTime: AT,
      ingestTime: AT,
      causationId: COMMAND_ID,
      correlationId: CORRELATION,
      payload: {
        messageId: "00000000-0000-4000-8000-000000000501",
        text: "hello",
        replyTo: null,
        mentions: [],
        mediaIds: [],
      },
    },
  };
}

function fakeSocket(): SocketLike & { sent: string[] } {
  const sent: string[] = [];
  return { sent, readyState: 1, send: (value: string) => sent.push(value) };
}

describe("RoomSocket", () => {
  it("resumes, resends pending commands, and deduplicates events", () => {
    const sink = vi.fn();
    const socket = new RoomSocket(ROOM_ID, new MemoryStorage(), sink);
    const ws = fakeSocket();

    expect(socket.hello()).toEqual({ type: "hello", clientId: expect.any(String), resumeFrom: 0 });
    socket.send(command(), ws);
    expect(ws.sent).toHaveLength(0);
    socket.onFrame({ type: "resume_complete", throughRoomSeq: 0 }, ws);
    expect(ws.sent).toHaveLength(1);
    socket.onFrame(event(1), ws);
    socket.onFrame(event(1), ws);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(socket.lastRoomSeq).toBe(1);
    expect(socket.pendingCommandIds()).toEqual([COMMAND_ID]);
    socket.onFrame({ type: "ack", commandId: COMMAND_ID, roomSeq: 1, revision: 1 }, ws);
    expect(socket.pendingCommandIds()).toEqual([]);
  });

  it("never advances across a gap or an incomplete resume", () => {
    const sink = vi.fn();
    const controls = vi.fn();
    const socket = new RoomSocket(ROOM_ID, new MemoryStorage(), sink, {}, controls);
    socket.onFrame(event(2));
    expect(socket.lastRoomSeq).toBe(0);
    expect(controls).toHaveBeenLastCalledWith({ type: "snapshot_required", afterSeq: 0, throughRoomSeq: 1 });
    socket.onFrame(event(1));
    expect(socket.lastRoomSeq).toBe(1);
    socket.onFrame({ type: "resume_complete", throughRoomSeq: 3 });
    expect(socket.lastRoomSeq).toBe(1);
    expect(controls).toHaveBeenLastCalledWith({ type: "snapshot_required", afterSeq: 1, throughRoomSeq: 3 });
  });

  it("keeps retryable rejects pending but clears terminal rejects", () => {
    const controls = vi.fn();
    const socket = new RoomSocket(ROOM_ID, new MemoryStorage(), vi.fn(), {}, controls);
    socket.send(command(), fakeSocket());
    socket.onFrame({ type: "reject", commandId: COMMAND_ID, code: "INTERNAL", retryable: true });
    expect(socket.pendingCommandIds()).toEqual([COMMAND_ID]);
    socket.onFrame({ type: "reject", commandId: COMMAND_ID, code: "ROOM_NOT_OPEN", retryable: false });
    expect(socket.pendingCommandIds()).toEqual([]);
    expect(controls).toHaveBeenCalledTimes(2);
  });

  it("keeps one immutable command per id and bounds the disconnected retry queue", () => {
    const socket = new RoomSocket(ROOM_ID, new MemoryStorage(), vi.fn());
    const disconnected: SocketLike = { readyState: 0, send: vi.fn() };
    socket.send(command(), disconnected);
    expect(() => socket.send({ ...command(), payload: { ...command().payload, text: "changed" } }, disconnected))
      .toThrow("COMMAND_ID_CONFLICT");
    for (let index = 1; index < 100; index += 1) {
      socket.send({
        ...command(),
        commandId: `00000000-0000-4000-8005-${String(index).padStart(12, "0")}`,
      }, disconnected);
    }
    expect(socket.pendingCommandIds()).toHaveLength(100);
    expect(() => socket.send({
      ...command(),
      commandId: "00000000-0000-4000-8005-000000000100",
    }, disconnected)).toThrow("PENDING_COMMAND_LIMIT");
  });

  it("routes non-event frames without mutating the durable cursor", () => {
    const controls = vi.fn();
    const socket = new RoomSocket(ROOM_ID, new MemoryStorage(), vi.fn(), {}, controls);
    const frames = [
      { type: "welcome", serverTime: AT, roomId: ROOM_ID, cursor: 4, status: "open" },
      { type: "presence", actorId: ACTOR_ID, state: "active", expiresAt: AT },
      { type: "typing", actorId: ACTOR_ID, active: true, expiresAt: AT },
      { type: "degraded", scope: "media", code: "PROVIDER_UNAVAILABLE", updatedAt: AT },
      { type: "projection", roomId: ROOM_ID, projectionKey: "echo.student_approved", analysisEpoch: CORRELATION, projectionVersion: 1, completeThroughRoomSeq: 0, snapshotUrl: `/v1/rooms/${ROOM_ID}/analytics/echo.student_approved/latest` },
    ] as const;
    for (const frame of frames) socket.onFrame(frame);
    expect(controls.mock.calls.map(([frame]) => frame.type)).toEqual(["welcome", "presence", "typing", "degraded", "projection"]);
    expect(socket.lastRoomSeq).toBe(0);
  });

  it("binds a native-style socket, sends generated hello on open, and parses text frames", () => {
    const listeners = new Map<string, (event: { data?: unknown }) => void>();
    const sent: string[] = [];
    const native = {
      readyState: 0,
      send: (value: string) => sent.push(value),
      addEventListener: (type: string, listener: (event: { data?: unknown }) => void) => listeners.set(type, listener),
    };
    const sink = vi.fn();
    const connectionChange = vi.fn();
    const socket = new RoomSocket(ROOM_ID, new MemoryStorage(), sink, {
      clientId: "00000000-0000-4000-8000-000000000777",
      onConnectionChange: connectionChange,
    });
    socket.connect(() => native);
    expect(sent).toEqual([]);
    listeners.get("open")?.({});
    expect(connectionChange).toHaveBeenLastCalledWith(false);
    expect(JSON.parse(sent[0]!)).toEqual({ type: "hello", clientId: "00000000-0000-4000-8000-000000000777", resumeFrom: 0 });
    listeners.get("message")?.({ data: JSON.stringify({ type: "resume_complete", throughRoomSeq: 0 }) });
    expect(connectionChange).toHaveBeenLastCalledWith(true);
    listeners.get("message")?.({ data: JSON.stringify(event(1)) });
    expect(sink).toHaveBeenCalledWith(event(1).event);
  });

  it("queues commands until resume completes and recovers a synchronous transport send failure", () => {
    vi.useFakeTimers();
    try {
      const firstSent: string[] = [];
      let failCommands = false;
      const first: SocketLike = {
        readyState: 1,
        send(value) {
          const type = JSON.parse(value).type;
          if (type === "command" && failCommands) throw new Error("transport failed");
          firstSent.push(value);
        },
        close: vi.fn(),
      };
      const second = fakeSocket();
      const connect = vi.fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second);
      const socket = new RoomSocket(ROOM_ID, new MemoryStorage(), vi.fn(), { retryDelaysMs: [10] });
      socket.connect(connect);
      socket.send(command());
      expect(firstSent.map((value) => JSON.parse(value).type)).toEqual(["hello"]);
      socket.onFrame({ type: "resume_complete", throughRoomSeq: 0 }, first);
      expect(firstSent.map((value) => JSON.parse(value).type)).toEqual(["hello", "command"]);

      failCommands = true;
      const secondCommand = { ...command(), commandId: "00000000-0000-4000-8000-000000000202" };
      expect(() => socket.send(secondCommand)).not.toThrow();
      expect(socket.pendingCommandIds()).toContain(secondCommand.commandId);
      vi.advanceTimersByTime(10);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(second.sent.map((value) => JSON.parse(value).type)).toEqual(["hello"]);
      socket.onFrame({ type: "resume_complete", throughRoomSeq: 0 }, second);
      const resent = second.sent.map((value) => JSON.parse(value));
      expect(resent.filter(({ type }) => type === "command").map(({ command: value }) => value.commandId))
        .toEqual([COMMAND_ID, secondCommand.commandId]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries reconnect with bounded exponential delays", () => {
    vi.useFakeTimers();
    const socket = new RoomSocket(ROOM_ID, new MemoryStorage(), vi.fn(), { retryDelaysMs: [10, 20] });
    const connect = vi.fn(() => fakeSocket());
    socket.connect(connect);
    expect(connect).toHaveBeenCalledTimes(1);
    socket.onClose();
    vi.advanceTimersByTime(10);
    expect(connect).toHaveBeenCalledTimes(2);
    socket.onClose();
    vi.advanceTimersByTime(20);
    expect(connect).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("stops reconnect and reports an expired server session on close 4401", () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const connect = vi.fn(() => fakeSocket());
    const socket = new RoomSocket(ROOM_ID, new MemoryStorage(), vi.fn(), {
      retryDelaysMs: [10],
      onSessionExpired: expired,
    });
    socket.connect(connect);
    socket.onClose(4401);
    vi.advanceTimersByTime(100);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it.each([4403, 4410] as const)("stops reconnect and reports hidden room authority loss on close %s", (code) => {
    vi.useFakeTimers();
    try {
      const unavailable = vi.fn();
      const expired = vi.fn();
      const connect = vi.fn(() => fakeSocket());
      const socket = new RoomSocket(ROOM_ID, new MemoryStorage(), vi.fn(), {
        retryDelaysMs: [10],
        onSessionExpired: expired,
        onRoomUnavailable: unavailable,
      });
      socket.connect(connect);
      socket.onClose(code);
      vi.advanceTimersByTime(100);
      expect(unavailable).toHaveBeenCalledWith(code);
      expect(expired).not.toHaveBeenCalled();
      expect(connect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for authenticated gap recovery before reconnecting with the new cursor", async () => {
    vi.useFakeTimers();
    try {
      let finishRecovery!: () => void;
      const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
      const sockets: Array<SocketLike & { sent: string[] }> = [];
      const connect = vi.fn(() => {
        const next = fakeSocket();
        sockets.push(next);
        return next;
      });
      const socket = new RoomSocket(ROOM_ID, new MemoryStorage(), vi.fn(), { retryDelaysMs: [10] });
      socket.connect(connect);
      socket.deferReconnectUntil(recovery);
      socket.onClose(4409);
      vi.advanceTimersByTime(100);
      expect(connect).toHaveBeenCalledOnce();

      socket.onFrame(event(1));
      finishRecovery();
      await recovery;
      await Promise.resolve();
      vi.advanceTimersByTime(10);

      expect(connect).toHaveBeenCalledTimes(2);
      expect(JSON.parse(sockets[1]!.sent[0]!)).toMatchObject({ type: "hello", resumeFrom: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed once on an invalid server frame without reconnecting", () => {
    vi.useFakeTimers();
    try {
      const listeners = new Map<string, (event: { data?: unknown; code?: number }) => void>();
      const close = vi.fn();
      const native: SocketLike = {
        readyState: 0,
        send: vi.fn(),
        close,
        addEventListener: (type, listener) => listeners.set(type, listener),
      };
      const protocolError = vi.fn();
      const connectionChange = vi.fn();
      const connect = vi.fn(() => native);
      const socket = new RoomSocket(ROOM_ID, new MemoryStorage(), vi.fn(), {
        retryDelaysMs: [10],
        onConnectionChange: connectionChange,
        onProtocolError: protocolError,
      });

      socket.connect(connect);
      listeners.get("message")?.({ data: "{not-json" });
      listeners.get("close")?.({ code: 4400 });
      vi.advanceTimersByTime(100);

      expect(close).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledWith(4400, "invalid server frame");
      expect(protocolError).toHaveBeenCalledOnce();
      expect(connectionChange).toHaveBeenLastCalledWith(false);
      expect(connect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives one credential-free same-origin WebSocket URL", () => {
    expect(roomWebSocketUrl(ROOM_ID, { protocol: "https:", host: "127.0.0.1:3000" }))
      .toBe(`wss://127.0.0.1:3000/v1/rooms/${ROOM_ID}/realtime`);
    expect(roomWebSocketUrl(ROOM_ID, { protocol: "http:", host: "localhost:3000" }))
      .toBe(`ws://localhost:3000/v1/rooms/${ROOM_ID}/realtime`);
    expect(roomWebSocketUrl(ROOM_ID, { protocol: "https:", host: "127.0.0.1:3000" })).not.toMatch(/[?&](token|ticket)=/i);
    expect(() => roomWebSocketUrl("demo-room", { protocol: "https:", host: "127.0.0.1:3000" })).toThrow("INVALID_ROOM_ID");
  });
});
