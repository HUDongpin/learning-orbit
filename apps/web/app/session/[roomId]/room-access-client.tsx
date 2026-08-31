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
const DEFAULT_AGENT_STATUS_TIMEOUT_MS = 1_500;

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
  }, [agentStatusTimeoutMs, api, authority, mode, roomId, router, validRoomId]);

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
          <a className="teacher-link-button" href="/login">返回安全入口</a>
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
          <button className="teacher-link-button" disabled={loggingOut} onClick={() => void logout()} type="button">
            {loggingOut ? "正在清除 Session…" : "清除 Session 並返回登入"}
          </button>
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
          <button className="teacher-link-button" disabled={loggingOut} onClick={() => void logout()} type="button">
            {loggingOut ? "正在清除 Session…" : "清除 Session 並返回登入"}
          </button>
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
          <button className="teacher-link-button" disabled={loggingOut} onClick={() => void logout()} type="button">
            {loggingOut ? "正在清除 Session…" : "清除 Session 並返回登入"}
          </button>
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
  return (
    <main className="room-gate-shell">
      <a className="skip-link" href="#classroom-workspace">跳到共學工作區</a>
      <header className="room-gate-header">
        <div className="orbit-brand">
          <div className="orbit-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="4" /><ellipse cx="16" cy="16" rx="13" ry="6" /><ellipse cx="16" cy="16" rx="6" ry="13" /></svg></div>
          <div><p className="teacher-brand-name">Learning Orbit</p><p className="orbit-subtitle">伺服器已確認房間</p></div>
        </div>
        <div className="room-gate-actions">
          {isTeacher ? <a className="teacher-link-button" href="/teacher">返回教師工作台</a> : null}
          <button className="teacher-secondary" disabled={loggingOut} onClick={() => void logout()} type="button">
            {loggingOut ? "正在登出…" : "登出"}
          </button>
        </div>
      </header>
      <section className="room-gate-main">
        {logoutError ? <p className="teacher-alert" role="alert">{logoutError}</p> : null}
        <div className="room-gate-heading">
          <div>
            <p className="login-eyebrow">{isTeacher ? "教師房間控制台" : hydrated.session.role === "student" ? hydrated.session.pseudonym : ""}</p>
            <h1>{details.topic}</h1>
            <p>45 分鐘課堂 · {STATUS_COPY[liveState.status]} · {details.participants.length} 個匿名座位</p>
          </div>
          <span className={`teacher-status status-${liveState.status}`}>{STATUS_COPY[liveState.status]}</span>
        </div>
        <div className="room-hydration-notice" role="status">
          <h2>房間權限已確認</h2>
          <p>已按伺服器 roomSeq 同步 {hydrated.ledger.events().length} 個 RoomEvent；{liveState.status === "closed"
            ? liveState.connected ? "課堂已結束；WebSocket 僅保留權限變更通知" : "課堂已結束，不再建立即時連線"
            : liveState.connected ? "WebSocket 已連線" : "WebSocket 正在連線或恢復"}。分析區只呈現目前角色獲准的伺服器 Projection。</p>
        </div>
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
        <div className="orbit-grid room-workspace" id="classroom-workspace" tabIndex={-1}>
          <ChatPanel runtime={hydrated} mediaGateway={api} allowedUploadOrigins={MEDIA_UPLOAD_ORIGINS} />
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
      </section>
    </main>
  );
}
