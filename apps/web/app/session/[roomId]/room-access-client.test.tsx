import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthSession, RoomDetails } from "@learning-orbit/contracts";
import type { SessionGateway } from "../../../src/lib/session/session-gateway.js";
import { SessionGatewayError } from "../../../src/lib/session/session-gateway.js";
import { RoomAccessClient } from "./room-access-client.js";

const replace = vi.fn();
const router = { replace };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const roomId = "00000000-0000-4000-8000-000000000010";
const otherRoomId = "00000000-0000-4000-8000-000000000099";

const teacher: Extract<AuthSession, { role: "teacher" }> = {
  role: "teacher",
  teacherId: "00000000-0000-4000-8000-000000000001",
  actorId: "00000000-0000-4000-8000-000000000001",
};

const student: Extract<AuthSession, { role: "student" }> = {
  role: "student",
  roomId,
  roomMemberId: "00000000-0000-4000-8000-000000000011",
  actorId: "00000000-0000-4000-8000-000000000012",
  pseudonym: "探索者 A",
  nova: {
    actorId: "00000000-0000-4000-8000-000000000013",
    actorKind: "agent",
    actorRole: "socratic_facilitator",
    displayName: "Nova Agent",
  },
};

const room: RoomDetails = {
  roomId,
  topic: "生態系統探究",
  status: "scheduled",
  durationSeconds: 2700,
  startsAt: null,
  closesAt: null,
  nova: student.nova,
  participants: [
    { actorId: student.actorId, pseudonym: "探索者 A", actorKind: "human", actorRole: "student" },
    { actorId: "00000000-0000-4000-8000-000000000014", pseudonym: "探索者 B", actorKind: "human", actorRole: "student" },
    { actorId: "00000000-0000-4000-8000-000000000015", pseudonym: "探索者 C", actorKind: "human", actorRole: "student" },
    { actorId: "00000000-0000-4000-8000-000000000016", pseudonym: "探索者 D", actorKind: "human", actorRole: "student" },
  ],
};

function gateway(session: AuthSession = student, overrides: Partial<SessionGateway> = {}): SessionGateway {
  return {
    getSession: vi.fn(async () => session),
    joinStudent: vi.fn(async () => student),
    requestTeacherMagicLink: vi.fn(async () => ({ accepted: true as const })),
    getTeacherRooms: vi.fn(async () => ({ rooms: [], truncated: false })),
    createRoom: vi.fn(async () => { throw new SessionGatewayError("ROOM_SERVICE_UNAVAILABLE"); }),
    getRoom: vi.fn(async () => room),
    logout: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("room route access guard", () => {
  afterEach(() => {
    cleanup();
    replace.mockReset();
  });

  it("hydrates a same-room student only after server room confirmation", async () => {
    const api = gateway();
    render(<RoomAccessClient gateway={api} mode="student" roomId={roomId} />);
    expect(await screen.findByRole("heading", { name: "生態系統探究" })).toBeInTheDocument();
    expect(screen.getByText("探索者 A")).toBeInTheDocument();
    expect(api.getRoom).toHaveBeenCalledWith(roomId);
    expect(document.body.textContent).not.toMatch(/本地演示|模擬即時|太陽是生態系統/);
  });

  it("fails closed for a student URL naming another room without requesting its details", async () => {
    const api = gateway();
    render(<RoomAccessClient gateway={api} mode="student" roomId={otherRoomId} />);
    expect(await screen.findByRole("heading", { name: "無法開啟這個課堂" })).toBeInTheDocument();
    expect(api.getRoom).not.toHaveBeenCalled();
  });

  it("rejects a malformed route id before session or room data access", async () => {
    const api = gateway();
    render(<RoomAccessClient gateway={api} mode="student" roomId="demo-room" />);
    expect(await screen.findByRole("heading", { name: "無法開啟這個課堂" })).toBeInTheDocument();
    expect(api.getSession).not.toHaveBeenCalled();
    expect(api.getRoom).not.toHaveBeenCalled();
  });

  it("canonicalizes an owning teacher from the student route after server confirmation", async () => {
    const api = gateway(teacher);
    render(<RoomAccessClient gateway={api} mode="student" roomId={roomId} />);
    await waitFor(() => expect(api.getRoom).toHaveBeenCalledWith(roomId));
    expect(replace).toHaveBeenCalledWith(`/session/${roomId}/teacher`);
  });

  it("never constructs teacher room state from a student session", async () => {
    const api = gateway(student);
    render(<RoomAccessClient gateway={api} mode="teacher" roomId={roomId} />);
    expect(await screen.findByRole("heading", { name: "無法開啟這個課堂" })).toBeInTheDocument();
    expect(api.getRoom).not.toHaveBeenCalled();
  });

  it("loads a teacher-owned room but hides a missing or foreign room", async () => {
    const ownerApi = gateway(teacher);
    const { unmount } = render(<RoomAccessClient gateway={ownerApi} mode="teacher" roomId={roomId} />);
    expect(await screen.findByText("教師房間控制台")).toBeInTheDocument();
    unmount();

    const foreignApi = gateway(teacher, {
      getRoom: vi.fn(async () => { throw new SessionGatewayError("ROOM_NOT_FOUND"); }),
    });
    render(<RoomAccessClient gateway={foreignApi} mode="teacher" roomId={otherRoomId} />);
    expect(await screen.findByRole("heading", { name: "無法開啟這個課堂" })).toBeInTheDocument();
  });

  it("redirects an expired session to the correct login entry", async () => {
    const api = gateway(student, {
      getSession: vi.fn(async () => { throw new SessionGatewayError("AUTH_REQUIRED"); }),
    });
    render(<RoomAccessClient gateway={api} mode="teacher" roomId={roomId} />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login?role=teacher"));
    expect(api.getRoom).not.toHaveBeenCalled();
  });

  it("revokes a hydrated student session before returning to login", async () => {
    const api = gateway();
    render(<RoomAccessClient gateway={api} mode="student" roomId={roomId} />);
    await screen.findByRole("heading", { name: "生態系統探究" });
    await userEvent.click(screen.getByRole("button", { name: "登出" }));
    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("offers logout recovery instead of a login loop when room hydration is unavailable", async () => {
    const api = gateway(student, {
      getRoom: vi.fn(async () => { throw new SessionGatewayError("ROOM_SERVICE_UNAVAILABLE"); }),
    });
    render(<RoomAccessClient gateway={api} mode="student" roomId={roomId} />);
    expect(await screen.findByRole("heading", { name: "課堂服務暫時不可用" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "清除 Session 並返回登入" }));
    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith("/login");
  });
});
