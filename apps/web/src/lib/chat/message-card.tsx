"use client";

import type { AuthSession } from "@learning-orbit/contracts";
import React, { useEffect, useState } from "react";

import type { LedgerMessage } from "../session/event-ledger";
import type { RoomCommandIntent } from "../session/session-command-bus";
import type { SessionStatus } from "../session/session-store";
import type { RosterMember } from "./roster";

export interface MessageCardProps {
  readonly message: LedgerMessage;
  readonly roster: readonly RosterMember[];
  readonly roomStatus: SessionStatus;
  readonly viewer: AuthSession;
  readonly onCommand: (intent: Extract<RoomCommandIntent, { type: "message.revise" | "message.retract" }>) => string;
  readonly onReply: (messageId: string) => void;
  readonly replyLabel?: string;
  readonly onNavigateReply?: () => void;
}

function eventLabel(message: LedgerMessage): string {
  return `訊息 ${message.firstRoomSeq}`;
}

export function MessageCard({ message, roster, roomStatus, viewer, onCommand, onReply, replyLabel, onNavigateReply }: MessageCardProps) {
  const [edit, setEdit] = useState<{ text: string; baseRevision: number }>();
  const [actionError, setActionError] = useState<string>();
  const author = roster.find(({ actorId }) => actorId === message.actorId);
  const ownStudentMessage = viewer.role === "student" && viewer.actorId === message.actorId && message.actorKind === "human";
  const canRevise = ownStudentMessage && message.operation !== "retract";
  const canRetract = message.operation !== "retract" && (ownStudentMessage || viewer.role === "teacher");
  const label = eventLabel(message);

  useEffect(() => {
    if (edit && (message.revision !== edit.baseRevision || roomStatus !== "open")) {
      setEdit(undefined);
      setActionError(message.revision !== edit.baseRevision
        ? "伺服器已更新這則訊息；舊修訂草稿未送出，請重新檢視。"
        : "課堂目前不能修改訊息；草稿未送出。");
    }
  }, [edit, message.revision, roomStatus]);

  return (
    <article className={`message ${ownStudentMessage ? "self" : ""} ${message.actorKind === "agent" ? "agent" : ""} ${message.operation === "retract" ? "retracted" : ""}`} id={`message-seq-${message.firstRoomSeq}`} tabIndex={-1}>
      <div className={`avatar ${message.actorKind === "agent" ? "agent" : ""}`} aria-hidden="true"><span>{author?.pseudonym.slice(0, 1) ?? "?"}</span></div>
      <div className="bubble-wrap">
        <p className="message-name">{author?.pseudonym ?? "課堂參與者"} · {label}</p>
        {message.replyTo ? (
          <button className="reply-strip tiny-action" type="button" onClick={onNavigateReply} disabled={!onNavigateReply}>
            {replyLabel ? `查看回覆來源${replyLabel}` : "回覆來源目前不可用"}
          </button>
        ) : null}
        <div className="bubble">
          {message.operation === "retract" ? <span>訊息已由伺服器標記為撤回</span> : <span>{message.text}</span>}
          {message.mediaIds.length ? <p className="media-caption">媒體狀態等待伺服器確認</p> : null}
        </div>
        <time className="message-time" dateTime={message.eventTime}>roomSeq {message.roomSeq} · 修訂 {message.revision}</time>
        {edit ? (
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!edit.text.trim() || roomStatus !== "open") return;
            try {
              onCommand({
                type: "message.revise",
                messageId: message.messageId,
                text: edit.text,
                replyTo: message.replyTo,
                mentions: message.mentions,
                baseRevision: edit.baseRevision,
              });
              setEdit(undefined);
              setActionError(undefined);
            } catch {
              setActionError("修訂未能加入伺服器指令佇列；原訊息沒有改變。");
            }
          }}>
            <label htmlFor={`edit-message-${message.firstRoomSeq}`}>修訂內容</label>
            <textarea id={`edit-message-${message.firstRoomSeq}`} maxLength={4000} value={edit.text} onChange={(event) => setEdit({ ...edit, text: event.target.value })} />
            <button className="tiny-action" type="submit" disabled={!edit.text.trim() || roomStatus !== "open"}>送出修訂</button>
            <button className="tiny-action" type="button" onClick={() => { setEdit(undefined); setActionError(undefined); }}>取消</button>
          </form>
        ) : null}
        {actionError ? <p className="composer-error" role="alert">{actionError}</p> : null}
        <div className="message-actions">
          {viewer.role === "student" && message.operation !== "retract" ? <button className="tiny-action" disabled={roomStatus !== "open"} type="button" onClick={() => onReply(message.messageId)}>回覆{label}</button> : null}
          {canRevise ? <button className="tiny-action" disabled={roomStatus !== "open"} type="button" onClick={() => { setActionError(undefined); setEdit({ text: message.text, baseRevision: message.revision }); }}>修訂{label}</button> : null}
          {canRetract ? <button className="tiny-action" disabled={roomStatus !== "open"} type="button" onClick={() => {
            if (roomStatus === "open" && globalThis.confirm(`確定要撤回${label}嗎？撤回會等待伺服器確認。`)) {
              try {
                onCommand({ type: "message.retract", messageId: message.messageId, baseRevision: message.revision });
                setActionError(undefined);
              } catch {
                setActionError("撤回未能加入伺服器指令佇列；原訊息沒有改變。");
              }
            }
          }}>撤回{label}</button> : null}
        </div>
      </div>
    </article>
  );
}
