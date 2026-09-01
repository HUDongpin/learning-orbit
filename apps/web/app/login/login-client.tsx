"use client";

import { authContract } from "@learning-orbit/contracts";
import { useRouter } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  FetchSessionGateway,
  SessionGatewayError,
  normalizeClassroomCode,
  type SessionGateway,
} from "../../src/lib/session/session-gateway";
import { assertStudentRoomIdentity } from "../../src/lib/session/room-identity";

type LoginRole = "student" | "teacher";
type SessionCheck = "checking" | "anonymous" | "unavailable";

const CLASSROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_PATTERN = new RegExp(`^[${CLASSROOM_CODE_ALPHABET}]{6}$`, "u");
const SEAT_CODE_PATTERN = new RegExp(`^[${CLASSROOM_CODE_ALPHABET}]{10}$`, "u");
const OUTSIDE_ALPHABET_PATTERN = new RegExp(`[^${CLASSROOM_CODE_ALPHABET}]`, "gu");
const TEACHER_ACCEPTED_COPY = "如果此電郵已獲授權，登入連結將會送出。請檢查收件匣。";
const STUDENT_REJECTED_COPY = "無法加入課堂。請向老師確認代碼後再試。";
const STUDENT_RATE_LIMITED_COPY = "嘗試次數過多，伺服器暫時拒絕加入課堂。請等待幾分鐘後再試；同一個網絡的所有嘗試會一起計算，不一定是代碼有誤。";
const STUDENT_SERVICE_COPY = "課堂服務暫時不可用。請稍後再試。";
const REJECTED_JOIN_CODES = ["INVALID_JOIN_REQUEST", "JOIN_FORBIDDEN", "ROOM_NOT_FOUND"];

/**
 * Codes are drawn from an unambiguous alphabet, so anything a shared keyboard
 * adds — a pasted space, a lowercase letter, the I/O/0/1 look-alikes — can be
 * dropped as the student types instead of being refused after submit. The
 * server-side normaliser stays the single source of case and whitespace rules.
 */
function typedClassroomCode(value: string): string {
  return normalizeClassroomCode(value).replace(OUTSIDE_ALPHABET_PATTERN, "");
}

export interface LoginClientProps {
  gateway?: SessionGateway;
  initialRole: LoginRole;
}

