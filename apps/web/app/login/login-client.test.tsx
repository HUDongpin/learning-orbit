import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthSession, RoomDetails } from "@learning-orbit/contracts";
import type { SessionGateway } from "../../src/lib/session/session-gateway.js";
import { SessionGatewayError } from "../../src/lib/session/session-gateway.js";
import { LoginClient } from "./login-client.js";

const replace = vi.fn();
const router = { replace };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const teacher: AuthSession = {
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
const roomDetails: RoomDetails = {
  roomId: student.roomId,
  topic: "生態系統探究",
  status: "scheduled" as const,
  durationSeconds: 2700 as const,
  startsAt: null,
  closesAt: null,
  nova: student.nova,
  participants: [
    { actorId: "00000000-0000-4000-8000-000000000020", pseudonym: "探索者 A", actorKind: "human", actorRole: "student" },
    { actorId: "00000000-0000-4000-8000-000000000021", pseudonym: "探索者 B", actorKind: "human", actorRole: "student" },
    { actorId: "00000000-0000-4000-8000-000000000022", pseudonym: "探索者 C", actorKind: "human", actorRole: "student" },
    { actorId: "00000000-0000-4000-8000-000000000023", pseudonym: "探索者 D", actorKind: "human", actorRole: "student" },
  ],
};

function gateway(overrides: Partial<SessionGateway> = {}): SessionGateway {
  return {
    getSession: vi.fn(async () => { throw new SessionGatewayError("AUTH_REQUIRED"); }),
    joinStudent: vi.fn(async () => student),
    requestTeacherMagicLink: vi.fn(async () => ({ accepted: true as const })),
    getTeacherRooms: vi.fn(async () => ({ rooms: [], truncated: false })),
    createRoom: vi.fn(async () => { throw new SessionGatewayError("ROOM_SERVICE_UNAVAILABLE"); }),
    getRoom: vi.fn(async () => roomDetails),
    getRoomEvents: vi.fn(async () => ({ events: [], throughRoomSeq: 0 })),
    logout: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("unified login page", () => {
  afterEach(() => {
    cleanup();
    replace.mockReset();
  });

  it("shows only the two code fields for students and validates locally", async () => {
    const api = gateway();
    render(<LoginClient gateway={api} initialRole="student" />);
    expect(await screen.findByRole("heading", { name: "加入學習軌道" })).toBeInTheDocument();
    expect(screen.getByLabelText("房間代碼")).toBeInTheDocument();
    expect(screen.getByLabelText("座位代碼")).toBeInTheDocument();
    expect(screen.queryByLabelText(/姓名|電郵|密碼/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "加入課堂" }));
    expect(await screen.findByText("房間代碼須為 6 個英文字母或數字。")).toBeInTheDocument();
    expect(screen.getByText("座位代碼須為 10 個英文字母或數字。")).toBeInTheDocument();
    expect(api.joinStudent).not.toHaveBeenCalled();
  });

  it("normalizes valid codes, waits for server session, then navigates", async () => {
    const api = gateway();
    render(<LoginClient gateway={api} initialRole="student" />);
    await screen.findByRole("heading", { name: "加入學習軌道" });
    await userEvent.type(screen.getByLabelText("房間代碼"), "abc 234");
    await userEvent.type(screen.getByLabelText("座位代碼"), "def 234 5678");
    await userEvent.click(screen.getByRole("button", { name: "加入課堂" }));
    await waitFor(() => expect(api.joinStudent).toHaveBeenCalledWith({
      roomCode: "ABC234",
      seatCode: "DEF2345678",
    }));
    expect(api.getRoom).toHaveBeenCalledWith(student.roomId);
    expect(replace).toHaveBeenCalledWith(`/session/${student.roomId}`);
  });

  it("uses identical teacher success copy and never displays a link", async () => {
    const api = gateway();
    render(<LoginClient gateway={api} initialRole="teacher" />);
    await screen.findByRole("heading", { name: "教師登入" });
    await userEvent.type(screen.getByLabelText("教師電郵"), "Teacher@Example.EDU");
    await userEvent.click(screen.getByRole("button", { name: "傳送登入連結" }));
    expect(await screen.findByText("如果此電郵已獲授權，登入連結將會送出。請檢查收件匣。")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/token=|\/consume/);
  });

  it("keeps the same public teacher result when transport fails", async () => {
    const api = gateway({
      requestTeacherMagicLink: vi.fn(async () => { throw new SessionGatewayError("SESSION_NETWORK_FAILURE"); }),
    });
    render(<LoginClient gateway={api} initialRole="teacher" />);
    await screen.findByRole("heading", { name: "教師登入" });
    await userEvent.type(screen.getByLabelText("教師電郵"), "teacher@example.edu");
    await userEvent.click(screen.getByRole("button", { name: "傳送登入連結" }));
    expect(await screen.findByText("如果此電郵已獲授權，登入連結將會送出。請檢查收件匣。")).toBeInTheDocument();
  });

  it("redirects an already authenticated session without rendering a fixture", async () => {
    render(<LoginClient gateway={gateway({ getSession: vi.fn(async () => teacher) })} initialRole="student" />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/teacher"));
    expect(screen.queryByText("Demo")).not.toBeInTheDocument();
  });

  it("shows one non-enumerating recovery message for rejected student codes", async () => {
    const api = gateway({
      joinStudent: vi.fn(async () => { throw new SessionGatewayError("JOIN_FORBIDDEN"); }),
    });
    render(<LoginClient gateway={api} initialRole="student" />);
    await screen.findByRole("heading", { name: "加入學習軌道" });
    await userEvent.type(screen.getByLabelText("房間代碼"), "ABC234");
    await userEvent.type(screen.getByLabelText("座位代碼"), "DEF2345678");
    await userEvent.click(screen.getByRole("button", { name: "加入課堂" }));
    expect(await screen.findByText("無法加入課堂。請向老師確認代碼後再試。")).toBeInTheDocument();
  });

  it("distinguishes a service failure from rejected classroom codes without navigating", async () => {
    const api = gateway({
      getRoom: vi.fn(async () => { throw new SessionGatewayError("ROOM_SERVICE_UNAVAILABLE"); }),
    });
    render(<LoginClient gateway={api} initialRole="student" />);
    await screen.findByRole("heading", { name: "加入學習軌道" });
    await userEvent.type(screen.getByLabelText("房間代碼"), "ABC234");
    await userEvent.type(screen.getByLabelText("座位代碼"), "DEF2345678");
    await userEvent.click(screen.getByRole("button", { name: "加入課堂" }));
    expect(await screen.findByText("課堂服務暫時不可用。請稍後再試。")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("supports arrow-key navigation between the two role tabs", async () => {
    render(<LoginClient gateway={gateway()} initialRole="student" />);
    const studentTab = await screen.findByRole("tab", { name: "學生加入" });
    studentTab.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("heading", { name: "教師登入" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "教師登入" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("heading", { name: "加入學習軌道" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "學生加入" })).toHaveFocus();
  });
});
