"use client";

import type { AuthSession, CreateRoomResponse, TeacherRoomListResponse } from "@learning-orbit/contracts";
import { useRouter } from "next/navigation";
import React, { useEffect, useMemo, useRef, useState } from "react";

import {
  FetchSessionGateway,
  SessionGatewayError,
  type SessionGateway,
} from "../../src/lib/session/session-gateway";

const CLASS_TOPIC = "生態系統探究";
const ROOM_CODE_KEY = "room";

/** Numerals only: 13px is reserved for uppercase Latin and digits. */
const SEAT_NUMBER_STYLE: React.CSSProperties = {
  display: "grid",
  flex: "0 0 auto",
  inlineSize: "38px",
  blockSize: "38px",
  placeItems: "center",
  border: "1px solid var(--line-strong)",
  borderRadius: "var(--r-sm)",
  color: "var(--accent-green)",
  fontFamily: "var(--font-num)",
  fontSize: "var(--fs-micro)",
  fontWeight: 800,
};
const CODE_BODY_STYLE: React.CSSProperties = { flex: "1 1 auto" };
const COPIED_MARK_STYLE: React.CSSProperties = { color: "var(--accent-green)", whiteSpace: "nowrap" };
const TABULAR_STYLE: React.CSSProperties = { fontFamily: "var(--font-num)" };

type TeacherRoom = TeacherRoomListResponse["rooms"][number];
type WorkspaceState =
  | { kind: "checking" }
  | { kind: "ready"; session: Extract<AuthSession, { role: "teacher" }>; rooms: TeacherRoom[]; truncated: boolean }
  | { kind: "student"; roomId: string }
  | { kind: "unavailable" }
  | { kind: "logging-out" }
  | { kind: "logout-failed" };

const STATUS_LABEL: Readonly<Record<TeacherRoom["status"], string>> = {
  scheduled: "尚未開始",
  open: "進行中",
  paused: "已暫停",
  closed: "已結束",
};

function formatTime(value: string | null, fallback = "尚未開始"): string {
  if (value === null) return fallback;
  return new Intl.DateTimeFormat("zh-HK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Hong_Kong",
  }).format(new Date(value));
}

function copyBundle(created: CreateRoomResponse): string {
  return [
    `Learning Orbit｜${CLASS_TOPIC}`,
    `房間代碼：${created.room.roomCode}`,
    ...created.seatInvites.map((invite) => `${invite.pseudonym} 座位代碼：${invite.code}`),
    "每個座位代碼只供一位學生使用。",
  ].join("\n");
}

export interface TeacherClientProps {
  gateway?: SessionGateway;
}

