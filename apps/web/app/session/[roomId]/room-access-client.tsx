"use client";

import type { AuthSession, DeleteRoomAccepted, DeletionStatus, RoomDetails } from "@learning-orbit/contracts";
import { useRouter } from "next/navigation";
import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";

import {
  FetchSessionGateway,
  SessionGatewayError,
  type SessionGateway,
} from "../../../src/lib/session/session-gateway";
import { isRoomId, roomPagePath } from "../../../src/lib/session/room-route";
import { HydratedSessionState } from "../../../src/lib/session/hydrated-session-state";
import { ChatPanel } from "../../../src/lib/chat/chat-panel";
import { identityInitial, identityStyle } from "../../../src/lib/chat/identity";
import { parseStorageBrowserOrigins } from "../../../src/lib/media/media-upload";
import { EchoPanel } from "../../../src/lib/analytics/echo-panel";
import { TracePanel } from "../../../src/lib/analytics/trace-panel";
import { TeacherControlPanel } from "../../../src/lib/teacher/teacher-control-panel";
import { DeletionStatusPanel, RoomDeletionRecoveryPanel } from "../../../src/lib/teacher/deletion-status-panel";

type AccessMode = "student" | "teacher";
type AccessAuthority = Readonly<{ api: SessionGateway; mode: AccessMode; roomId: string }>;
type AccessState =
  | { kind: "checking" }
  | { kind: "student-ready"; hydrated: HydratedSessionState; authority: AccessAuthority }
  | { kind: "teacher-ready"; hydrated: HydratedSessionState; authority: AccessAuthority }
  | { kind: "teacher-deletion"; initial: DeleteRoomAccepted | DeletionStatus; authority: AccessAuthority }
  | { kind: "teacher-deletion-unknown"; authority: AccessAuthority }
  | { kind: "forbidden" }
  | { kind: "authority-lost" }
  | { kind: "unavailable" };

const STATUS_COPY: Readonly<Record<RoomDetails["status"], string>> = {
  scheduled: "尚未開始",
  open: "進行中",
  paused: "已暫停",
  closed: "已結束",
};
const MEDIA_UPLOAD_ORIGINS = parseStorageBrowserOrigins(process.env.NEXT_PUBLIC_LO_STORAGE_BROWSER_ORIGINS);
/**
 * The server holds an accepted presence signal for 30s and rate-limits a seat
 * to one every 5s, so re-asserting every 12s keeps an idle-but-open tab on the
 * roster with room to spare on both sides.
 */
const PRESENCE_KEEPALIVE_MS = 12_000;
/**
 * The server drops a second presence signal from the same seat inside this
 * window, without acknowledging either way. A tab switched away and back
 * lands inside it, so the "active" is swallowed and the seat reads away until
 * the next keepalive. One catch-up just past the window closes that gap.
 */
const PRESENCE_RATE_LIMIT_MS = 5_200;
/**
 * A peer that closes its tab emits no departure frame, so nothing arrives to
 * re-render its seat. This beat lets the local expiry check retire it.
 */
const PRESENCE_SWEEP_MS = 5_000;
const PRESENCE_COPY: Readonly<Record<"active" | "away" | "unknown", string>> = {
  active: "在線",
  away: "暫時離開",
  unknown: "伺服器未回報在線狀態",
};
const DEFAULT_AGENT_STATUS_TIMEOUT_MS = 1_500;

/** Narrow surfaces for the phone tab bar. globals.css hides the inactive ones below 767px. */
type WorkSurface = "chat" | "echo" | "trace";
const WORK_SURFACES: readonly Readonly<{ id: WorkSurface; label: string }>[] = [
  { id: "chat", label: "對話" },
  { id: "echo", label: "概念圖" },
  { id: "trace", label: "網絡" },
];

/**
 * The three display controls are React state and nothing else.
 *
 * A remembered preference would need localStorage, and this product's own e2e
 * gate fails if any browser storage is written at all — so every control says,
 * in its own accessible copy, that the choice is dropped on reload rather than
 * implying a saved setting that does not exist.
 */