export function LoginClient({ gateway, initialRole }: LoginClientProps) {
  const router = useRouter();
  const api = useMemo(() => gateway ?? new FetchSessionGateway(), [gateway]);
  const [role, setRole] = useState<LoginRole>(initialRole);
  const [sessionCheck, setSessionCheck] = useState<SessionCheck>("checking");
  const [roomCode, setRoomCode] = useState("");
  const [seatCode, setSeatCode] = useState("");
  const [email, setEmail] = useState("");
  const [studentErrors, setStudentErrors] = useState<Readonly<{ room?: string; seat?: string; form?: string }>>({});
  const [teacherError, setTeacherError] = useState<string>();
  const [teacherAccepted, setTeacherAccepted] = useState(false);
  const [studentSubmitting, setStudentSubmitting] = useState(false);
  const [teacherSubmitting, setTeacherSubmitting] = useState(false);
  const roomInput = useRef<HTMLInputElement>(null);
  const seatInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const studentTab = useRef<HTMLButtonElement>(null);
  const teacherTab = useRef<HTMLButtonElement>(null);
  const recoveryHeading = useRef<HTMLHeadingElement>(null);

  const checkSession = useCallback(async () => {
    setSessionCheck("checking");
    try {
      const session = await api.getSession();
      if (session.role === "teacher") {
        router.replace("/teacher");
      } else {
        router.replace(`/session/${session.roomId}`);
      }
    } catch (error) {
      if (error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED") {
        setSessionCheck("anonymous");
        return;
      }
      setSessionCheck("unavailable");
    }
  }, [api, router]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const session = await api.getSession();
        if (!active) return;
        if (session.role === "teacher") {
          router.replace("/teacher");
        } else {
          router.replace(`/session/${session.roomId}`);
        }
      } catch (error) {
        if (!active) return;
        setSessionCheck(error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED" ? "anonymous" : "unavailable");
      }
    })();
    return () => { active = false; };
  }, [api, router]);

  useEffect(() => {
    if (sessionCheck === "unavailable") recoveryHeading.current?.focus();
  }, [sessionCheck]);

  function selectRole(nextRole: LoginRole, focus: "field" | "tab" = "field") {
    setRole(nextRole);
    setStudentErrors({});
    setTeacherError(undefined);
    setTeacherAccepted(false);
    queueMicrotask(() => {
      if (focus === "tab") {
        if (nextRole === "student") studentTab.current?.focus();
        else teacherTab.current?.focus();
      } else if (nextRole === "student") roomInput.current?.focus();
      else emailInput.current?.focus();
    });
  }

  function navigateRoleTabs(event: React.KeyboardEvent<HTMLButtonElement>) {
    let nextRole: LoginRole | undefined;
    if (["ArrowLeft", "ArrowUp"].includes(event.key)) nextRole = role === "student" ? "teacher" : "student";
    if (["ArrowRight", "ArrowDown"].includes(event.key)) nextRole = role === "student" ? "teacher" : "student";
    if (event.key === "Home") nextRole = "student";
    if (event.key === "End") nextRole = "teacher";
    if (!nextRole) return;
    event.preventDefault();
    selectRole(nextRole, "tab");
  }

  async function submitStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedRoomCode = normalizeClassroomCode(roomCode);
    const normalizedSeatCode = normalizeClassroomCode(seatCode);
    const roomError = ROOM_CODE_PATTERN.test(normalizedRoomCode) ? undefined : "房間代碼須為 6 個英文字母或數字。";
    const seatError = SEAT_CODE_PATTERN.test(normalizedSeatCode) ? undefined : "座位代碼須為 10 個英文字母或數字。";
    if (roomError || seatError) {
      setStudentErrors({
        ...(roomError === undefined ? {} : { room: roomError }),
        ...(seatError === undefined ? {} : { seat: seatError }),
      });
      queueMicrotask(() => (roomError ? roomInput.current : seatInput.current)?.focus());
      return;
    }

    setStudentErrors({});
    setStudentSubmitting(true);
    try {
      const session = await api.joinStudent({ roomCode: normalizedRoomCode, seatCode: normalizedSeatCode });
      const room = await api.getRoom(session.roomId);
      assertStudentRoomIdentity(session, room);
      router.replace(`/session/${session.roomId}`);
    } catch (error) {
      // A shared school lab NATs the whole class behind one address, so a
      // failed-join rate limit can lock out a student whose codes are correct.
      // Telling that student to re-check the code would be actively wrong.
      const limited = error instanceof SessionGatewayError && error.code === "RATE_LIMITED";
      const rejected = error instanceof SessionGatewayError && REJECTED_JOIN_CODES.includes(error.code);
      setStudentErrors({
        form: limited ? STUDENT_RATE_LIMITED_COPY : rejected ? STUDENT_REJECTED_COPY : STUDENT_SERVICE_COPY,
      });
      queueMicrotask(() => roomInput.current?.focus());
    } finally {
      setStudentSubmitting(false);
    }
  }

  async function submitTeacher(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTeacherAccepted(false);
    let normalizedEmail: string;
    try {
      normalizedEmail = authContract.parseTeacherMagicLinkRequest({ email }).email;
    } catch {
      setTeacherError("請輸入有效的教師電郵。");
      queueMicrotask(() => emailInput.current?.focus());
      return;
    }

    setTeacherError(undefined);
    setTeacherSubmitting(true);
    try {
      await api.requestTeacherMagicLink({ email: normalizedEmail });
    } catch {
      // The public result deliberately remains identical for every locally valid email.
    } finally {
      setTeacherSubmitting(false);
      setTeacherAccepted(true);
    }
  }

  if (sessionCheck === "checking") {
    return (
      <main className="login-shell login-status-page" aria-busy="true">
        <p role="status">正在確認登入狀態…</p>
      </main>
    );
  }

  if (sessionCheck === "unavailable") {
    return (
      <main className="login-shell login-status-page">
        <div className="login-status-card">
          <span className="login-eyebrow">Learning Orbit</span>
          <h1 ref={recoveryHeading} tabIndex={-1}>暫時無法確認登入狀態</h1>
          <p>我們沒有載入任何模擬課堂。請檢查本地服務後再試。</p>
          <button className="login-primary" type="button" onClick={() => void checkSession()}>重新嘗試</button>
        </div>
      </main>
    );
  }

  return (
    <main className="login-shell">
      <a className="skip-link" href="#login-form">跳至登入表格</a>
      <section className="login-intro" aria-labelledby="orbit-welcome">
        <div className="orbit-mark login-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="4" /><ellipse cx="16" cy="16" rx="13" ry="6" /><ellipse cx="16" cy="16" rx="6" ry="13" /></svg>
        </div>
        <span className="login-eyebrow">Learning Orbit</span>
        <h1 id="orbit-welcome">一起探索生態系統</h1>
        <p>在匿名、受控的課堂空間中提出想法、回應同伴，並觀察全班知識如何形成。</p>
        <ul className="login-principles" aria-label="課堂特點">
          <li><span aria-hidden="true">01</span> 不收集學生姓名、電郵或密碼</li>
          <li><span aria-hidden="true">02</span> 每位學生使用獨有座位代碼</li>
          <li><span aria-hidden="true">03</span> 身份與房間權限由伺服器確認</li>
        </ul>
      </section>

      <section className="login-card" id="login-form" tabIndex={-1} aria-label="登入 Learning Orbit">
        <div className="login-tabs" role="tablist" aria-label="選擇登入角色">
          <button
            aria-controls="student-login-panel"
            aria-selected={role === "student"}
            className="login-tab"
            id="student-login-tab"
            onClick={() => selectRole("student")}
            onKeyDown={navigateRoleTabs}
            ref={studentTab}
            role="tab"
            tabIndex={role === "student" ? 0 : -1}
            type="button"
          >學生加入</button>
          <button
            aria-controls="teacher-login-panel"
            aria-selected={role === "teacher"}
            className="login-tab"
            id="teacher-login-tab"
            onClick={() => selectRole("teacher")}
            onKeyDown={navigateRoleTabs}
            ref={teacherTab}
            role="tab"
            tabIndex={role === "teacher" ? 0 : -1}
            type="button"
          >教師登入</button>
        </div>

        {role === "student" ? (
          <div aria-labelledby="student-login-tab" id="student-login-panel" role="tabpanel">
            <p className="login-kicker">學生入口</p>
            <h2>加入學習軌道</h2>
            <p className="login-help">向老師取得共同房間代碼及你的獨有座位代碼。</p>
            <form noValidate onSubmit={(event) => void submitStudent(event)}>
              <div className="login-field login-code">
                <label htmlFor="room-code">房間代碼</label>
                <input
                  aria-describedby={studentErrors.room ? "room-code-error" : "room-code-hint"}
                  aria-invalid={Boolean(studentErrors.room)}
                  autoCapitalize="characters"
                  autoComplete="off"
                  id="room-code"
                  inputMode="text"
                  maxLength={12}
                  onChange={(event) => setRoomCode(typedClassroomCode(event.target.value))}
                  placeholder="例如 ABC234"
                  ref={roomInput}
                  spellCheck={false}
                  value={roomCode}
                />
                <span className="login-hint" id="room-code-hint">6 個英文字母或數字，全班相同。代碼不會用到 I、O、0、1。</span>
                {studentErrors.room ? <span className="login-error" id="room-code-error">{studentErrors.room}</span> : null}
              </div>
              <div className="login-field login-code">
                <label htmlFor="seat-code">座位代碼</label>
                <input
                  aria-describedby={studentErrors.seat ? "seat-code-error" : "seat-code-hint"}
                  aria-invalid={Boolean(studentErrors.seat)}
                  autoCapitalize="characters"
                  autoComplete="off"
                  id="seat-code"
                  inputMode="text"
                  maxLength={18}
                  onChange={(event) => setSeatCode(typedClassroomCode(event.target.value))}
                  placeholder="例如 DEF2345678"
                  ref={seatInput}
                  spellCheck={false}
                  value={seatCode}
                />
                <span className="login-hint" id="seat-code-hint">10 個英文字母或數字，每人不同。小階字母與空格會自動轉換。</span>
                {studentErrors.seat ? <span className="login-error" id="seat-code-error">{studentErrors.seat}</span> : null}
              </div>
              {studentErrors.form ? <p className="login-alert" role="alert">{studentErrors.form}</p> : null}
              <button className="login-primary" disabled={studentSubmitting} type="submit">
                {studentSubmitting ? "正在加入…" : "加入課堂"}
              </button>
            </form>
          </div>
        ) : (
          <div aria-labelledby="teacher-login-tab" id="teacher-login-panel" role="tabpanel">
            <p className="login-kicker">教師入口</p>
            <h2>教師登入</h2>
            <p className="login-help">我們只會向已預置的教師電郵傳送一次性登入連結。</p>
            <form noValidate onSubmit={(event) => void submitTeacher(event)}>
              <div className="login-field">
                <label htmlFor="teacher-email">教師電郵</label>
                <input
                  aria-describedby={teacherError ? "teacher-email-error" : "teacher-email-hint"}
                  aria-invalid={Boolean(teacherError)}
                  autoComplete="email"
                  id="teacher-email"
                  inputMode="email"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="teacher@example.edu"
                  ref={emailInput}
                  type="email"
                  value={email}
                />
                <span className="login-hint" id="teacher-email-hint">登入連結只能使用一次，並會在短時間後失效。</span>
                {teacherError ? <span className="login-error" id="teacher-email-error">{teacherError}</span> : null}
              </div>
              {teacherAccepted ? <p className="login-success" role="status">{TEACHER_ACCEPTED_COPY}</p> : null}
              <button className="login-primary" disabled={teacherSubmitting} type="submit">
                {teacherSubmitting ? "正在傳送…" : "傳送登入連結"}
              </button>
            </form>
          </div>
        )}
        <p className="login-privacy">代碼、Session Cookie 與身份資料不會儲存在瀏覽器 Local Storage。</p>
      </section>
    </main>
  );
}
