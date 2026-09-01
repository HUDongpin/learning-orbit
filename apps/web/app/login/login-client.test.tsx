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
    { actorId: student.actorId, pseudonym: "探索者 A", actorKind: "human", actorRole: "student" },
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
    createMediaUpload: vi.fn(async () => { throw new SessionGatewayError("MEDIA_SERVICE_UNAVAILABLE"); }),
    completeMediaUpload: vi.fn(async () => { throw new SessionGatewayError("MEDIA_SERVICE_UNAVAILABLE"); }),
    getMedia: vi.fn(async () => { throw new SessionGatewayError("MEDIA_SERVICE_UNAVAILABLE"); }),
    getMediaDownloadGrant: vi.fn(async () => { throw new SessionGatewayError("MEDIA_SERVICE_UNAVAILABLE"); }),
    getAgentCurrent: vi.fn(async () => { throw new SessionGatewayError("AGENT_SERVICE_UNAVAILABLE"); }),
    setAgentSettings: vi.fn(async () => { throw new SessionGatewayError("AGENT_SERVICE_UNAVAILABLE"); }),
    getDerivedTextArtifacts: vi.fn(async () => { throw new SessionGatewayError("ANALYTICS_NOT_READY"); }),
    submitAnalyticsReview: vi.fn(async () => { throw new SessionGatewayError("ANALYTICS_NOT_READY"); }),
    getAnalyticsReviewDetail: vi.fn(async () => { throw new SessionGatewayError("ANALYTICS_NOT_READY"); }),
    requestRoomDeletion: vi.fn(async () => { throw new SessionGatewayError("ROOM_NOT_FOUND"); }),
    getDeletionStatus: vi.fn(async () => { throw new SessionGatewayError("ROOM_NOT_FOUND"); }),
    getRoomDeletion: vi.fn(async () => { throw new SessionGatewayError("ROOM_NOT_FOUND"); }),
    exportRoom: vi.fn(async () => { throw new SessionGatewayError("ROOM_NOT_FOUND"); }),
    getProjectionLatest: vi.fn(async () => { throw new SessionGatewayError("ANALYTICS_NOT_READY"); }),
    getProjectionPatches: vi.fn(async () => { throw new SessionGatewayError("ANALYTICS_NOT_READY"); }),
    getConceptTimeline: vi.fn(async () => { throw new SessionGatewayError("ANALYTICS_NOT_READY"); }),
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

  it("provides a focusable skip target and moves focus to the first invalid field", async () => {
    render(<LoginClient gateway={gateway()} initialRole="student" />);
    const skipLink = await screen.findByRole("link", { name: "跳至登入表格" });
    expect(skipLink).toHaveAttribute("href", "#login-form");
    expect(document.getElementById("login-form")).toHaveAttribute("tabindex", "-1");

    await userEvent.click(screen.getByRole("button", { name: "加入課堂" }));
    const roomInput = screen.getByLabelText("房間代碼");
    expect(roomInput).toHaveFocus();
    expect(roomInput).toHaveAttribute("aria-invalid", "true");
    expect(roomInput).toHaveAccessibleDescription("房間代碼須為 6 個英文字母或數字。");
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

  it("takes the code out of a pasted teacher message instead of a look-alike", async () => {
    const api = gateway();
    render(<LoginClient gateway={api} initialRole="student" />);
    await screen.findByRole("heading", { name: "加入學習軌道" });
    const roomInput = screen.getByLabelText("房間代碼");
    await userEvent.click(roomInput);
    // Dropping the strays here would leave "RMCDEA": six alphabet characters
    // that pass the field check and join a different room.
    await userEvent.paste("Room code: ABC234");
    expect(roomInput).toHaveValue("ABC234");

    const seatInput = screen.getByLabelText("座位代碼");
    await userEvent.click(seatInput);
    await userEvent.paste("Seat code: DEF2345678");
    expect(seatInput).toHaveValue("DEF2345678");

    await userEvent.click(screen.getByRole("button", { name: "加入課堂" }));
    await waitFor(() => expect(api.joinStudent).toHaveBeenCalledWith({
      roomCode: "ABC234",
      seatCode: "DEF2345678",
    }));
  });

  it("picks the field's own code when the whole invitation is pasted into both", async () => {
    const api = gateway();
    render(<LoginClient gateway={api} initialRole="student" />);
    await screen.findByRole("heading", { name: "加入學習軌道" });
    const invitation = "房間代碼：ABC234，座位代碼：DEF2345678";
    await userEvent.click(screen.getByLabelText("房間代碼"));
    await userEvent.paste(invitation);
    await userEvent.click(screen.getByLabelText("座位代碼"));
    await userEvent.paste(invitation);
    expect(screen.getByLabelText("房間代碼")).toHaveValue("ABC234");
    expect(screen.getByLabelText("座位代碼")).toHaveValue("DEF2345678");
  });

  it("refuses an ambiguous paste rather than submitting one of the candidates", async () => {
    const api = gateway();
    render(<LoginClient gateway={api} initialRole="student" />);
    await screen.findByRole("heading", { name: "加入學習軌道" });
    await userEvent.click(screen.getByLabelText("房間代碼"));
    await userEvent.paste("ABC234 XYZ789");
    await userEvent.type(screen.getByLabelText("座位代碼"), "DEF2345678");
    await userEvent.click(screen.getByRole("button", { name: "加入課堂" }));
    expect(await screen.findByText("房間代碼須為 6 個英文字母或數字。")).toBeInTheDocument();
    expect(api.joinStudent).not.toHaveBeenCalled();
  });

  it.each([
    ["缺少本人座位", { ...roomDetails, participants: roomDetails.participants.slice(1) }],
    ["匿名身份不一致", {
      ...roomDetails,
      participants: roomDetails.participants.map((participant, index) => (
        index === 0 ? { ...participant, pseudonym: "探索者 B" as const } : participant
      )),
    }],
    ["匿名 roster 含非规范名称", {
      ...roomDetails,
      participants: roomDetails.participants.map((participant, index) => (
        index === 3 ? { ...participant, pseudonym: "王同學" } : participant
      )),
    }],
    ["Nova 身份不一致", {
      ...roomDetails,
      nova: { ...roomDetails.nova, actorId: "00000000-0000-4000-8000-000000000099" },
    }],
  ])("does not navigate when server identity validation fails: %s", async (_label, inconsistentRoom) => {
    const api = gateway({ getRoom: vi.fn(async () => inconsistentRoom as RoomDetails) });
    render(<LoginClient gateway={api} initialRole="student" />);
    await screen.findByRole("heading", { name: "加入學習軌道" });
    await userEvent.type(screen.getByLabelText("房間代碼"), "ABC234");
    await userEvent.type(screen.getByLabelText("座位代碼"), "DEF2345678");
    await userEvent.click(screen.getByRole("button", { name: "加入課堂" }));
    expect(await screen.findByText("課堂服務暫時不可用。請稍後再試。")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("uses identical teacher success copy and never displays a link", async () => {
    const api = gateway();
    render(<LoginClient gateway={api} initialRole="teacher" />);
    await screen.findByRole("heading", { name: "教師登入" });
    await userEvent.type(screen.getByLabelText("教師電郵"), "Teacher@Example.EDU");
    await userEvent.click(screen.getByRole("button", { name: "傳送登入連結" }));
    expect(await screen.findByRole("status")).toHaveTextContent("如果此電郵已獲授權，登入連結將會送出。請檢查收件匣。");
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

  it("moves focus to the fail-closed Session recovery heading", async () => {
    render(<LoginClient gateway={gateway({
      getSession: vi.fn(async () => { throw new SessionGatewayError("SESSION_NETWORK_FAILURE"); }),
    })} initialRole="student" />);

    expect(await screen.findByRole("heading", { name: "暫時無法確認登入狀態" })).toHaveFocus();
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
