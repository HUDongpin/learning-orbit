import { describe, expect, it, vi } from "vitest";

import { RoomSocket, type SocketLike } from "../src/lib/realtime/room-socket.js";

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
      eventId: EVENT_ID,
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
    expect(ws.sent).toHaveLength(1);
    socket.onFrame({ type: "resume_complete", throughRoomSeq: 0 }, ws);
    expect(ws.sent).toHaveLength(2);
    socket.onFrame(event(1), ws);
    socket.onFrame(event(1), ws);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(socket.lastRoomSeq).toBe(1);
    expect(socket.pendingCommandIds()).toEqual([COMMAND_ID]);
    socket.onFrame({ type: "ack", commandId: COMMAND_ID, roomSeq: 1, revision: 1 }, ws);
    expect(socket.pendingCommandIds()).toEqual([]);
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
});
