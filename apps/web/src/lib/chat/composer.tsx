"use client";

import React, { useState } from "react";

import type { SessionStatus } from "../session/session-store";
import type { RoomCommandIntent } from "../session/session-command-bus";
import { identityStyle } from "./identity";
import { InquiryPromptChips } from "./inquiry-prompt-chips";
import type { RosterMember } from "./roster";

const DISABLED_COPY: Partial<Record<SessionStatus, string>> = {
  scheduled: "課堂尚未開始；訊息暫時不能發送",
  paused: "課堂已暫停；訊息暫時不能發送",
  closed: "課堂已關閉；訊息不能再發送",
};

/** Which optional media tray the student has opened. State lives in the parent dock. */
export type MediaTrayName = "attachments" | "recording";
export type MediaTrayState = Readonly<{ attachments: boolean; recording: boolean }>;

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
  /** Present only when the room actually has a media provider; omitted, no tray toggles render. */
  readonly mediaTrays?: MediaTrayState;
  readonly onToggleMediaTray?: (tray: MediaTrayName, open: boolean) => void;
}

function AttachIcon() {
  return (
    <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 20 20" fill="none">
      <path d="M13.8 6.2 7.6 12.4a1.9 1.9 0 0 0 2.7 2.7l6.5-6.5a3.6 3.6 0 0 0-5.1-5.1l-6.5 6.5a5.3 5.3 0 0 0 7.5 7.5l5.4-5.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 20 20" fill="none">
      <rect x="7.2" y="1.8" width="5.6" height="10.4" rx="2.8" stroke="currentColor" strokeWidth="1.7" />
      <path d="M4 9.4a6 6 0 0 0 12 0M10 15.4v2.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
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
  mediaTrays,
  onToggleMediaTray = () => undefined,
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
      <div className="chips" aria-label="可提及的課堂參與者">
        {roster.map((member) => (
          <button
            className="chip"
            data-who={enabled ? member.pseudonym : undefined}
            style={identityStyle(member.pseudonym, member.actorKind) as React.CSSProperties}
            disabled={!enabled}
            key={member.actorId}
            onClick={() => insertMention(member)}
            type="button"
            aria-label={`提及 ${member.pseudonym}`}
          >
            @{member.pseudonym}
          </button>
        ))}
      </div>
      <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        {replyTo ? (
          <div className="reply-strip">
            <span>{replyLabel ? `回覆${replyLabel}` : "回覆訊息"}</span>
            <button className="context-close" disabled={replyLocked} type="button" onClick={onCancelReply} aria-label="取消回覆">×</button>
          </div>
        ) : null}
        {mediaIds.length ? <p className="attachment-preview">{mediaIds.length} 個媒體項目已由伺服器確認，可隨訊息送出。</p> : null}
        <div className="composer-row">
          {mediaTrays ? (
            <div className="composer-tools">
              <button
                className="icon-button"
                type="button"
                aria-expanded={mediaTrays.attachments}
                aria-label="加入圖片或音訊檔案"
                onClick={() => onToggleMediaTray("attachments", !mediaTrays.attachments)}
              >
                <AttachIcon />
              </button>
              <button
                className="icon-button"
                type="button"
                aria-expanded={mediaTrays.recording}
                aria-label="錄一段語音"
                onClick={() => onToggleMediaTray("recording", !mediaTrays.recording)}
              >
                <MicIcon />
              </button>
            </div>
          ) : null}
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
            placeholder="寫下你的觀察、證據或問題…（Enter 送出，Shift + Enter 換行）"
          />
          <button className="send-button" type="submit" disabled={!canSend}>發送訊息</button>
        </div>
        {DISABLED_COPY[roomStatus] ? <p className="composer-note" role="status">{DISABLED_COPY[roomStatus]}</p> : null}
        {error ? <p className="composer-error" role="alert">{error}</p> : null}
        <p className="composer-help">
          提示只協助組織問題；概念圖是否更新由伺服器分析與證據規則決定。
          {mediaTrays ? "附件與錄音工具的開合只留在這個畫面，重新載入會回到預設。" : ""}
        </p>
        {roster.some(({ actorKind }) => actorKind === "agent") ? (
          <p className="composer-help">提及 Nova 不保證會收到回應；只有伺服器確認的 Agent 狀態與最終事件才會顯示。</p>
        ) : null}
      </form>
    </div>
  );
}
