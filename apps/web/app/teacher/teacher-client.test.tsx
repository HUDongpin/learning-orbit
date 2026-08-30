import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthSession, CreateRoomResponse, TeacherRoomListResponse } from "@learning-orbit/contracts";
import type { SessionGateway } from "../../src/lib/session/session-gateway.js";
import { SessionGatewayError } from "../../src/lib/session/session-gateway.js";
import { TeacherClient } from "./teacher-client.js";

const replace = vi.fn();
const router = { replace };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const teacher: Extract<AuthSession, { role: "teacher" }> = {
  role: "teacher",
  teacherId: "00000000-0000-4000-8000-000000000001",
  actorId: "00000000-0000-4000-8000-000000000001",
};

const student: Extract<AuthSession, { role: "student" }> = {
  role: "student",
  roomId: "00000000-0000-4000-8000-000000000010",
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

const roomList: TeacherRoomListResponse = {
  rooms: [
    {
      roomId: "00000000-0000-4000-8000-000000000020",
      topic: "生態系統探究",
      status: "open",
      durationSeconds: 2700,
      startsAt: "2026-08-31T01:00:00.000Z",
      closesAt: "2026-08-31T01:45:00.000Z",
      createdAt: "2026-08-31T00:55:00.000Z",
    },
    {
      roomId: "00000000-0000-4000-8000-000000000021",
      topic: "生態系統探究",
      status: "closed",
      durationSeconds: 2700,
      startsAt: "2026-08-30T01:00:00.000Z",
      closesAt: "2026-08-30T01:45:00.000Z",
      createdAt: "2026-08-30T00:55:00.000Z",
    },
  ],
  truncated: false,
};

const createdRoom: CreateRoomResponse = {
  room: {
    roomId: "00000000-0000-4000-8000-000000000030",
    roomCode: "ABC234",
    status: "scheduled",
    durationSeconds: 2700,
    nova: student.nova,
  },
  seatInvites: [
    { roomMemberId: "00000000-0000-4000-8000-000000000031", actorId: "00000000-0000-4000-8000-000000000041", pseudonym: "探索者 A", code: "ABC2345672" },
    { roomMemberId: "00000000-0000-4000-8000-000000000032", actorId: "00000000-0000-4000-8000-000000000042", pseudonym: "探索者 B", code: "ABC2345673" },
    { roomMemberId: "00000000-0000-4000-8000-000000000033", actorId: "00000000-0000-4000-8000-000000000043", pseudonym: "探索者 C", code: "ABC2345674" },
    { roomMemberId: "00000000-0000-4000-8000-000000000034", actorId: "00000000-0000-4000-8000-000000000044", pseudonym: "探索者 D", code: "ABC2345675" },
  ],
};

function gateway(overrides: Partial<SessionGateway> = {}): SessionGateway {
  return {
    getSession: vi.fn(async () => teacher),
    joinStudent: vi.fn(async () => student),
    requestTeacherMagicLink: vi.fn(async () => ({ accepted: true as const })),
    getTeacherRooms: vi.fn(async () => roomList),
    createRoom: vi.fn(async () => createdRoom),
    getRoom: vi.fn(async () => { throw new SessionGatewayError("ROOM_NOT_FOUND"); }),
    getRoomEvents: vi.fn(async () => ({ events: [], throughRoomSeq: 0 })),
    createMediaUpload: vi.fn(async () => { throw new SessionGatewayError("MEDIA_SERVICE_UNAVAILABLE"); }),
    completeMediaUpload: vi.fn(async () => { throw new SessionGatewayError("MEDIA_SERVICE_UNAVAILABLE"); }),
    getMedia: vi.fn(async () => { throw new SessionGatewayError("MEDIA_SERVICE_UNAVAILABLE"); }),
    getMediaDownloadGrant: vi.fn(async () => { throw new SessionGatewayError("MEDIA_SERVICE_UNAVAILABLE"); }),
    getAgentCurrent: vi.fn(async () => { throw new SessionGatewayError("AGENT_SERVICE_UNAVAILABLE"); }),
    logout: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("teacher workspace", () => {
  afterEach(() => {
    cleanup();
    replace.mockReset();
    vi.restoreAllMocks();
  });

  it("redirects an anonymous visitor before loading any room list", async () => {
    const api = gateway({
      getSession: vi.fn(async () => { throw new SessionGatewayError("AUTH_REQUIRED"); }),
    });
    render(<TeacherClient gateway={api} />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login?role=teacher"));
    expect(api.getTeacherRooms).not.toHaveBeenCalled();
  });

  it("shows a role-mismatch recovery page for students without constructing teacher state", async () => {
    const api = gateway({ getSession: vi.fn(async () => student) });
    render(<TeacherClient gateway={api} />);
    expect(await screen.findByRole("heading", { name: "這個頁面只供教師使用" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回我的課堂" })).toHaveAttribute("href", `/session/${student.roomId}`);
    expect(api.getTeacherRooms).not.toHaveBeenCalled();
  });

  it("lists active and recent rooms without revealing invite codes", async () => {
    render(<TeacherClient gateway={gateway()} />);
    expect(await screen.findByRole("heading", { name: "教師工作台" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /開啟課堂.*進行中/ })).toHaveAttribute(
      "href",
      `/session/${roomList.rooms[0]!.roomId}/teacher`,
    );
    expect(screen.getByText("已結束")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("座位代碼");
    expect(document.body.textContent).not.toContain("ABC234");
  });

  it("creates the fixed topic and exposes all invite codes only until the teacher confirms saving them", async () => {
    const writeText = vi.fn(async (_value: string) => undefined);
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const api = gateway();
    render(<TeacherClient gateway={api} />);
    await screen.findByRole("heading", { name: "教師工作台" });
    await userEvent.click(screen.getByRole("button", { name: "建立新課堂" }));
    await waitFor(() => expect(api.createRoom).toHaveBeenCalledWith({ topic: "生態系統探究" }));
    expect(await screen.findByText("ABC234")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "分發課堂代碼" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "登出（請先保存代碼）" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "請先保存代碼" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: /開啟課堂/ })).not.toBeInTheDocument();
    for (const invite of createdRoom.seatInvites) {
      expect(screen.getByText(invite.code)).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole("button", { name: "複製全部代碼" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain("房間代碼：ABC234");
    await userEvent.click(screen.getByRole("button", { name: "列印座位卡" }));
    expect(print).toHaveBeenCalledTimes(1);
    const unloadWhileUnsaved = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(unloadWhileUnsaved)).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "我已安全保存代碼" }));
    expect(screen.queryByText("ABC234")).not.toBeInTheDocument();
    expect(screen.queryByText(createdRoom.seatInvites[0].code)).not.toBeInTheDocument();
    expect(screen.getByText("房間列表不會再次顯示這些代碼。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "開啟新課堂" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "代碼顯示已關閉" })).toHaveFocus();
    expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true);
  });

  it("revokes the server session before returning to login", async () => {
    const api = gateway();
    render(<TeacherClient gateway={api} />);
    await screen.findByRole("heading", { name: "教師工作台" });
    await userEvent.click(screen.getByRole("button", { name: "登出" }));
    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith("/login?role=teacher");
  });

  it("clears teacher state and returns to login when creation discovers an expired session", async () => {
    const api = gateway({
      createRoom: vi.fn(async () => { throw new SessionGatewayError("AUTH_REQUIRED"); }),
    });
    render(<TeacherClient gateway={api} />);
    await screen.findByRole("heading", { name: "教師工作台" });
    await userEvent.click(screen.getByRole("button", { name: "建立新課堂" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login?role=teacher"));
    expect(screen.queryByText("ABC234")).not.toBeInTheDocument();
  });

  it("offers a real logout recovery when the room list service is unavailable", async () => {
    const api = gateway({
      getTeacherRooms: vi.fn(async () => { throw new SessionGatewayError("ROOM_LIST_UNAVAILABLE"); }),
    });
    render(<TeacherClient gateway={api} />);
    expect(await screen.findByRole("heading", { name: "暫時無法載入教師工作台" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "清除 Session 並返回登入" }));
    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith("/login?role=teacher");
  });
});
