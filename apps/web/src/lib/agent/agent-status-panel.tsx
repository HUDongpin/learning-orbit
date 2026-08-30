import type { AgentStatusFrame } from "@learning-orbit/contracts";
import React from "react";

export interface AgentStatusPanelProps {
  frame?: AgentStatusFrame | null;
  serviceUnavailable?: boolean;
  pending?: boolean;
}

type PublicAgentStatus = Readonly<{
  copy: string;
  busy: boolean;
  urgent: boolean;
}>;

const NO_SERVER_STATUS: PublicAgentStatus = {
  copy: "尚未收到伺服器狀態；目前不會假設 Nova 正在工作或已生成回覆。",
  busy: false,
  urgent: false,
};

function publicAgentStatus(frame: AgentStatusFrame | null | undefined, serviceUnavailable: boolean, pending: boolean): PublicAgentStatus {
  if (pending) {
    return {
      copy: "正在向伺服器確認 Nova 狀態；完成前不會推斷是否會生成回覆。文字聊天仍可使用。",
      busy: true,
      urgent: false,
    };
  }
  if (serviceUnavailable) {
    return {
      copy: "Agent 狀態目前無法確認；系統不會假設 Nova 正在工作、已停止或已生成回覆。文字聊天仍可使用。",
      busy: false,
      urgent: true,
    };
  }
  if (!frame) return NO_SERVER_STATUS;
  if (frame.serviceHealth === "unavailable") {
    return {
      copy: "目前沒有可用的真實 Agent Executor；Nova 不會生成回覆，文字聊天仍可使用。",
      busy: false,
      urgent: true,
    };
  }
  if (!frame.agentEnabled) {
    return {
      copy: "Nova 已由教師停用；不會生成回覆，文字聊天仍可使用。",
      busy: false,
      urgent: false,
    };
  }
  if (frame.state === "failed") {
    return {
      copy: "Nova 回應失敗；沒有生成回覆，文字聊天仍可使用。",
      busy: false,
      urgent: true,
    };
  }
  if (frame.serviceHealth === "degraded") {
    return {
      copy: "Agent 服務目前降級；Nova 回應暫緩，不會生成回覆。文字聊天仍可使用。",
      busy: false,
      urgent: false,
    };
  }

  switch (frame.state) {
    case "idle":
      return {
        copy: "Nova 已啟用並待命；目前沒有進行中的回覆。",
        busy: false,
        urgent: false,
      };
    case "queued":
      return {
        copy: "Nova 回應要求已由伺服器排入佇列；尚未生成回覆。",
        busy: true,
        urgent: false,
      };
    case "running":
      return {
        copy: "Nova 正在由伺服器執行；尚未生成可顯示的最終回覆。",
        busy: true,
        urgent: false,
      };
    case "streaming":
      return {
        copy: "Nova 正在處理回覆；請等待伺服器確認的最終聊天室訊息。",
        busy: true,
        urgent: false,
      };
    case "blocked_by_policy":
      return {
        copy: "Nova 回應因課堂政策暫緩；同學仍可繼續討論，現在不會生成回覆。",
        busy: false,
        urgent: false,
      };
    case "cancelled":
      return {
        copy: "Nova 回應已取消；沒有生成回覆。",
        busy: false,
        urgent: false,
      };
    case "completed":
      return {
        copy: "Nova 執行已完成；只有伺服器確認並出現在聊天室的訊息才是最終回覆。",
        busy: false,
        urgent: false,
      };
  }
}

export function AgentStatusPanel({ frame, serviceUnavailable = false, pending = false }: Readonly<AgentStatusPanelProps>) {
  const status = publicAgentStatus(frame, serviceUnavailable, pending);
  return (
    <section
      className="media-card agent-status-card"
      aria-label="Nova Agent 狀態"
      aria-busy={status.busy}
      data-async-slot="agent-status"
    >
      <h3>Nova Agent</h3>
      <p
        className={status.urgent ? "composer-error" : "media-caption"}
        role={status.urgent ? "alert" : "status"}
        aria-live={status.urgent ? "assertive" : "polite"}
        aria-atomic="true"
      >
        {status.copy}
      </p>
    </section>
  );
}
