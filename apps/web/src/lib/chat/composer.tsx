"use client";

import React, { useState } from "react";

import type { SessionStatus } from "../session/session-store";
import type { RoomCommandIntent } from "../session/session-command-bus";
import { InquiryPromptChips } from "./inquiry-prompt-chips";
import type { RosterMember } from "./roster";

const DISABLED_COPY: Partial<Record<SessionStatus, string>> = {
  scheduled: "課堂尚未開始；訊息暫時不能發送",
  paused: "課堂已暫停；訊息暫時不能發送",
  closed: "課堂已關閉；訊息不能再發送",
};

export interface ComposerProps {
  readonly roster: readonly RosterMember[];
  readonly roomStatus: SessionStatus;
  readonly replyTo: string | null;
  readonly replyLabel?: string;
  readonly replyLocked?: boolean;
  readonly mediaIds: readonly string[];
  readonly onSend: (intent: Extract<RoomCommandIntent, { type: "message.add" }>) => string;
  readonly onTypingChange?: (active: boolean) => void;
  readonly onCancelReply?: () => void;
  readonly onCommandSent?: (commandId: string) => void;
}

export function Composer({
  roster,
  roomStatus,
  replyTo,
  replyLabel,
  replyLocked = false,
  mediaIds,
  onSend,
  onTypingChange = () => undefined,
  onCancelReply = () => undefined,
  onCommandSent = () => undefined,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const enabled = roomStatus === "open";
  const canSend = enabled && (text.trim().length > 0 || mediaIds.length > 0);

  function insertMention(member: RosterMember) {
    setText((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@${member.pseudonym} `);
    setMentions((current) => [...new Set([...current, member.actorId])]);
    onTypingChange(true);
  }

  function submit() {
    if (!canSend) return;
    setError(undefined);
    try {
      const commandId = onSend({
        type: "message.add",
        text: text.trim(),
        replyTo,
        mentions: mentions.filter((actorId) => {
          const member = roster.find((candidate) => candidate.actorId === actorId);
          return member !== undefined && text.includes(`@${member.pseudonym}`);
        }),
        mediaIds: [...mediaIds],
      });
      setText("");
      setMentions([]);
      onTypingChange(false);
      onCommandSent(commandId);
    } catch {
      setError("訊息未送出。內容仍保留，請檢查課堂狀態後再試。");
    }
  }

  return (
    <div>
      <InquiryPromptChips disabled={!enabled} onInsert={(prompt) => {
        setText((current) => `${current}${current ? " " : ""}${prompt}`);
        onTypingChange(true);
      }} />
      <p className="composer-help">提示只協助組織問題；概念圖是否更新由伺服器分析與證據規則決定。</p>
      <div className="chips" aria-label="可提及的課堂參與者">
        {roster.map((member) => (
          <button className="chip" disabled={!enabled} key={member.actorId} onClick={() => insertMention(member)} type="button" aria-label={`提及 ${member.pseudonym}`}>
            @{member.pseudonym}
          </button>
        ))}
      </div>
      {roster.some(({ actorKind }) => actorKind === "agent") ? (
        <p className="composer-help">提及 Nova 不保證會收到回應；只有伺服器確認的 Agent 狀態與最終事件才會顯示。</p>
      ) : null}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        {replyTo ? (
          <div className="reply-strip">
            <span>{replyLabel ? `回覆${replyLabel}` : "回覆訊息"}</span>
            <button className="context-close" disabled={replyLocked} type="button" onClick={onCancelReply} aria-label="取消回覆">×</button>
          </div>
        ) : null}
        {mediaIds.length ? <p className="attachment-preview">{mediaIds.length} 個媒體項目已由伺服器確認，可隨訊息送出。</p> : null}
        <div className="composer-row">
          <label className="sr-only" htmlFor="message-composer">輸入訊息</label>
          <textarea
            id="message-composer"
            name="message"
            maxLength={4000}
            value={text}
            disabled={!enabled}
            onBlur={() => onTypingChange(false)}
            onChange={(event) => {
              setText(event.target.value);
              setError(undefined);
              onTypingChange(event.target.value.length > 0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="分享觀察、證據或問題…"
          />
          <button className="send-button" type="submit" disabled={!canSend}>發送訊息</button>
        </div>
        {DISABLED_COPY[roomStatus] ? <p className="composer-note" role="status">{DISABLED_COPY[roomStatus]}</p> : null}
        {error ? <p className="composer-error" role="alert">{error}</p> : null}
      </form>
    </div>
  );
}
