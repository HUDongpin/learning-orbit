"use client";

import type { AuthSession, RoomDetails } from "@learning-orbit/contracts";
import React, { useEffect, useState } from "react";

import type { LedgerMessage } from "../session/event-ledger";
import type { RoomCommandIntent } from "../session/session-command-bus";
import type { SessionStatus } from "../session/session-store";
import { Composer } from "./composer";
import { MessageCard } from "./message-card";
import { roomRoster } from "./roster";

type RejectView = Readonly<{ code: string; commandId?: string }>;

export interface ClassroomChatRuntime {
  readonly session: AuthSession;
  readonly room: RoomDetails;
  readonly sessionState: Readonly<{ status: SessionStatus; connected: boolean }>;
  readonly rejects: readonly RejectView[];
  readonly acks: ReadonlyMap<string, unknown>;
  messages(): LedgerMessage[];
  pendingCommandIds(): string[];
  sendIntent(intent: RoomCommandIntent): string;
}

export function ChatPanel({ runtime }: Readonly<{ runtime: ClassroomChatRuntime }>) {
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [pendingReply, setPendingReply] = useState<{ commandId: string; replyTo: string }>();
  const [latestCommandId, setLatestCommandId] = useState<string>();
  const roster = roomRoster(runtime.room);
  const messages = runtime.messages();
  const sequenceByMessageId = new Map(messages.map((message) => [message.messageId, message.firstRoomSeq]));
  const pending = runtime.pendingCommandIds();
  const latestConfirmed = latestCommandId !== undefined
    && (runtime.acks.has(latestCommandId) || messages.some(({ causationId }) => causationId === latestCommandId));
  const latestReject = latestCommandId === undefined || latestConfirmed
    ? undefined
    : [...runtime.rejects].reverse().find(({ commandId }) => commandId === latestCommandId);
  const replyAcknowledged = pendingReply !== undefined && runtime.acks.has(pendingReply.commandId);

  useEffect(() => {
    if (!replyAcknowledged || !pendingReply) return;
    setReplyTo((current) => current === pendingReply.replyTo ? null : current);
    setPendingReply(undefined);
  }, [pendingReply, replyAcknowledged]);

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
              {...(replySequence === undefined ? {} : {
                replyLabel: `訊息 ${replySequence}`,
                onNavigateReply: () => document.getElementById(`message-seq-${replySequence}`)?.focus(),
              })}
            />
          );
        }) : <p className="panel-meta">尚未收到伺服器確認的課堂訊息。</p>}
      </div>
      {pending.length ? <p className="composer-note" role="status">{pending.length} 個指令正在等待伺服器 ACK；訊息不會樂觀加入紀錄。</p> : null}
      {latestReject ? <p className="composer-error" role="alert">伺服器未接受上一個指令；課堂紀錄沒有被本地改寫。</p> : null}
      {runtime.session.role === "student" ? (
        <Composer
          roster={roster}
          roomStatus={runtime.sessionState.status}
          replyTo={replyTo}
          {...(replyTo && sequenceByMessageId.has(replyTo) ? { replyLabel: `訊息 ${sequenceByMessageId.get(replyTo)}` } : {})}
          replyLocked={pendingReply?.replyTo === replyTo}
          mediaIds={[]}
          onCancelReply={() => {
            if (pendingReply?.replyTo !== replyTo) setReplyTo(null);
          }}
          onCommandSent={(commandId) => {
            if (replyTo) setPendingReply({ commandId, replyTo });
          }}
          onSend={(intent) => sendIntent(intent)}
        />
      ) : null}
    </section>
  );
}