export function TeacherClient({ gateway }: TeacherClientProps) {
  const router = useRouter();
  const api = useMemo(() => gateway ?? new FetchSessionGateway(), [gateway]);
  const [workspace, setWorkspace] = useState<WorkspaceState>({ kind: "checking" });
  const [created, setCreated] = useState<CreateRoomResponse>();
  const [savedRoomId, setSavedRoomId] = useState<string>();
  const [codesDismissed, setCodesDismissed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [copyStatus, setCopyStatus] = useState<string>();
  // Which rows the clipboard actually accepted, this render session only.
  // Keyed by member id, never by the code itself, so no code string can leak
  // into React state that outlives the one-time display.
  const [copiedKeys, setCopiedKeys] = useState<ReadonlySet<string>>(new Set());
  const authorityGeneration = useRef(0);
  const inviteHeading = useRef<HTMLHeadingElement>(null);
  const dismissedHeading = useRef<HTMLHeadingElement>(null);
  const actionErrorAlert = useRef<HTMLParagraphElement>(null);
  const recoveryHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (created) inviteHeading.current?.focus();
  }, [created]);

  useEffect(() => {
    if (codesDismissed) dismissedHeading.current?.focus();
  }, [codesDismissed]);

  useEffect(() => {
    if (actionError) actionErrorAlert.current?.focus();
  }, [actionError]);

  useEffect(() => {
    if (["student", "unavailable", "logging-out", "logout-failed"].includes(workspace.kind)) {
      recoveryHeading.current?.focus();
    }
  }, [workspace.kind]);

  useEffect(() => {
    if (!created) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [created]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const session = await api.getSession();
        if (!active) return;
        if (session.role === "student") {
          setWorkspace({ kind: "student", roomId: session.roomId });
          return;
        }
        const result = await api.getTeacherRooms();
        if (!active) return;
        setWorkspace({ kind: "ready", session, rooms: result.rooms, truncated: result.truncated });
      } catch (error) {
        if (!active) return;
        if (error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED") {
          router.replace("/login?role=teacher");
          return;
        }
        setWorkspace({ kind: "unavailable" });
      }
    })();
    return () => { active = false; };
  }, [api, router]);

  async function createClassroom() {
    if (workspace.kind !== "ready" || created) return;
    const generation = authorityGeneration.current;
    setCreating(true);
    setCodesDismissed(false);
    setSavedRoomId(undefined);
    setActionError(undefined);
    setCopyStatus(undefined);
    setCopiedKeys(new Set());
    try {
      const result = await api.createRoom({ topic: CLASS_TOPIC });
      if (generation !== authorityGeneration.current) return;
      setCreated(result);
      try {
        const refreshed = await api.getTeacherRooms();
        if (generation !== authorityGeneration.current) return;
        setWorkspace({ ...workspace, rooms: refreshed.rooms, truncated: refreshed.truncated });
      } catch (error) {
        if (generation !== authorityGeneration.current) return;
        if (error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED") {
          setCreated(undefined);
          setWorkspace({ kind: "checking" });
          router.replace("/login?role=teacher");
          return;
        }
        // The create response remains authoritative for this one-time invite view.
      }
    } catch (error) {
      if (generation !== authorityGeneration.current) return;
      if (error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED") {
        setCreated(undefined);
        setWorkspace({ kind: "checking" });
        router.replace("/login?role=teacher");
        return;
      }
      setActionError("未能建立房間。沒有產生任何可用代碼，請稍後再試。");
    } finally {
      if (generation === authorityGeneration.current) setCreating(false);
    }
  }

  async function copyText(value: string, success: string, keys: readonly string[]) {
    setCopyStatus(undefined);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("CLIPBOARD_UNAVAILABLE");
      await navigator.clipboard.writeText(value);
      // Only a resolved clipboard write may tick a row: a refused or missing
      // clipboard leaves the row unmarked and says so.
      setCopiedKeys((current) => new Set([...current, ...keys]));
      setCopyStatus(success);
    } catch {
      setCopyStatus("無法使用剪貼簿。請手動抄錄並安全保存代碼。");
    }
  }

  function confirmSaved() {
    if (!created) return;
    setSavedRoomId(created.room.roomId);
    setCreated(undefined);
    setCopyStatus(undefined);
    setCopiedKeys(new Set());
    setCodesDismissed(true);
  }

  async function logout() {
    if (workspace.kind === "logging-out") return;
    authorityGeneration.current += 1;
    setCreated(undefined);
    setSavedRoomId(undefined);
    setCodesDismissed(false);
    setCreating(false);
    setActionError(undefined);
    setCopyStatus(undefined);
    setCopiedKeys(new Set());
    setWorkspace({ kind: "logging-out" });
    try {
      await api.logout();
      router.replace("/login?role=teacher");
    } catch {
      setWorkspace({ kind: "logout-failed" });
    }
  }

  const inviteKeys = created
    ? [ROOM_CODE_KEY, ...created.seatInvites.map(({ roomMemberId }) => roomMemberId)]
    : [];
  const inviteTotal = inviteKeys.length;
  const copiedCount = inviteKeys.filter((key) => copiedKeys.has(key)).length;

  if (workspace.kind === "checking") {
    return <main className="teacher-shell teacher-centered" aria-busy="true"><p role="status">正在驗證教師 Session…</p></main>;
  }

  if (workspace.kind === "logging-out") {
    return (
      <main className="teacher-shell teacher-centered" aria-busy="true">
        <section className="teacher-recovery">
          <p className="login-eyebrow">Session revocation</p>
          <h1 ref={recoveryHeading} tabIndex={-1}>正在安全登出</h1>
          <p role="status">教師工作台、房間入口與一次性代碼已從瀏覽器記憶清除；正在撤銷伺服器 Session。</p>
        </section>
      </main>
    );
  }

  if (workspace.kind === "logout-failed") {
    return (
      <main className="teacher-shell teacher-centered">
        <section className="teacher-recovery">
          <p className="login-eyebrow">Fail closed</p>
          <h1 ref={recoveryHeading} tabIndex={-1}>未能確認登出</h1>
          <p className="teacher-alert" role="alert">未能完成登出。伺服器 Session 可能仍然有效；教師工作台與一次性代碼保持關閉。</p>
          <div className="recovery-actions">
            <button className="teacher-link-button" onClick={() => void logout()} type="button">再次清除 Session</button>
          </div>
        </section>
      </main>
    );
  }

  if (workspace.kind === "student") {
    return (
      <main className="teacher-shell teacher-centered">
        <section className="teacher-recovery">
          <p className="login-eyebrow">角色不相符</p>
          <h1 ref={recoveryHeading} tabIndex={-1}>這個頁面只供教師使用</h1>
          <p>目前 Session 是學生身份，因此沒有載入教師房間、代碼或監督資料。</p>
          <div className="recovery-actions">
            <a className="teacher-link-button" href={`/session/${workspace.roomId}`}>返回我的課堂</a>
          </div>
        </section>
      </main>
    );
  }

  if (workspace.kind === "unavailable") {
    return (
      <main className="teacher-shell teacher-centered">
        <section className="teacher-recovery">
          <p className="login-eyebrow">Fail closed</p>
          <h1 ref={recoveryHeading} tabIndex={-1}>暫時無法載入教師工作台</h1>
          <p>未能確認教師 Session 或房間清單；系統沒有載入任何模擬資料。</p>
          {actionError ? <p className="teacher-alert" ref={actionErrorAlert} role="alert" tabIndex={-1}>{actionError}</p> : null}
          <div className="recovery-actions">
            <button className="teacher-link-button" onClick={() => void logout()} type="button">
              清除 Session 並返回登入
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="teacher-shell">
      <a className="skip-link" href="#teacher-main">跳至主要內容</a>
      <header className="teacher-header">
        <div className="orbit-brand">
          <div className="orbit-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="4" /><ellipse cx="16" cy="16" rx="13" ry="6" /><ellipse cx="16" cy="16" rx="6" ry="13" /></svg>
          </div>
          <div><p className="teacher-brand-name">Learning Orbit</p><p className="orbit-subtitle">教師控制台</p></div>
        </div>
        <button className="teacher-secondary" disabled={Boolean(created)} onClick={() => void logout()} type="button">
          {created ? "登出（請先保存代碼）" : "登出"}
        </button>
      </header>

      <div className="teacher-main" id="teacher-main" tabIndex={-1}>
        <section className="teacher-hero">
          <div>
            <p className="login-eyebrow">Playful Research Lab</p>
            <h1>教師工作台</h1>
            <p>建立一個 45 分鐘的「{CLASS_TOPIC}」課堂，或返回你最近的房間。</p>
          </div>
          <button className="teacher-create" disabled={creating || Boolean(created)} onClick={() => void createClassroom()} type="button">
            {creating ? "正在建立…" : created ? "請先保存代碼" : "建立新課堂"}
          </button>
        </section>

        {actionError ? <p className="teacher-alert" ref={actionErrorAlert} role="alert" tabIndex={-1}>{actionError}</p> : null}

        {created ? (
          <section className="invite-card" aria-labelledby="invite-title">
            <div className="invite-head">
              <div>
                <p className="login-eyebrow">只顯示一次</p>
                <h2 id="invite-title" ref={inviteHeading} tabIndex={-1}>分發課堂代碼</h2>
                <p className="room-list-note">逐項交給對應座位的學生：全班共用房間代碼，座位代碼每人一個。</p>
              </div>
              <span className="teacher-status status-scheduled">尚未開始</span>
            </div>
            <p className="invite-warning">離開或確認保存後，系統不會再次顯示這些代碼。請先安全分發或保存。</p>
            <p className="copy-status">
              已複製 {copiedCount} / {inviteTotal} 項；核對記號只屬本次畫面，重新載入後會清除。
            </p>
            <div className="room-code-row">
              <div style={CODE_BODY_STYLE}><span>共同房間代碼</span><strong>{created.room.roomCode}</strong></div>
              {copiedKeys.has(ROOM_CODE_KEY)
                ? <span className="copy-status" style={COPIED_MARK_STYLE}>已複製</span>
                : null}
              <button className="teacher-secondary" onClick={() => void copyText(created.room.roomCode, "已複製房間代碼。", [ROOM_CODE_KEY])}>複製房間代碼</button>
            </div>
            <ol className="seat-code-list" aria-label="四個獨有座位代碼">
              {created.seatInvites.map((invite, index) => (
                <li key={invite.roomMemberId}>
                  <b aria-hidden="true" style={SEAT_NUMBER_STYLE}>{index + 1}</b>
                  <div style={CODE_BODY_STYLE}><span>{invite.pseudonym}</span><strong>{invite.code}</strong></div>
                  {copiedKeys.has(invite.roomMemberId)
                    ? <span className="copy-status" style={COPIED_MARK_STYLE}>已複製</span>
                    : null}
                  <button className="teacher-secondary" onClick={() => void copyText(invite.code, `已複製${invite.pseudonym}座位代碼。`, [invite.roomMemberId])}>
                    複製{invite.pseudonym}座位代碼
                  </button>
                </li>
              ))}
            </ol>
            {copyStatus ? <p className="copy-status" role="status">{copyStatus}</p> : null}
            <div className="invite-actions">
              <button className="teacher-secondary" onClick={() => void copyText(copyBundle(created), "已複製全部代碼。", inviteKeys)}>複製全部代碼</button>
              <button className="teacher-secondary" onClick={() => window.print()} type="button">列印座位卡</button>
              <button className="teacher-create" onClick={confirmSaved}>我已安全保存代碼</button>
            </div>
          </section>
        ) : null}

        {codesDismissed ? (
          <section className="codes-dismissed">
            <div><h2 ref={dismissedHeading} tabIndex={-1}>代碼顯示已關閉</h2><p role="status">房間列表不會再次顯示這些代碼。</p></div>
            {savedRoomId ? <a className="teacher-link-button" href={`/session/${savedRoomId}/teacher`}>開啟新課堂</a> : null}
          </section>
        ) : null}

        {!created ? <section className="room-list-section" aria-labelledby="room-list-title">
          <div className="section-heading"><div><p className="login-eyebrow">你的房間</p><h2 id="room-list-title">活躍與近期課堂</h2></div><span>{workspace.rooms.length} 個房間</span></div>
          {workspace.rooms.length === 0 ? (
            <div className="empty-rooms"><h3>尚未建立課堂</h3><p>建立房間後，這裡只會恢復入口，不會恢復 Room Code 或 Seat Code。</p></div>
          ) : (
            <ul className="teacher-room-list">
              {workspace.rooms.map((room) => (
                <li key={room.roomId}>
                  <div className="room-summary">
                    <div><span className={`teacher-status status-${room.status}`}>{STATUS_LABEL[room.status]}</span><h3>{room.topic}</h3></div>
                    <dl>
                      <div><dt>建立時間</dt><dd style={TABULAR_STYLE}>{formatTime(room.createdAt)}</dd></div>
                      <div><dt>結束時間</dt><dd style={TABULAR_STYLE}>{formatTime(room.closesAt, "尚未安排")}</dd></div>
                    </dl>
                  </div>
                  <a
                    aria-label={`開啟課堂 ${room.topic} ${STATUS_LABEL[room.status]}`}
                    className="teacher-room-link"
                    href={`/session/${room.roomId}/teacher`}
                  >開啟課堂<span aria-hidden="true">→</span></a>
                </li>
              ))}
            </ul>
          )}
          <p className="room-list-note">房間列表只恢復入口，不會再次顯示 Room Code 或 Seat Code。</p>
          {workspace.truncated ? <p className="room-list-note">只顯示最近 50 個房間；更舊房間未列出。</p> : null}
        </section> : null}
      </div>
    </main>
  );
}
