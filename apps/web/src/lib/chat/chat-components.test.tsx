import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthSession, RoomDetails, ServerFrame } from "@learning-orbit/contracts";
import type { LedgerMessage } from "../session/event-ledger.js";
import { ChatPanel } from "./chat-panel.js";
import { Composer } from "./composer.js";
import { MessageCard } from "./message-card.js";
import { roomRoster } from "./roster.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const STUDENT_ACTOR = "00000000-0000-4000-8000-000000000012";
const OTHER_ACTOR = "00000000-0000-4000-8000-000000000014";
const NOVA_ACTOR = "00000000-0000-4000-8000-000000000013";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000501";
type RejectFrameView = Pick<Extract<ServerFrame, { type: "reject" }>, "code" | "commandId" | "retryable">;

const student: Extract<AuthSession, { role: "student" }> = {
  role: "student",
  roomId: ROOM_ID,
  roomMemberId: "00000000-0000-4000-8000-000000000011",
  actorId: STUDENT_ACTOR,
  pseudonym: "探索者 A",
  nova: { actorId: NOVA_ACTOR, actorKind: "agent", actorRole: "socratic_facilitator", displayName: "Nova Agent" },
};
const teacher: Extract<AuthSession, { role: "teacher" }> = {
  role: "teacher",
  teacherId: "00000000-0000-4000-8000-000000000001",
  actorId: "00000000-0000-4000-8000-000000000001",
};
const room: RoomDetails = {
  roomId: ROOM_ID,
  topic: "生態系統探究",
  status: "open",
  durationSeconds: 2700,
  startsAt: "2026-08-31T01:00:00.000Z",
  closesAt: "2026-08-31T01:45:00.000Z",
  nova: student.nova,
  participants: [
    { actorId: STUDENT_ACTOR, pseudonym: "探索者 A", actorKind: "human", actorRole: "student" },
    { actorId: OTHER_ACTOR, pseudonym: "探索者 B", actorKind: "human", actorRole: "student" },
    { actorId: "00000000-0000-4000-8000-000000000015", pseudonym: "探索者 C", actorKind: "human", actorRole: "student" },
    { actorId: "00000000-0000-4000-8000-000000000016", pseudonym: "探索者 D", actorKind: "human", actorRole: "student" },
  ],
};
const ownMessage: LedgerMessage = {
  messageId: MESSAGE_ID,
  text: "池塘裡的藻類增加了",
  actorId: STUDENT_ACTOR,
  actorKind: "human",
  actorRole: "student",
  eventId: "00000000-0000-4000-8000-000000000601",
  causationId: "00000000-0000-4000-8000-000000000701",
  revision: 1,
  operation: "add",
  eventTime: "2026-08-31T01:05:00.000Z",
  firstRoomSeq: 1,
  roomSeq: 1,
  replyTo: null,
  mentions: [],
  mediaIds: [],
};
const otherMessage: LedgerMessage = {
  ...ownMessage,
  messageId: "00000000-0000-4000-8000-000000000502",
  text: "另一則伺服器訊息",
  actorId: OTHER_ACTOR,
  eventId: "00000000-0000-4000-8000-000000000602",
  firstRoomSeq: 2,
  roomSeq: 2,
};

