import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentStatusFrame } from "@learning-orbit/contracts";
import { AgentStatusPanel } from "./agent-status-panel.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const RUN_ID = "00000000-0000-4000-8000-000000000801";

function agentFrame(overrides: Partial<AgentStatusFrame> = {}): AgentStatusFrame {
  const state = overrides.state ?? "idle";
  return {
    type: "agent_status",
    roomId: ROOM_ID,
    agentRunId: state === "idle" ? null : RUN_ID,
    state,
    serviceHealth: "healthy",
    agentEnabled: true,
    updatedAt: "2026-08-31T05:20:00.000Z",
    failureCode: null,
    ...overrides,
  };
}

describe("server-confirmed Nova status", () => {
  afterEach(cleanup);

  it("states honestly when no generated server frame has arrived", () => {
    render(<AgentStatusPanel />);

    expect(screen.getByRole("status")).toHaveTextContent("尚未收到伺服器狀態");
    expect(screen.getByLabelText("Nova Agent 狀態")).toHaveAttribute("aria-busy", "false");
  });

  it("fails closed when the Agent status endpoint itself is unavailable", () => {
    render(<AgentStatusPanel frame={agentFrame({ state: "running", serviceHealth: "healthy" })} serviceUnavailable />);
    expect(screen.getByRole("alert")).toHaveTextContent("Agent 狀態目前無法確認");
    expect(screen.getByRole("alert")).toHaveTextContent("不會假設 Nova 正在工作、已停止或已生成回覆");
  });

  it("marks only the Agent slot busy while server reconciliation is pending", () => {
    render(<AgentStatusPanel frame={agentFrame({ state: "running" })} pending />);
    expect(screen.getByRole("status")).toHaveTextContent("正在向伺服器確認 Nova 狀態");
    expect(screen.getByLabelText("Nova Agent 狀態")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(/正在由伺服器執行/u)).not.toBeInTheDocument();
  });

  it.each([
    ["idle", "Nova 已啟用並待命；目前沒有進行中的回覆"],
    ["queued", "Nova 回應要求已由伺服器排入佇列；尚未生成回覆"],
    ["running", "Nova 正在由伺服器執行；尚未生成可顯示的最終回覆"],
    ["streaming", "Nova 正在處理回覆；請等待伺服器確認的最終聊天室訊息"],
    ["blocked_by_policy", "Nova 回應因課堂政策暫緩；同學仍可繼續討論"],
    ["cancelled", "Nova 回應已取消；沒有生成回覆"],
    ["completed", "Nova 執行已完成；只有伺服器確認並出現在聊天室的訊息才是最終回覆"],
  ] as const)("renders generated %s as a safe public status", (state, copy) => {
    render(<AgentStatusPanel frame={agentFrame({ state })} />);

    expect(screen.getByRole("status")).toHaveTextContent(copy);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders a generated failure as an alert without exposing its code", () => {
    render(<AgentStatusPanel frame={agentFrame({ state: "failed", failureCode: "PROVIDER_TOKEN_SECRET" })} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Nova 回應失敗；沒有生成回覆，文字聊天仍可使用");
    expect(document.body).not.toHaveTextContent("PROVIDER_TOKEN_SECRET");
  });

  it("explains that unavailable means there is no real Agent Executor and no reply", () => {
    render(<AgentStatusPanel frame={agentFrame({ state: "running", serviceHealth: "unavailable" })} />);

    expect(screen.getByRole("alert")).toHaveTextContent("目前沒有可用的真實 Agent Executor");
    expect(screen.getByRole("alert")).toHaveTextContent("Nova 不會生成回覆");
  });

  it("holds the response when service health is degraded", () => {
    render(<AgentStatusPanel frame={agentFrame({ state: "running", serviceHealth: "degraded" })} />);

    expect(screen.getByRole("status")).toHaveTextContent("Agent 服務目前降級；Nova 回應暫緩，不會生成回覆");
    expect(screen.getByLabelText("Nova Agent 狀態")).toHaveAttribute("aria-busy", "false");
  });

  it("shows the server-disabled state before any run state", () => {
    render(<AgentStatusPanel frame={agentFrame({ agentEnabled: false, state: "queued" })} />);

    expect(screen.getByRole("status")).toHaveTextContent("Nova 已由教師停用；不會生成回覆");
    expect(screen.getByLabelText("Nova Agent 狀態")).toHaveAttribute("aria-busy", "false");
  });

  it("never renders identifiers, tokens, candidate text, failure details, or a synthetic Nova reply", () => {
    const unsafeInput = Object.assign(agentFrame({
      state: "streaming",
      failureCode: "TOKEN_SHOULD_NOT_RENDER",
    }), {
      actorId: "00000000-0000-4000-8000-000000000802",
      token: "secret-session-token",
      candidateText: "未確認的候選文字",
      syntheticReply: "這不是伺服器訊息",
    });
    render(<AgentStatusPanel frame={unsafeInput} />);

    const output = screen.getByLabelText("Nova Agent 狀態").outerHTML;
    expect(output).not.toContain(ROOM_ID);
    expect(output).not.toContain(RUN_ID);
    expect(output).not.toContain("00000000-0000-4000-8000-000000000802");
    expect(output).not.toContain("TOKEN_SHOULD_NOT_RENDER");
    expect(output).not.toContain("secret-session-token");
    expect(output).not.toContain("未確認的候選文字");
    expect(output).not.toContain("這不是伺服器訊息");
  });
});
