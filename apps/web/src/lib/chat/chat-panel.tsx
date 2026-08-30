"use client";

import type { AuthSession, MediaStatusFrame, RoomDetails, ServerFrame } from "@learning-orbit/contracts";
import React, { useEffect, useRef, useState } from "react";

import type { LedgerMessage } from "../session/event-ledger";
import type { RoomCommandIntent } from "../session/session-command-bus";
import type { SessionStatus } from "../session/session-store";
import { Composer } from "./composer";
import { MessageCard } from "./message-card";
import { roomRoster } from "./roster";
import { MediaComposer, type MediaUploadFunction, type ObjectUrlPort } from "../media/media-composer";
import { MediaRecorderControl } from "../media/media-recorder";
import { uploadMediaFile, type MediaGateway } from "../media/media-upload";
import { MediaSlotReservations } from "../media/media-slot-reservations";
import { AgentStatusPanel } from "../agent/agent-status-panel";

type RejectView = Pick<Extract<ServerFrame, { type: "reject" }>, "code" | "commandId" | "retryable">;
type PendingSubmission = Readonly<{ commandId: string; replyTo: string | null; mediaIds: readonly string[] }>;
type SettledSubmission = Readonly<{ submission: PendingSubmission; outcome: "confirmed" | "rejected" }>;

export interface ClassroomChatRuntime {
  readonly session: AuthSession;
  readonly room: RoomDetails;
  readonly sessionState: Readonly<{ status: SessionStatus; connected: boolean }>;
  readonly rejects: readonly RejectView[];
  readonly acks: ReadonlyMap<string, unknown>;
  readonly mediaStatuses?: ReadonlyMap<string, MediaStatusFrame>;
  readonly agentStatus?: Extract<ServerFrame, { type: "agent_status" }> | undefined;
  readonly agentServiceUnavailable?: boolean | undefined;
  readonly agentStatusPending?: boolean | undefined;
  messages(): LedgerMessage[];
  pendingCommandIds(): string[];
  sendIntent(intent: RoomCommandIntent): string;
}

