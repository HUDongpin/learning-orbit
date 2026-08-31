import { act, cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeletionStatus } from "@learning-orbit/contracts";
import { SessionGatewayError } from "../session/session-gateway.js";
import { DeletionStatusPanel } from "./deletion-status-panel.js";

const JOB_ID = "00000000-0000-4000-8000-000000000010";
const surfaces = [
  "agent_runs", "artifacts", "caches", "derivatives",
  "events", "media", "projections", "provider_copies",
] as const;

describe("deletion status recovery", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("focuses the deletion page title once without stealing focus during polling", async () => {
    vi.useFakeTimers();
    const initial: DeletionStatus = { deletionJobId: JOB_ID, status: "running", nextPollAfterMs: 1000, failureCode: null };
    const completed: DeletionStatus = {
      deletionJobId: JOB_ID,
      status: "completed",
      receipt: { receiptVersion: 1, completedAt: "2026-08-31T01:00:00.000Z", surfacesVerified: [...surfaces] },
    };
    const getDeletionStatus = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(completed);
    render(<><button type="button">保留焦點</button><DeletionStatusPanel initial={initial} gateway={{ getDeletionStatus }} onSessionExpired={vi.fn()} /></>);

    const pageTitle = screen.getByRole("heading", { name: "課堂刪除狀態" });
    expect(pageTitle).toHaveFocus();
    await act(async () => { await Promise.resolve(); });
    const preservedTarget = screen.getByRole("button", { name: "保留焦點" });
    preservedTarget.focus();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.getByRole("heading", { name: "伺服器已完成線上刪除驗證" })).toBeInTheDocument();
    expect(preservedTarget).toHaveFocus();
  });

  it.each([
    [{ deletionJobId: JOB_ID, status: "queued", nextPollAfterMs: null, failureCode: null }, "等待執行", "刪除工作已由伺服器排入佇列。"],
    [{ deletionJobId: JOB_ID, status: "running", nextPollAfterMs: null, failureCode: null }, "正在刪除", "伺服器正在逐一清除並驗證課堂 Surface。"],
    [{ deletionJobId: JOB_ID, status: "retryable", nextPollAfterMs: null, failureCode: "PROVIDER_COPY_PENDING" }, "等待重試", "PROVIDER_COPY_PENDING"],
    [{ deletionJobId: JOB_ID, status: "dead", nextPollAfterMs: null, failureCode: "PROVIDER_DELETE_FAILED" }, "需要處理", "PROVIDER_DELETE_FAILED"],
  ] satisfies Array<[DeletionStatus, string, string]>)("renders the real $status state without a success fallback", async (status, heading, copy) => {
    render(<DeletionStatusPanel initial={status} gateway={{ getDeletionStatus: vi.fn(async () => status) }} onSessionExpired={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByText(copy, { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("伺服器已完成線上刪除驗證")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(JOB_ID);
  });

  it("shows completion only from a generated eight-surface receipt", async () => {
    const status: DeletionStatus = {
      deletionJobId: JOB_ID,
      status: "completed",
      receipt: {
        receiptVersion: 1,
        completedAt: "2026-08-31T01:00:00.000Z",
        surfacesVerified: [...surfaces],
      },
    };
    render(<DeletionStatusPanel initial={status} gateway={{ getDeletionStatus: vi.fn(async () => status) }} onSessionExpired={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "伺服器已完成線上刪除驗證" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByText(/不延伸為未配置外部 Provider/u)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(JOB_ID);
  });

  it("keeps the last verified state and retries a transient polling failure with bounded backoff", async () => {
    vi.useFakeTimers();
    const initial: DeletionStatus = { deletionJobId: JOB_ID, status: "running", nextPollAfterMs: 1000, failureCode: null };
    const completed: DeletionStatus = {
      deletionJobId: JOB_ID,
      status: "completed",
      receipt: { receiptVersion: 1, completedAt: "2026-08-31T01:00:00.000Z", surfacesVerified: [...surfaces] },
    };
    const getDeletionStatus = vi.fn()
      .mockRejectedValueOnce(new Error("TRANSIENT"))
      .mockResolvedValueOnce(completed);
    render(<DeletionStatusPanel initial={initial} gateway={{ getDeletionStatus }} onSessionExpired={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("heading", { name: "正在刪除" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("不會猜測或提前顯示完成");

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(getDeletionStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "伺服器已完成線上刪除驗證" })).toBeInTheDocument();
  });

  it("does not retry AUTH_REQUIRED and aborts an in-flight poll on unmount", async () => {
    vi.useFakeTimers();
    const initial: DeletionStatus = { deletionJobId: JOB_ID, status: "queued", nextPollAfterMs: 1000, failureCode: null };
    const onSessionExpired = vi.fn();
    const authFailure = vi.fn(async () => { throw new SessionGatewayError("AUTH_REQUIRED"); });
    const first = render(<DeletionStatusPanel initial={initial} gateway={{ getDeletionStatus: authFailure }} onSessionExpired={onSessionExpired} />);
    await act(async () => { await Promise.resolve(); });
    expect(onSessionExpired).toHaveBeenCalledOnce();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(authFailure).toHaveBeenCalledOnce();
    first.unmount();

    let signal: AbortSignal | undefined;
    const pending = vi.fn(async (_jobId: string, options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return await new Promise<DeletionStatus>(() => undefined);
    });
    const second = render(<DeletionStatusPanel initial={initial} gateway={{ getDeletionStatus: pending }} onSessionExpired={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(signal?.aborted).toBe(false);
    second.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
