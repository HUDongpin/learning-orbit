"use client";

import type { AuthSession, RoomDetails } from "@learning-orbit/contracts";
import { useRouter } from "next/navigation";
import React, { useEffect, useMemo, useState } from "react";

import {
  FetchSessionGateway,
  SessionGatewayError,
  type SessionGateway,
} from "../../../src/lib/session/session-gateway";
import { isRoomId, roomPagePath } from "../../../src/lib/session/room-route";

type AccessMode = "student" | "teacher";
type AccessState =
  | { kind: "checking" }
  | { kind: "student-ready"; session: Extract<AuthSession, { role: "student" }>; room: RoomDetails }
  | { kind: "teacher-ready"; room: RoomDetails }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

const STATUS_COPY: Readonly<Record<RoomDetails["status"], string>> = {
  scheduled: "尚未開始",
  open: "進行中",
  paused: "已暫停",
  closed: "已結束",
};

export interface RoomAccessClientProps {
  gateway?: SessionGateway;
  mode: AccessMode;
  roomId: string;
}

export function RoomAccessClient({ gateway, mode, roomId }: RoomAccessClientProps) {
  const router = useRouter();
  const api = useMemo(() => gateway ?? new FetchSessionGateway(), [gateway]);
  const validRoomId = isRoomId(roomId);
  const [state, setState] = useState<AccessState>(() => validRoomId ? { kind: "checking" } : { kind: "forbidden" });
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string>();

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!validRoomId) return;
      try {
        const session = await api.getSession();
        if (!active) return;

        if (mode === "teacher" && session.role !== "teacher") {
          setState({ kind: "forbidden" });
          return;
        }
        if (mode === "student" && session.role === "student" && session.roomId !== roomId) {
          setState({ kind: "forbidden" });
          return;
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
          setState({ kind: "teacher-ready", room: details });
          return;
        }
        setState({ kind: "student-ready", session, room: details });
      } catch (error) {
        if (!active) return;
        if (error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED") {
          router.replace(mode === "teacher" ? "/login?role=teacher" : "/login");
          return;
        }
        if (error instanceof SessionGatewayError && error.code === "ROOM_NOT_FOUND") {
          setState({ kind: "forbidden" });
          return;
        }
        setState({ kind: "unavailable" });
      }
    })();
    return () => { active = false; };
  }, [api, mode, roomId, router, validRoomId]);

  async function logout() {
    setLoggingOut(true);
    setLogoutError(undefined);
    try {
      await api.logout();
      setState({ kind: "checking" });
      router.replace(mode === "teacher" ? "/login?role=teacher" : "/login");
    } catch {
      setLogoutError("未能完成登出。伺服器 Session 可能仍然有效，請稍後再試。");
      setLoggingOut(false);
    }
  }

  if (state.kind === "checking") {
    return <main className="room-gate-shell room-gate-centered" aria-busy="true"><p role="status">正在驗證 Session 與房間權限…</p></main>;
  }

  if (state.kind === "forbidden") {
    return (
      <main className="room-gate-shell room-gate-centered">
        <section className="room-gate-card">
          <p className="login-eyebrow">房間不可用</p>
          <h1>無法開啟這個課堂</h1>
          <p>房間可能不存在、已刪除，或不屬於目前的 Session。系統沒有載入模擬房間。</p>
          <a className="teacher-link-button" href="/login">返回安全入口</a>
        </section>
      </main>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <main className="room-gate-shell room-gate-centered">
        <section className="room-gate-card">
          <p className="login-eyebrow">Fail closed</p>
          <h1>課堂服務暫時不可用</h1>
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
  const details = state.room;
  return (
    <main className="room-gate-shell">
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
            <p className="login-eyebrow">{isTeacher ? "教師房間控制台" : state.session.pseudonym}</p>
            <h1>{details.topic}</h1>
            <p>45 分鐘課堂 · {STATUS_COPY[details.status]} · {details.participants.length} 個匿名座位</p>
          </div>
          <span className={`teacher-status status-${details.status}`}>{STATUS_COPY[details.status]}</span>
        </div>
        <div className="room-hydration-notice" role="status">
          <h2>房間權限已確認</h2>
          <p>聊天室、WebSocket 事件與 ECHO／TRACE 投影必須完成伺服器水合後才會顯示；目前沒有使用 Seed Message、固定指標或 Fixture。</p>
        </div>
      </section>
    </main>
  );
}
