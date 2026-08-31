"use client";

import type {
  DeleteRoomAccepted,
  DeletionStatus,
} from "@learning-orbit/contracts";
import React, { useEffect, useRef, useState } from "react";

import {
  SessionGatewayError,
  type SessionGateway,
} from "../session/session-gateway";

type InitialDeletion = DeleteRoomAccepted | DeletionStatus;
type Gateway = Pick<SessionGateway, "getDeletionStatus">;
type RoomRecoveryGateway = Pick<SessionGateway, "getDeletionStatus" | "getRoomDeletion">;

const STATUS_COPY: Readonly<Record<Exclude<DeletionStatus["status"], "completed">, string>> = {
  queued: "刪除工作已由伺服器排入佇列。",
  running: "伺服器正在逐一清除並驗證課堂 Surface。",
  retryable: "部分 Surface 暫時失敗；伺服器將按真實 Job 狀態重試。",
  dead: "刪除工作已停止，需要管理員處理；系統不會顯示為完成。",
};

export function DeletionStatusPanel({
  initial,
  gateway,
  onSessionExpired,
}: Readonly<{
  initial: InitialDeletion;
  gateway: Gateway;
  onSessionExpired(): void;
}>) {
  const [status, setStatus] = useState<DeletionStatus | undefined>("receipt" in initial || "nextPollAfterMs" in initial ? initial : undefined);
  const [error, setError] = useState<string>();
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let transientFailures = 0;
    const controller = new AbortController();
    const jobId = initial.deletionJobId;
    const poll = async (): Promise<void> => {
      try {
        const next = await gateway.getDeletionStatus(jobId, { signal: controller.signal });
        if (!active) return;
        transientFailures = 0;
        setStatus(next);
        setError(undefined);
        if (next.status !== "completed" && next.status !== "dead" && next.nextPollAfterMs !== null) {
          timer = setTimeout(() => { void poll(); }, next.nextPollAfterMs);
        }
      } catch (caught) {
        if (!active || controller.signal.aborted) return;
        if (caught instanceof SessionGatewayError && caught.code === "AUTH_REQUIRED") {
          onSessionExpired();
          return;
        }
        setError("目前無法驗證刪除 Job；系統不會猜測或提前顯示完成。");
        transientFailures += 1;
        const retryAfterMs = Math.min(10_000, 1000 * (2 ** Math.min(transientFailures - 1, 4)));
        timer = setTimeout(() => { void poll(); }, retryAfterMs);
      }
    };
    void poll();
    return () => {
      active = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [gateway, initial.deletionJobId, onSessionExpired]);

  return (
    <main className="room-gate-shell room-gate-centered">
      <section className="room-gate-card deletion-status-card" aria-labelledby="deletion-title">
        <p className="login-eyebrow">Deletion Job</p>
        <h1 ref={titleRef} id="deletion-title" tabIndex={-1}>課堂刪除狀態</h1>
        {!status ? <p role="status" aria-live="polite">正在向伺服器恢復刪除狀態…</p> : status.status === "completed" ? (
          <div className="deletion-receipt" role="status" aria-live="polite">
            <h2>伺服器已完成線上刪除驗證</h2>
            <p>完成時間：{new Date(status.receipt.completedAt).toLocaleString("zh-Hant")}</p>
            <p>Receipt 已驗證全部八個 Surface：</p>
            <ul>{status.receipt.surfacesVerified.map((surface) => <li key={surface}>{surface}</li>)}</ul>
            <p>這只證明本地資料庫／已配置 Surface 的 Receipt；不延伸為未配置外部 Provider 的完成聲明。</p>
            <a className="teacher-link-button" href="/teacher">返回教師工作台</a>
          </div>
        ) : (
          <div role={status.status === "dead" ? "alert" : "status"} aria-live={status.status === "dead" ? "assertive" : "polite"}>
            <h2>{status.status === "queued" ? "等待執行" : status.status === "running" ? "正在刪除" : status.status === "retryable" ? "等待重試" : "需要處理"}</h2>
            <p>{STATUS_COPY[status.status]}</p>
            {status.failureCode ? <p>伺服器失敗代碼：{status.failureCode}</p> : null}
          </div>
        )}
        {error ? <p className="teacher-alert" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}

export function RoomDeletionRecoveryPanel({
  roomId,
  gateway,
  onSessionExpired,
}: Readonly<{
  roomId: string;
  gateway: RoomRecoveryGateway;
  onSessionExpired(): void;
}>) {
  const [initial, setInitial] = useState<DeletionStatus | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const recoveryTitleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => { recoveryTitleRef.current?.focus(); }, []);

  useEffect(() => {
    let active = true;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const recover = async (): Promise<void> => {
      try {
        const status = await gateway.getRoomDeletion(roomId, { signal: controller.signal });
        if (active) setInitial(status);
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        if (error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED") {
          onSessionExpired();
          return;
        }
        failures += 1;
        setAttempt(failures);
        const retryAfterMs = Math.min(10_000, 1000 * (2 ** Math.min(failures - 1, 4)));
        timer = setTimeout(() => { void recover(); }, retryAfterMs);
      }
    };
    void recover();
    return () => {
      active = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [gateway, onSessionExpired, roomId]);

  if (initial) {
    return <DeletionStatusPanel initial={initial} gateway={gateway} onSessionExpired={onSessionExpired} />;
  }
  return (
    <main className="room-gate-shell room-gate-centered">
      <section className="room-gate-card" aria-labelledby="deletion-recovery-title">
        <p className="login-eyebrow">Deletion recovery</p>
        <h1 ref={recoveryTitleRef} id="deletion-recovery-title" tabIndex={-1}>正在確認刪除要求</h1>
        <p role="status" aria-live="polite">伺服器可能已提交刪除 Job，但原始回應未到達瀏覽器。系統已停止課堂操作，並正在以有界退避恢復真實狀態。</p>
        {attempt ? <p className="teacher-alert" role="alert">第 {attempt} 次恢復尚未取得 Job；不會重新開放課堂或推斷刪除失敗。</p> : null}
      </section>
    </main>
  );
}