const RESET_NOTE = "這個選擇只在這一次瀏覽有效，重新載入頁面後會回到預設。";

export interface RoomAccessClientProps {
  gateway?: SessionGateway;
  mode: AccessMode;
  roomId: string;
  agentStatusTimeoutMs?: number;
}

function RecoveryHeading({ children }: Readonly<{ children: React.ReactNode }>) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [children]);
  return <h1 ref={heading} tabIndex={-1}>{children}</h1>;
}

export function RoomAccessClient({ gateway, mode, roomId, agentStatusTimeoutMs = DEFAULT_AGENT_STATUS_TIMEOUT_MS }: RoomAccessClientProps) {
  const router = useRouter();
  const api = useMemo(() => gateway ?? new FetchSessionGateway(), [gateway]);
  const authority = useMemo<AccessAuthority>(() => ({ api, mode, roomId }), [api, mode, roomId]);
  const validRoomId = isRoomId(roomId);
  const [state, setState] = useState<AccessState>(() => validRoomId ? { kind: "checking" } : { kind: "forbidden" });
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string>();
  const [retryToken, setRetryToken] = useState(0);
  const [surface, setSurface] = useState<WorkSurface>("chat");
  const [theme, setTheme] = useState<"dark" | "light">();
  const [projector, setProjector] = useState(false);
  const [band, setBand] = useState<"junior" | "senior">();
  const [, renderHydratedUpdate] = useReducer((version: number) => version + 1, 0);
  const activeHydrated = useRef<HydratedSessionState | undefined>(undefined);
  const unsubscribeActiveHydrated = useRef<(() => void) | undefined>(undefined);

  function disposeActiveHydration() {
    unsubscribeActiveHydrated.current?.();
    unsubscribeActiveHydrated.current = undefined;
    activeHydrated.current?.dispose();
    activeHydrated.current = undefined;
  }

  useEffect(() => {
    let active = true;
    let confirmedSession: AuthSession | undefined;
    const accessController = new AbortController();
    let hydrated: HydratedSessionState | undefined;
    let unsubscribeHydrated: (() => void) | undefined;
    void (async () => {
      if (!validRoomId) return;
      try {
        const session = await api.getSession();
        confirmedSession = session;
        if (!active) return;

        if (mode === "teacher" && session.role !== "teacher") {
          setState({ kind: "forbidden" });
          return;
        }
        if (mode === "student" && session.role === "student" && session.roomId !== roomId) {
          setState({ kind: "forbidden" });
          return;
        }

        if (session.role === "teacher") {
          try {
            const deletion = await api.getRoomDeletion(roomId, { signal: accessController.signal });
            if (!active) return;
            if (mode === "student") {
              router.replace(roomPagePath(roomId, "teacher"));
              return;
            }
            setState({ kind: "teacher-deletion", initial: deletion, authority });
            return;
          } catch (error) {
            if (error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED") {
              router.replace("/login?role=teacher");
              return;
            }
            if (!(error instanceof SessionGatewayError) || error.code !== "ROOM_NOT_FOUND") throw error;
          }
        }

        const details = await api.getRoom(roomId);
        if (!active) return;
        if (details.roomId !== roomId) {
          setState({ kind: "forbidden" });
          return;
        }

        if (session.role === "teacher") {
          if (mode === "student") {
            router.replace(roomPagePath(roomId, "teacher"));
            return;
          }
        }
        hydrated = await HydratedSessionState.create({
          session,
          room: details,
          gateway: api,
          agentStatusTimeoutMs,
          onSessionExpired: () => {
            if (!active) return;
            disposeActiveHydration();
            setState({ kind: "checking" });
            router.replace(mode === "teacher" ? "/login?role=teacher" : "/login");
          },
          onRoomUnavailable: () => {
            if (!active) return;
            if (session.role !== "teacher") {
              disposeActiveHydration();
              setState({ kind: "authority-lost" });
              return;
            }
            void api.getRoomDeletion(roomId, { signal: accessController.signal }).then(
              (deletion) => {
                if (active) {
                  disposeActiveHydration();
                  setState({ kind: "teacher-deletion", initial: deletion, authority });
                }
              },
              (statusError) => {
                if (!active || accessController.signal.aborted) return;
                if (statusError instanceof SessionGatewayError && statusError.code === "AUTH_REQUIRED") {
                  router.replace("/login?role=teacher");
                } else {
                  setState({ kind: "authority-lost" });
                }
              },
            );
          },
        });
        // Event recovery can legitimately advance a stale open RoomDetails
        // read to room.closed. Decide admission from the hydrated durable
        // ledger, not the pre-recovery HTTP snapshot.
        const supportsRealtime = hydrated.sessionState.status !== "closed"
          && typeof globalThis.WebSocket === "function";
        if (!active) {
          hydrated.dispose();
          return;
        }
        unsubscribeHydrated = hydrated.subscribe(() => {
          if (active) renderHydratedUpdate();
        });
        activeHydrated.current = hydrated;
        unsubscribeActiveHydrated.current = unsubscribeHydrated;
        if (supportsRealtime) hydrated.connectNative();
        setState(session.role === "teacher"
          ? { kind: "teacher-ready", hydrated, authority }
          : { kind: "student-ready", hydrated, authority });
        if (!supportsRealtime) void hydrated.refreshAgentCurrent();
      } catch (error) {
        if (!active) return;
        if (error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED") {
          router.replace(mode === "teacher" ? "/login?role=teacher" : "/login");
          return;
        }
        if (error instanceof SessionGatewayError && (error.code === "ROOM_NOT_FOUND" || error.code === "FORBIDDEN")) {
          setState({ kind: "authority-lost" });
          return;
        }
        if (confirmedSession?.role === "teacher" && error instanceof SessionGatewayError && error.code === "DELETION_IN_PROGRESS") {
          if (mode === "student") {
            router.replace(roomPagePath(roomId, "teacher"));
            return;
          }
          try {
            const deletion = await api.getRoomDeletion(roomId, { signal: accessController.signal });
            if (active) setState({ kind: "teacher-deletion", initial: deletion, authority });
          } catch (statusError) {
            if (statusError instanceof SessionGatewayError && statusError.code === "AUTH_REQUIRED") {
              router.replace("/login?role=teacher");
            } else if (active) {
              setState({ kind: "unavailable" });
            }
          }
          return;
        }
        setState({ kind: "unavailable" });
      }
    })();
    return () => {
      active = false;
      accessController.abort();
      unsubscribeHydrated?.();
      hydrated?.dispose();
      if (activeHydrated.current === hydrated) activeHydrated.current = undefined;
      if (unsubscribeActiveHydrated.current === unsubscribeHydrated) unsubscribeActiveHydrated.current = undefined;
    };
    // retryToken is a dependency on purpose: the recovery gates re-run this
    // whole access check by bumping it, so a retry is a real second request to
    // the server rather than a cosmetic reset of the error screen.
  }, [agentStatusTimeoutMs, api, authority, mode, retryToken, roomId, router, validRoomId]);

  const seatedHydrated = "hydrated" in state ? state.hydrated : undefined;
  const [, sweepPresenceClock] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (!seatedHydrated) return undefined;
    let catchUp: ReturnType<typeof setTimeout> | undefined;
    const announce = () => seatedHydrated.signalPresence(
      document.visibilityState === "hidden" ? "away" : "active",
    );
    const announceVisibility = () => {
      announce();
      if (catchUp !== undefined) clearTimeout(catchUp);
      catchUp = setTimeout(announce, PRESENCE_RATE_LIMIT_MS);
    };
    // Claim the seat, and keep claiming it. Sending is a no-op until resume
    // completes, so this first call is harmless when it lands early:
    // HydratedSessionState also announces on every resume_complete, which is
    // what re-claims the seat after a reconnect.
    announce();
    const keepalive = setInterval(announce, PRESENCE_KEEPALIVE_MS);
    const sweep = setInterval(sweepPresenceClock, PRESENCE_SWEEP_MS);
    document.addEventListener("visibilitychange", announceVisibility);
    return () => {
      if (catchUp !== undefined) clearTimeout(catchUp);
      clearInterval(keepalive);
      clearInterval(sweep);
      document.removeEventListener("visibilitychange", announceVisibility);
      // One last frame on the way out so peers grey the seat immediately
      // instead of waiting out the 30s expiry.
      seatedHydrated.signalPresence("away");
    };
  }, [seatedHydrated]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.dataset.theme = theme; else delete root.dataset.theme;
    if (projector) root.dataset.display = "projector"; else delete root.dataset.display;
    if (band) root.dataset.band = band; else delete root.dataset.band;
    return () => {
      delete root.dataset.theme;
      delete root.dataset.display;
      delete root.dataset.band;
    };
  }, [band, projector, theme]);

  function retryAccess() {
    disposeActiveHydration();
    setLogoutError(undefined);
    setState(validRoomId ? { kind: "checking" } : { kind: "forbidden" });
    setRetryToken((token) => token + 1);
  }

  async function logout() {
    setLoggingOut(true);
    setLogoutError(undefined);
    disposeActiveHydration();
    setState({ kind: "authority-lost" });
    try {
      await api.logout();
      router.replace(mode === "teacher" ? "/login?role=teacher" : "/login");
    } catch {
      setLogoutError("未能完成登出。伺服器 Session 可能仍然有效，請稍後再試。");
      setLoggingOut(false);
    }
  }

  if (state.kind === "checking") {
    return <main className="room-gate-shell room-gate-centered" aria-busy="true"><p role="status">正在驗證 Session 與房間權限…</p></main>;
  }

  if (state.kind === "teacher-deletion") {
    if (state.authority !== authority) {
      return <main className="room-gate-shell room-gate-centered" aria-busy="true"><p role="status">正在驗證 Session 與房間權限…</p></main>;
    }
    return (
      <DeletionStatusPanel
        initial={state.initial}
        gateway={api}
        onSessionExpired={() => router.replace("/login?role=teacher")}
      />
    );
  }

  if (state.kind === "teacher-deletion-unknown") {
    if (state.authority !== authority) {
      return <main className="room-gate-shell room-gate-centered" aria-busy="true"><p role="status">正在驗證 Session 與房間權限…</p></main>;
    }
    return (
      <RoomDeletionRecoveryPanel
        roomId={roomId}
        gateway={api}
        onSessionExpired={() => router.replace("/login?role=teacher")}
      />
    );
  }

  if ((state.kind === "student-ready" || state.kind === "teacher-ready")
    && (state.authority !== authority || state.hydrated.sessionState.roomId !== roomId)) {
    return <main className="room-gate-shell room-gate-centered" aria-busy="true"><p role="status">正在驗證 Session 與房間權限…</p></main>;
  }

  if (state.kind === "forbidden") {
    return (
      <main className="room-gate-shell room-gate-centered">
        <section className="room-gate-card">
          <p className="login-eyebrow">房間不可用</p>
          <RecoveryHeading>無法開啟這個課堂</RecoveryHeading>
          <p>房間可能不存在、已刪除，或不屬於目前的 Session。系統沒有載入模擬房間。</p>
          <div className="recovery-actions">
            <button className="teacher-create" onClick={() => retryAccess()} type="button">重新檢查課堂權限</button>
            <a className="teacher-link-button" href="/login">返回安全入口</a>
          </div>
        </section>
      </main>
    );
  }

  if (state.kind === "authority-lost") {
    return (
      <main className="room-gate-shell room-gate-centered">
        <section className="room-gate-card">
          <p className="login-eyebrow">房間不可用</p>
          <RecoveryHeading>目前的 Session 無法再開啟這個課堂</RecoveryHeading>
          <p>房間可能已結束、刪除，或目前的房間權限已變更。系統已清除記憶體中的課堂狀態，也不會載入 Fixture。</p>
          {logoutError ? <p className="teacher-alert" role="alert">{logoutError}</p> : null}
          <div className="recovery-actions">
            <button className="teacher-create" disabled={loggingOut} onClick={() => retryAccess()} type="button">重新檢查課堂權限</button>
            <button className="teacher-secondary" disabled={loggingOut} onClick={() => void logout()} type="button">
              {loggingOut ? "正在清除 Session…" : "清除 Session 並返回登入"}
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <main className="room-gate-shell room-gate-centered">
        <section className="room-gate-card">
          <p className="login-eyebrow">Fail closed</p>
          <RecoveryHeading>課堂服務暫時不可用</RecoveryHeading>
          <p>未能從伺服器確認房間狀態，因此聊天室、分析與媒體功能都沒有啟動。</p>
          {logoutError ? <p className="teacher-alert" role="alert">{logoutError}</p> : null}
          <div className="recovery-actions">
            <button className="teacher-create" disabled={loggingOut} onClick={() => retryAccess()} type="button">重新檢查課堂權限</button>
            <button className="teacher-secondary" disabled={loggingOut} onClick={() => void logout()} type="button">
              {loggingOut ? "正在清除 Session…" : "清除 Session 並返回登入"}
            </button>
          </div>
        </section>
      </main>
    );
  }

  const isTeacher = state.kind === "teacher-ready";
  const hydrated = state.hydrated;
  if (hydrated.recoveryError) {
    return (
      <main className="room-gate-shell room-gate-centered">
        <section className="room-gate-card">
          <p className="login-eyebrow">Fail closed</p>
          <RecoveryHeading>即時同步已停止</RecoveryHeading>
          <p role="alert">事件資料未能連續、完整地通過伺服器 Contract 驗證。為避免顯示過期或不完整的課堂內容，本頁已隱藏房間資料並停止自動重連。</p>
          {logoutError ? <p className="teacher-alert" role="alert">{logoutError}</p> : null}
          <div className="recovery-actions">
            <button className="teacher-create" disabled={loggingOut} onClick={() => retryAccess()} type="button">重新檢查課堂權限</button>
            <button className="teacher-secondary" disabled={loggingOut} onClick={() => void logout()} type="button">
              {loggingOut ? "正在清除 Session…" : "清除 Session 並返回登入"}
            </button>
          </div>
        </section>
      </main>
    );
  }
  const details = hydrated.room;
  const liveState = hydrated.sessionState;
  const echoProjectionKey = isTeacher ? "echo.teacher_shadow" as const : "echo.student_approved" as const;
  const traceProjectionKey = isTeacher ? "trace.teacher_bundle" as const : "trace.student_bundle" as const;
  const teacherEchoSlot = isTeacher ? hydrated.projections.slot("echo.teacher_shadow") : undefined;
  const teacherEcho = teacherEchoSlot?.snapshot?.projectionKey === "echo.teacher_shadow"
    ? teacherEchoSlot.snapshot
    : undefined;
  const analyticsCorrectionEventIds = isTeacher
    ? hydrated.ledger.events()
      .filter(({ type }) => type === "analytics.correction.recorded.v1")
      .map(({ eventId }) => eventId)
    : [];
  const echoSnapshot = hydrated.projections.slot(echoProjectionKey).snapshot;
  // How far the server's own concept map has been built, so the composer can
  // say what the map already covers instead of guessing.
  const mapProgress = echoSnapshot
    ? {
      projectionVersion: echoSnapshot.projectionVersion,
      completeThroughRoomSeq: echoSnapshot.completeThroughRoomSeq,
    } as const
    : undefined;
  const eventCount = hydrated.ledger.events().length;
  const connectionCopy = liveState.status === "closed"
    ? liveState.connected ? "課堂已結束，連線只用來接收權限變更" : "課堂已結束，不再建立即時連線"
    : liveState.connected ? "即時同步中：WebSocket 已連線" : "正在連線，接通之前不會有新內容出現";
  const durationMinutes = Math.round(details.durationSeconds / 60);
  const themeLabel = theme === undefined ? "自動" : theme === "dark" ? "深色" : "淺色";
  const themeCopy = `深淺 ${themeLabel}：${theme === undefined
    ? "現在跟隨你裝置的深色或淺色設定，按一下改用深色。"
    : theme === "dark" ? "現在用深色畫面，按一下改用淺色。" : "現在用淺色畫面，按一下改回跟隨裝置。"}${RESET_NOTE}`;
  const projectorCopy = `投影 ${projector ? "開" : "關"}：${projector
    ? "現在用高對比的投影模式，按一下關閉。"
    : "現在用一般螢幕的顏色。課室開燈用投影機時，柔和的綠色會被投影機的伽瑪壓掉，按一下開啟高對比。"}${RESET_NOTE}`;
  const bandLabel = band === undefined ? "預設" : band === "junior" ? "寬鬆" : "緊湊";
  const bandCopy = `間距 ${bandLabel}：${band === undefined
    ? "現在用預設的行距與間距，按一下改為寬鬆一點。"
    : band === "junior" ? "現在的行距與間距寬鬆一點，按一下改為緊湊。" : "現在的行距與間距緊湊一點，按一下改回預設。"}${RESET_NOTE}`;
  return (
    <main className="room-gate-shell" data-shell="app">
      <a className="skip-link" href="#classroom-workspace">跳到共學工作區</a>
      <header className="room-bar">
        <div className="room-bar-identity">
          <div className="orbit-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="4" /><ellipse cx="16" cy="16" rx="13" ry="6" /><ellipse cx="16" cy="16" rx="6" ry="13" /></svg></div>
          <div>
            <p className="teacher-brand-name">Learning Orbit</p>
            {/* The .room-gate-heading wrapper stays: e2e reads the seat
                pseudonym through ".room-gate-heading .login-eyebrow". */}
            <div className="room-gate-heading">
              <p className="login-eyebrow">{isTeacher ? "教師房間控制台" : hydrated.session.role === "student" ? hydrated.session.pseudonym : ""}</p>
            </div>
          </div>
          <div>
            <h1 className="room-bar-topic">{details.topic}</h1>
            <p className="room-bar-meta">
              <span className={`teacher-status status-${liveState.status}`}>{STATUS_COPY[liveState.status]}</span>
              <span>{details.participants.length} 個匿名座位</span>
              <span className="orbit-clock">{durationMinutes} 分鐘課堂</span>
            </p>
          </div>
        </div>
        {/* Every seat state here is a server-sent presence signal that has not
            yet expired. A seat the server has not vouched for stays dashed and
            labelled "未回報": absence of a signal is never drawn as presence. */}
        <ul className="crew-strip" aria-label="課堂座位">
          {details.participants.map((participant) => {
            const presence = hydrated.presenceStateOf(participant.actorId);
            return (
              <li
                aria-label={`${participant.pseudonym}：${PRESENCE_COPY[presence]}`}
                className="crew-chip"
                data-state={presence}
                key={participant.actorId}
                style={identityStyle(participant.pseudonym, participant.actorKind) as React.CSSProperties}
              >{identityInitial(participant.pseudonym)}</li>
            );
          })}
        </ul>
        <div className="room-bar-actions">
          <button
            aria-label={themeCopy}
            aria-pressed={theme !== undefined}
            className="icon-button"
            onClick={() => setTheme((current) => current === undefined ? "dark" : current === "dark" ? "light" : undefined)}
            title={themeCopy}
            type="button"
          >深淺 {themeLabel}</button>
          <button
            aria-label={projectorCopy}
            aria-pressed={projector}
            className="icon-button"
            onClick={() => setProjector((current) => !current)}
            title={projectorCopy}
            type="button"
          >投影 {projector ? "開" : "關"}</button>
          <button
            aria-label={bandCopy}
            aria-pressed={band !== undefined}
            className="icon-button"
            onClick={() => setBand((current) => current === undefined ? "junior" : current === "junior" ? "senior" : undefined)}
            title={bandCopy}
            type="button"
          >間距 {bandLabel}</button>
          {isTeacher ? <a className="teacher-link-button" href="/teacher">返回教師工作台</a> : null}
          <button className="teacher-secondary" disabled={loggingOut} onClick={() => void logout()} type="button">
            {loggingOut ? "正在登出…" : "登出"}
          </button>
        </div>
      </header>
      <section className="room-gate-main">
        <div>
          {logoutError ? <p className="teacher-alert" role="alert">{logoutError}</p> : null}
          <div className="room-hydration-notice" role="status">
            <h2>伺服器已確認這個課堂</h2>
            <p>已按伺服器 roomSeq 同步 {eventCount} 個 RoomEvent，每一個都由伺服器確認過；{connectionCopy}。下面的分析區只會顯示伺服器批准你這個身分看的內容。</p>
          </div>
        </div>
        {/* Inline layout only, no new token: at >=1120px globals.css makes the
            shell a 100dvh grid whose second row is this box, so the console and
            the workspace scroll here instead of the page growing without end. */}
        <div style={{ minHeight: 0, overflow: "auto" }}>
          {isTeacher ? (
            <TeacherControlPanel
              roomId={roomId}
              roomStatus={liveState.status}
              {...(teacherEcho ? { echo: teacherEcho } : {})}
              {...(hydrated.agentStatus ? { agentEnabled: hydrated.agentStatus.agentEnabled } : {})}
              analyticsCorrectionEventIds={analyticsCorrectionEventIds}
              gateway={api}
              runtime={hydrated}
              onDeletionAccepted={(initial) => {
                disposeActiveHydration();
                setState({ kind: "teacher-deletion", initial, authority });
              }}
              onDeletionUncertain={() => {
                disposeActiveHydration();
                setState({ kind: "teacher-deletion-unknown", authority });
              }}
              onSessionExpired={() => {
                disposeActiveHydration();
                setState({ kind: "checking" });
                router.replace("/login?role=teacher");
              }}
            />
          ) : null}
          <div className="orbit-grid room-workspace" data-surface={surface} id="classroom-workspace" tabIndex={-1}>
            <ChatPanel
              runtime={hydrated}
              mediaGateway={api}
              allowedUploadOrigins={MEDIA_UPLOAD_ORIGINS}
              {...(mapProgress ? { mapProgress } : {})}
            />
            <div className="analysis-column" aria-label="伺服器分析區">
              <EchoPanel
                slot={hydrated.projections.slot(echoProjectionKey)}
                onLoadTimeline={() => hydrated.loadConceptTimeline(echoProjectionKey)}
                onRetry={() => void hydrated.refreshProjection(echoProjectionKey)}
              />
              <TracePanel
                slot={hydrated.projections.slot(traceProjectionKey)}
                onRetry={() => void hydrated.refreshProjection(traceProjectionKey)}
              />
            </div>
          </div>
        </div>
      </section>
      {/* Always rendered; globals.css shows this bar only below 767px, where
          one surface at a time replaces a phone-length stack of panels. */}
      <div className="surface-tabs" role="tablist" aria-label="切換工作區">
        {WORK_SURFACES.map(({ id, label }) => (
          <button
            aria-selected={surface === id}
            key={id}
            onClick={() => setSurface(id)}
            role="tab"
            type="button"
          >{label}</button>
        ))}
      </div>
    </main>
  );
}