describe("event-backed chat components", () => {
  afterEach(cleanup);

  it("composes a reply and mentions only server-provided roster actors", async () => {
    const onSend = vi.fn(() => "00000000-0000-4000-8000-000000000201");
    render(<Composer roster={roomRoster(room)} roomStatus="open" replyTo={MESSAGE_ID} mediaIds={[]} onSend={onSend} />);
    await userEvent.click(screen.getByRole("button", { name: "提及 探索者 B" }));
    await userEvent.type(screen.getByLabelText("輸入訊息"), "需要更多直接證據");
    await userEvent.click(screen.getByRole("button", { name: "發送訊息" }));
    expect(onSend).toHaveBeenCalledWith({
      type: "message.add",
      text: "@探索者 B 需要更多直接證據",
      replyTo: MESSAGE_ID,
      mentions: [OTHER_ACTOR],
      mediaIds: [],
    });
  });

  it("uses the server-owned Nova actor and never promises a reply", async () => {
    const onSend = vi.fn(() => "00000000-0000-4000-8000-000000000201");
    render(<Composer roster={roomRoster(room)} roomStatus="open" replyTo={null} mediaIds={[]} onSend={onSend} />);
    await userEvent.click(screen.getByRole("button", { name: "提及 Nova Agent" }));
    await userEvent.type(screen.getByLabelText("輸入訊息"), "請整理證據");
    await userEvent.click(screen.getByRole("button", { name: "發送訊息" }));
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ mentions: [NOVA_ACTOR] }));
    expect(screen.getByText(/提及 Nova 不保證會收到回應/)).toBeInTheDocument();
  });

  it("removes a structured mention when its visible token is deleted", async () => {
    const onSend = vi.fn(() => "00000000-0000-4000-8000-000000000201");
    render(<Composer roster={roomRoster(room)} roomStatus="open" replyTo={null} mediaIds={[]} onSend={onSend} />);
    await userEvent.click(screen.getByRole("button", { name: "提及 Nova Agent" }));
    await userEvent.clear(screen.getByLabelText("輸入訊息"));
    await userEvent.type(screen.getByLabelText("輸入訊息"), "這只是普通觀察");
    await userEvent.click(screen.getByRole("button", { name: "發送訊息" }));
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ mentions: [] }));
  });

  it.each([
    ["scheduled", "課堂尚未開始；訊息暫時不能發送"],
    ["paused", "課堂已暫停；訊息暫時不能發送"],
    ["closed", "課堂已關閉；訊息不能再發送"],
  ] as const)("disables the composer in %s state", (roomStatus, copy) => {
    render(<Composer roster={roomRoster(room)} roomStatus={roomStatus} replyTo={null} mediaIds={[]} onSend={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(copy);
    expect(screen.getByRole("button", { name: "發送訊息" })).toBeDisabled();
  });

  it("inserts an editable inquiry prompt without sending", async () => {
    const onSend = vi.fn();
    render(<Composer roster={roomRoster(room)} roomStatus="open" replyTo={null} mediaIds={[]} onSend={onSend} />);
    await userEvent.click(screen.getByRole("button", { name: "使用提示：追問物質循環" }));
    expect(screen.getByLabelText("輸入訊息")).toHaveValue("我想追問：分解者怎樣讓物質回到環境？");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText(/概念圖是否更新由伺服器分析與證據規則決定/)).toBeInTheDocument();
  });

  it("sends revise/retract intents without mutating the displayed server message", async () => {
    const onCommand = vi.fn(() => "00000000-0000-4000-8000-000000000201");
    const confirm = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    render(<MessageCard message={ownMessage} roster={roomRoster(room)} roomStatus="open" viewer={student} onCommand={onCommand} onReply={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "修訂訊息 1" }));
    await userEvent.clear(screen.getByLabelText("修訂內容"));
    await userEvent.type(screen.getByLabelText("修訂內容"), "修正後的觀察");
    await userEvent.click(screen.getByRole("button", { name: "送出修訂" }));
    expect(onCommand).toHaveBeenCalledWith({ type: "message.revise", messageId: MESSAGE_ID, text: "修正後的觀察", replyTo: null, mentions: [], baseRevision: 1 });
    expect(screen.getByText("池塘裡的藻類增加了")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "撤回訊息 1" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(onCommand).toHaveBeenLastCalledWith({ type: "message.retract", messageId: MESSAGE_ID, baseRevision: 1 });
    confirm.mockRestore();
  });

  it("moves keyboard focus to a message action error", async () => {
    const onCommand = vi.fn(() => { throw new Error("COMMAND_QUEUE_UNAVAILABLE"); });
    render(<MessageCard message={ownMessage} roster={roomRoster(room)} roomStatus="open" viewer={student} onCommand={onCommand} onReply={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "修訂訊息 1" }));
    await userEvent.clear(screen.getByLabelText("修訂內容"));
    await userEvent.type(screen.getByLabelText("修訂內容"), "修正後的觀察");
    await userEvent.click(screen.getByRole("button", { name: "送出修訂" }));
    const error = await screen.findByRole("alert");

    expect(error).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expect(error).toHaveFocus());
  });

  it("cancels an edit when a newer server revision arrives and never upgrades a stale draft base", async () => {
    const onCommand = vi.fn();
    const view = (message: LedgerMessage) => (
      <MessageCard message={message} roster={roomRoster(room)} roomStatus="open" viewer={student} onCommand={onCommand} onReply={vi.fn()} />
    );
    const { rerender } = render(view(ownMessage));
    await userEvent.click(screen.getByRole("button", { name: "修訂訊息 1" }));
    await userEvent.clear(screen.getByLabelText("修訂內容"));
    await userEvent.type(screen.getByLabelText("修訂內容"), "尚未送出的舊草稿");
    rerender(view({ ...ownMessage, text: "伺服器上的新修訂", revision: 2, roomSeq: 3 }));
    expect(await screen.findByRole("alert")).toHaveTextContent("伺服器已更新這則訊息");
    expect(screen.queryByLabelText("修訂內容")).not.toBeInTheDocument();
    expect(onCommand).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "修訂訊息 1" }));
    expect(screen.getByLabelText("修訂內容")).toHaveValue("伺服器上的新修訂");
  });

  it.each(["paused", "closed"] as const)("disables revise and retract actions while the room is %s", (roomStatus) => {
    render(<MessageCard message={ownMessage} roster={roomRoster(room)} roomStatus={roomStatus} viewer={student} onCommand={vi.fn()} onReply={vi.fn()} />);
    expect(screen.getByRole("button", { name: "修訂訊息 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "撤回訊息 1" })).toBeDisabled();
  });

  it("names who is composing, and reports typing to the server as the student writes", async () => {
    const signalTyping = vi.fn();
    const runtime = {
      session: student,
      room,
      sessionState: { status: "open" as const, connected: true },
      messages: () => [],
      pendingCommandIds: () => [],
      rejects: [],
      sendIntent: vi.fn(() => "00000000-0000-4000-8000-000000000201"),
      acks: new Map<string, unknown>(),
      signalTyping,
      typingActorIds: () => [OTHER_ACTOR],
    };
    render(<ChatPanel runtime={runtime} />);

    // The hint resolves the actor to its seat pseudonym; a raw actorId would
    // leak an identifier the roster deliberately hides behind a pseudonym.
    expect(screen.getByText("探索者 B 正在輸入…")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("輸入訊息"), "水");
    expect(signalTyping).toHaveBeenCalledWith(true);
  });

  it("shows no composing hint when the runtime carries no live socket", () => {
    const runtime = {
      session: student,
      room,
      sessionState: { status: "open" as const, connected: true },
      messages: () => [],
      pendingCommandIds: () => [],
      rejects: [],
      sendIntent: vi.fn(() => "00000000-0000-4000-8000-000000000201"),
      acks: new Map<string, unknown>(),
    };
    render(<ChatPanel runtime={runtime} />);
    expect(screen.queryByText(/正在輸入/u)).toBeNull();
  });

  it("keeps reply context until the exact server ACK is observed", async () => {
    const commandId = "00000000-0000-4000-8000-000000000201";
    const acks = new Map<string, unknown>();
    const runtime = {
      session: student,
      room,
      sessionState: { status: "open" as const, connected: true },
      messages: () => [ownMessage],
      pendingCommandIds: () => [commandId],
      rejects: [],
      sendIntent: vi.fn(() => commandId),
      acks,
    };
    const { rerender } = render(<ChatPanel runtime={runtime} />);
    await userEvent.click(screen.getByRole("button", { name: "回覆訊息 1" }));
    await userEvent.type(screen.getByLabelText("輸入訊息"), "回覆內容");
    await userEvent.click(screen.getByRole("button", { name: "發送訊息" }));
    expect(screen.getByRole("button", { name: "取消回覆" }).closest(".reply-strip")).toHaveTextContent("回覆訊息 1");
    acks.set(commandId, { commandId });
    rerender(<ChatPanel runtime={runtime} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "取消回覆" })).not.toBeInTheDocument());
  });

  it("does not let a late ACK clear a newer unsent reply context", async () => {
    const firstCommandId = "00000000-0000-4000-8000-000000000201";
    const acks = new Map<string, unknown>();
    const runtime = {
      session: student,
      room,
      sessionState: { status: "open" as const, connected: true },
      messages: () => [ownMessage, otherMessage],
      pendingCommandIds: () => [firstCommandId],
      rejects: [],
      sendIntent: vi.fn(() => firstCommandId),
      acks,
    };
    const { rerender } = render(<ChatPanel runtime={runtime} />);
    await userEvent.click(screen.getByRole("button", { name: "回覆訊息 1" }));
    await userEvent.type(screen.getByLabelText("輸入訊息"), "第一個回覆");
    await userEvent.click(screen.getByRole("button", { name: "發送訊息" }));
    await userEvent.click(screen.getByRole("button", { name: "回覆訊息 2" }));
    expect(screen.getByRole("button", { name: "取消回覆" }).closest(".reply-strip")).toHaveTextContent("回覆訊息 2");
    acks.set(firstCommandId, { commandId: firstCommandId });
    rerender(<ChatPanel runtime={runtime} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "取消回覆" }).closest(".reply-strip")).toHaveTextContent("回覆訊息 2"));
  });

  it("derives rejection copy from the latest command and clears it on exact ACK", async () => {
    const oldId = "00000000-0000-4000-8000-000000000209";
    const nextId = "00000000-0000-4000-8000-000000000210";
    const acks = new Map<string, unknown>();
    const rejects: RejectFrameView[] = [{ commandId: oldId, code: "ROOM_NOT_OPEN", retryable: false }];
    const runtime = {
      session: student,
      room,
      sessionState: { status: "open" as const, connected: true },
      messages: () => [],
      pendingCommandIds: () => [],
      rejects,
      sendIntent: vi.fn(() => nextId),
      acks,
    };
    const { rerender } = render(<ChatPanel runtime={runtime} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("輸入訊息"), "測試拒絕狀態");
    await userEvent.click(screen.getByRole("button", { name: "發送訊息" }));
    rejects.push({ commandId: nextId, code: "ROOM_NOT_OPEN" });
    rerender(<ChatPanel runtime={runtime} />);
    expect(screen.getByRole("alert")).toHaveTextContent("伺服器未接受上一個指令");
    acks.set(nextId, { commandId: nextId });
    rerender(<ChatPanel runtime={runtime} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("sends a server-completed media-only message and clears that exact draft on ACK", async () => {
    const commandId = "00000000-0000-4000-8000-000000000211";
    const mediaId = "00000000-0000-4000-8000-000000000701";
    const acks = new Map<string, unknown>();
    const runtime = {
      session: student,
      room,
      sessionState: { status: "open" as const, connected: true },
      messages: () => [],
      pendingCommandIds: () => [commandId],
      rejects: [],
      sendIntent: vi.fn(() => commandId),
      acks,
    };
    const mediaGateway = {
      createMediaUpload: vi.fn(), completeMediaUpload: vi.fn(), getMedia: vi.fn(), getMediaDownloadGrant: vi.fn(),
    };
    const props = {
      runtime,
      mediaGateway,
      allowedUploadOrigins: ["https://storage.learning-orbit.test"],
      mediaUpload: vi.fn(async () => ({ mediaId, state: "processing" as const })),
      mediaObjectUrls: { create: () => "blob:audio", revoke: vi.fn() },
    };
    const { rerender } = render(<ChatPanel {...props} />);
    await userEvent.upload(screen.getByLabelText("本地媒體檔案"), new File(["abc"], "note.webm", { type: "audio/webm" }));
    await userEvent.click(screen.getByRole("button", { name: "上傳並由伺服器確認" }));
    expect(await screen.findByText(/1 個媒體項目已通過 Complete/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上傳並由伺服器確認" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "發送訊息" }));
    expect(runtime.sendIntent).toHaveBeenCalledWith({ type: "message.add", text: "", replyTo: null, mentions: [], mediaIds: [mediaId] });
    await waitFor(() => expect(props.mediaObjectUrls.revoke).toHaveBeenCalledWith("blob:audio"));
    acks.set(commandId, { commandId });
    rerender(<ChatPanel {...props} />);
    await waitFor(() => expect(screen.queryByText(/1 個媒體項目已通過 Complete/)).not.toBeInTheDocument());
  });

  it("keeps concurrent media submissions correlated across late ACK and Reject ordering", async () => {
    const firstCommandId = "00000000-0000-4000-8000-000000000211";
    const secondCommandId = "00000000-0000-4000-8000-000000000212";
    const retryCommandId = "00000000-0000-4000-8000-000000000213";
    const firstMediaId = "00000000-0000-4000-8000-000000000701";
    const secondMediaId = "00000000-0000-4000-8000-000000000702";
    const acks = new Map<string, unknown>();
    const rejects: RejectFrameView[] = [];
    const runtime = {
      session: student,
      room,
      sessionState: { status: "open" as const, connected: true },
      messages: () => [],
      pendingCommandIds: () => [],
      rejects,
      sendIntent: vi.fn()
        .mockReturnValueOnce(firstCommandId)
        .mockReturnValueOnce(secondCommandId)
        .mockReturnValueOnce(retryCommandId),
      acks,
    };
    const mediaGateway = {
      createMediaUpload: vi.fn(), completeMediaUpload: vi.fn(), getMedia: vi.fn(), getMediaDownloadGrant: vi.fn(),
    };
    const upload = vi.fn()
      .mockResolvedValueOnce({ mediaId: firstMediaId, state: "processing" as const })
      .mockResolvedValueOnce({ mediaId: secondMediaId, state: "processing" as const });
    const props = {
      runtime,
      mediaGateway,
      allowedUploadOrigins: ["https://storage.learning-orbit.test"],
      mediaUpload: upload,
      mediaObjectUrls: { create: vi.fn(() => "blob:local"), revoke: vi.fn() },
    };
    const rendered = render(<ChatPanel {...props} />);

    await userEvent.upload(screen.getByLabelText("本地媒體檔案"), new File(["one"], "one.webm", { type: "audio/webm" }));
    await userEvent.click(screen.getByRole("button", { name: "上傳並由伺服器確認" }));
    await userEvent.click(await screen.findByRole("button", { name: "發送訊息" }));
    await waitFor(() => expect(screen.queryByText("本地音訊預覽；沒有產生或顯示轉寫。")).not.toBeInTheDocument());

    await userEvent.upload(screen.getByLabelText("本地媒體檔案"), new File(["two"], "two.webm", { type: "audio/webm" }));
    await userEvent.click(screen.getByRole("button", { name: "上傳並由伺服器確認" }));
    await userEvent.click(await screen.findByRole("button", { name: "發送訊息" }));
    expect(runtime.sendIntent).toHaveBeenNthCalledWith(1, expect.objectContaining({ mediaIds: [firstMediaId] }));
    expect(runtime.sendIntent).toHaveBeenNthCalledWith(2, expect.objectContaining({ mediaIds: [secondMediaId] }));

    rejects.push({ commandId: secondCommandId, code: "INTERNAL", retryable: true });
    rendered.rerender(<ChatPanel {...props} />);
    expect(await screen.findByText(/原指令與媒體仍鎖定/)).toBeInTheDocument();
    expect(screen.queryByText(/1 個媒體項目已通過 Complete/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "發送訊息" })).toBeDisabled();

    acks.set(firstCommandId, { commandId: firstCommandId });
    rendered.rerender(<ChatPanel {...props} />);
    rejects.push({ commandId: secondCommandId, code: "INVALID_COMMAND" });
    rendered.rerender(<ChatPanel {...props} />);
    await waitFor(() => expect(screen.getByText(/1 個媒體項目已通過 Complete/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "發送訊息" }));
    expect(runtime.sendIntent).toHaveBeenNthCalledWith(3, expect.objectContaining({ mediaIds: [secondMediaId] }));
    expect(runtime.sendIntent).not.toHaveBeenNthCalledWith(3, expect.objectContaining({ mediaIds: [firstMediaId] }));
  });

  it("hydrates only server-confirmed message media and never exposes the media identifier", async () => {
    const mediaId = "00000000-0000-4000-8000-000000000701";
    const message = { ...ownMessage, mediaIds: [mediaId] };
    const mediaGateway = {
      createMediaUpload: vi.fn(),
      completeMediaUpload: vi.fn(),
      getMedia: vi.fn(async () => ({
        mediaId,
        kind: "audio" as const,
        state: "processing" as const,
        detectedMime: null,
        sizeBytes: 3,
        altText: null,
        caption: "水聲觀察",
        failureCode: null,
        createdAt: "2026-08-31T01:05:00.000Z",
        updatedAt: "2026-08-31T01:05:00.000Z",
      })),
      getMediaDownloadGrant: vi.fn(),
    };
    const runtime = {
      session: student,
      room,
      sessionState: { status: "open" as const, connected: true },
      messages: () => [message],
      pendingCommandIds: () => [],
      rejects: [],
      sendIntent: vi.fn(),
      acks: new Map(),
      mediaStatuses: new Map(),
    };
    render(<ChatPanel runtime={runtime} mediaGateway={mediaGateway} allowedUploadOrigins={["https://storage.learning-orbit.test"]} />);
    expect(await screen.findByText("水聲觀察")).toBeInTheDocument();
    expect(screen.getByText(/仍在伺服器處理中/)).toBeInTheDocument();
    expect(mediaGateway.getMedia).toHaveBeenCalledWith(ROOM_ID, mediaId);
    expect(mediaGateway.getMediaDownloadGrant).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(mediaId);
  });

  it("lets a teacher retract but never revise student text and renders no composer", () => {
    const runtime = {
      session: teacher,
      room,
      sessionState: { status: "open" as const, connected: true },
      messages: () => [ownMessage],
      pendingCommandIds: () => [],
      rejects: [],
      sendIntent: vi.fn(),
      acks: new Map(),
    };
    render(<ChatPanel runtime={runtime} />);
    const region = screen.getByRole("region", { name: "共學對話" });
    expect(within(region).queryByLabelText("輸入訊息")).not.toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "修訂訊息 1" })).not.toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "撤回訊息 1" })).toBeInTheDocument();
  });
});