export function ChatPanel({ runtime, mediaGateway, allowedUploadOrigins = [], mediaUpload, mediaObjectUrls }: Readonly<{
  runtime: ClassroomChatRuntime;
  mediaGateway?: MediaGateway;
  allowedUploadOrigins?: readonly string[];
  mediaUpload?: MediaUploadFunction;
  mediaObjectUrls?: ObjectUrlPort;
}>) {
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [draftMediaIds, setDraftMediaIds] = useState<string[]>([]);
  const [pendingSubmissions, setPendingSubmissions] = useState<PendingSubmission[]>([]);
  const [mediaReset, setMediaReset] = useState<Readonly<{ generation: number; mediaIds: readonly string[] }>>({ generation: 0, mediaIds: [] });
  const [latestCommandId, setLatestCommandId] = useState<string>();
  const mediaSlots = useRef(new MediaSlotReservations(4));
  const roster = roomRoster(runtime.room);
  const messages = runtime.messages();
  const sequenceByMessageId = new Map(messages.map((message) => [message.messageId, message.firstRoomSeq]));
  const pending = runtime.pendingCommandIds();
  const latestConfirmed = latestCommandId !== undefined
    && (runtime.acks.has(latestCommandId) || messages.some(({ causationId }) => causationId === latestCommandId));
  const latestReject = latestCommandId === undefined || latestConfirmed
    ? undefined
    : [...runtime.rejects].reverse().find(({ commandId }) => commandId === latestCommandId);
  const confirmedCommandIds = new Set<string>([
    ...runtime.acks.keys(),
    ...messages.map(({ causationId }) => causationId),
  ]);
  const rejectedCommandIds = new Set(runtime.rejects.flatMap(({ commandId, retryable }) => commandId && retryable !== true ? [commandId] : []));
  const settledSubmissions = pendingSubmissions.reduce<SettledSubmission[]>((settled, submission) => {
    if (confirmedCommandIds.has(submission.commandId)) settled.push({ submission, outcome: "confirmed" });
    else if (rejectedCommandIds.has(submission.commandId)) settled.push({ submission, outcome: "rejected" });
    return settled;
  }, []);
  const settlementSignature = settledSubmissions.map(({ submission, outcome }) => `${submission.commandId}:${outcome}`).join("|");

  useEffect(() => {
    if (!settlementSignature) return;
    const settledIds = new Set(settledSubmissions.map(({ submission }) => submission.commandId));
    setPendingSubmissions((current) => current.filter(({ commandId }) => !settledIds.has(commandId)));
    const rejectedMediaIds = settledSubmissions
      .filter(({ outcome }) => outcome === "rejected")
      .flatMap(({ submission }) => submission.mediaIds);
    if (rejectedMediaIds.length) {
      setDraftMediaIds((current) => [...new Set([...current, ...rejectedMediaIds])]);
    }
    for (const { submission, outcome } of settledSubmissions) {
      if (outcome === "confirmed") submission.mediaIds.forEach((mediaId) => mediaSlots.current.remove(mediaId));
    }
    const confirmedReplies = new Set(settledSubmissions
      .filter(({ outcome }) => outcome === "confirmed")
      .flatMap(({ submission }) => submission.replyTo ? [submission.replyTo] : []));
    setReplyTo((current) => current && confirmedReplies.has(current) ? null : current);
    // The signature is the closed settlement snapshot for this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settlementSignature]);

  const reservedMediaUpload: MediaUploadFunction = async (input) => {
    const result = await mediaSlots.current.run(() => (mediaUpload ?? uploadMediaFile)(input));
    if (input.signal.aborted) {
      mediaSlots.current.remove(result.mediaId);
      throw new DOMException("Aborted", "AbortError");
    }
    setDraftMediaIds((current) => current.includes(result.mediaId) ? current : [...current, result.mediaId]);
    return result;
  };

  const sendIntent = (intent: RoomCommandIntent): string => {
    const commandId = runtime.sendIntent(intent);
    setLatestCommandId(commandId);
    return commandId;
  };
  return (
    <section className="orbit-panel chat-panel" aria-labelledby="chat-title" role="region">
      <header className="panel-head">
        <div>
          <span className="panel-kicker">RoomEvent Chat</span>
          <h2 className="panel-title" id="chat-title">共學對話</h2>
        </div>
        <span className="panel-meta">{runtime.sessionState.connected ? "WebSocket 已連線" : "等待連線"}</span>
      </header>
      <AgentStatusPanel
        {...(runtime.agentStatus ? { frame: runtime.agentStatus } : {})}
        serviceUnavailable={runtime.agentServiceUnavailable === true}
        pending={runtime.agentStatusPending === true}
      />
      <div className="messages" aria-live="polite">
        {messages.length ? messages.map((message) => {
          const replySequence = message.replyTo ? sequenceByMessageId.get(message.replyTo) : undefined;
          return (
            <MessageCard
              key={message.messageId}
              message={message}
              roster={roster}
              roomStatus={runtime.sessionState.status}
              viewer={runtime.session}
              onReply={setReplyTo}
              onCommand={(intent) => sendIntent(intent)}
              roomId={runtime.room.roomId}
              allowedDownloadOrigins={allowedUploadOrigins}
              {...(mediaGateway ? { mediaGateway } : {})}
              {...(runtime.mediaStatuses ? { mediaStatuses: runtime.mediaStatuses } : {})}
              {...(replySequence === undefined ? {} : {
                replyLabel: `訊息 ${replySequence}`,
                onNavigateReply: () => document.getElementById(`message-seq-${replySequence}`)?.focus(),
              })}
            />
          );
        }) : <p className="panel-meta">尚未收到伺服器確認的課堂訊息。</p>}
      </div>
      {pending.length ? <p className="composer-note" role="status">{pending.length} 個指令正在等待伺服器 ACK；訊息不會樂觀加入紀錄。</p> : null}
      {latestReject?.retryable ? <p className="composer-note" role="status">伺服器暫時未接受上一個指令；原指令與媒體仍鎖定在可靠佇列，等待重試。</p>
        : latestReject ? <p className="composer-error" role="alert">伺服器未接受上一個指令；課堂紀錄沒有被本地改寫。</p> : null}
      {runtime.session.role === "student" ? (
        <>
          {mediaGateway ? (
            <MediaComposer
              roomId={runtime.room.roomId}
              gateway={mediaGateway}
              roomStatus={runtime.sessionState.status}
              allowedUploadOrigins={allowedUploadOrigins}
              mediaIds={draftMediaIds}
              onReady={() => undefined}
              onRemoveReady={(mediaId) => {
                mediaSlots.current.remove(mediaId);
                setDraftMediaIds((current) => current.filter((candidate) => candidate !== mediaId));
              }}
              resetGeneration={mediaReset.generation}
              submittedMediaIds={mediaReset.mediaIds}
              upload={reservedMediaUpload}
              {...(mediaObjectUrls ? { objectUrls: mediaObjectUrls } : {})}
            />
          ) : null}
          {mediaGateway ? (
            <MediaRecorderControl
              roomId={runtime.room.roomId}
              gateway={mediaGateway}
              roomStatus={runtime.sessionState.status}
              allowedUploadOrigins={allowedUploadOrigins}
              onReady={() => undefined}
              upload={reservedMediaUpload}
              {...(mediaObjectUrls ? { objectUrls: mediaObjectUrls } : {})}
            />
          ) : null}
          <Composer
            roster={roster}
            roomStatus={runtime.sessionState.status}
            replyTo={replyTo}
            {...(replyTo && sequenceByMessageId.has(replyTo) ? { replyLabel: `訊息 ${sequenceByMessageId.get(replyTo)}` } : {})}
            replyLocked={replyTo !== null && pendingSubmissions.some((submission) => submission.replyTo === replyTo)}
            mediaIds={draftMediaIds}
            onCancelReply={() => {
              if (!pendingSubmissions.some((submission) => submission.replyTo === replyTo)) setReplyTo(null);
            }}
            onCommandSent={(commandId) => {
              if (replyTo || draftMediaIds.length) {
                const submittedMediaIds = [...draftMediaIds];
                setPendingSubmissions((current) => [...current, { commandId, replyTo, mediaIds: submittedMediaIds }]);
                if (submittedMediaIds.length) {
                  setDraftMediaIds((current) => current.filter((mediaId) => !submittedMediaIds.includes(mediaId)));
                  setMediaReset((current) => ({ generation: current.generation + 1, mediaIds: submittedMediaIds }));
                }
              }
            }}
            onSend={(intent) => sendIntent(intent)}
          />
        </>
      ) : null}
    </section>
  );
}
