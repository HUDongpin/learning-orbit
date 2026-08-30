"use client";

import React from "react";
import type { ProjectionSlot } from "../session/projection-sync";

export function ProjectionPanelState({
  children,
  onRetry,
  panelName,
  retryLabel,
  slot,
}: Readonly<{
  children: React.ReactNode;
  onRetry: () => void;
  panelName: string;
  retryLabel: string;
  slot: ProjectionSlot;
}>) {
  if (slot.snapshot) {
    return <>
      {slot.availability === "failed" ? (
        <div className="analysis-state analysis-state-warning" role="alert">
          <p>{panelName} 暫時無法更新；畫面保留最後一個已驗證版本。錯誤代碼：{slot.errorCode ?? "PROJECTION_SYNC_FAILED"}</p>
          <button type="button" onClick={onRetry}>{retryLabel}</button>
        </div>
      ) : slot.availability === "loading" ? (
        <p className="analysis-refreshing" aria-live="polite">正在核對較新的 {panelName} 版本…</p>
      ) : null}
      {children}
    </>;
  }
  if (slot.availability === "not_available_by_policy") {
    return <div className="analysis-state" role="status">
      <p><code>not_available_by_policy</code>：本次課堂尚未向目前角色開放此分析視圖。</p>
      <button type="button" onClick={onRetry}>{retryLabel}</button>
    </div>;
  }
  if (slot.availability === "failed") {
    return <div className="analysis-state analysis-state-error" role="alert">
      <p>{panelName} 回應未通過驗證。錯誤代碼：{slot.errorCode ?? "PROJECTION_SYNC_FAILED"}</p>
      <button type="button" onClick={onRetry}>{retryLabel}</button>
    </div>;
  }
  if (slot.availability === "not_ready") {
    return <div className="analysis-state" role="status">
      <p>伺服器尚未產生可顯示的 {panelName} Projection；聊天室仍可繼續使用。</p>
      <button type="button" onClick={onRetry}>{retryLabel}</button>
    </div>;
  }
  return <div className="analysis-state" role="status" aria-busy="true">
    正在從伺服器核對 {panelName} Projection…
  </div>;
}
