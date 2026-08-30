import React from "react";

const WARNING_COPY: Readonly<Record<string, string>> = {
  client_time_future_clamped: "有事件的裝置時間超前；伺服器已使用接收時間校正分析窗口。",
  insufficient_window: "目前窗口的互動事件不足，群體圖與指標需要審慎解讀。",
  recent_group_interaction_only: "此視圖只描述近期群體互動，不代表長期關係或個人能力。",
  requires_replay: "伺服器已標記此分析需要重新計算；目前內容不可視為最新結論。",
  small_group_interpretation_warning: "四人小組指標只適用於本次課堂的群體描述，不可用作個人排名。",
};

export function AnalysisWarnings({ codes }: Readonly<{ codes: readonly string[] }>) {
  const messages = [...new Set(codes)].map((code) => WARNING_COPY[code])
    .filter((message): message is string => message !== undefined);
  const hiddenCount = new Set(codes.filter((code) => !(code in WARNING_COPY))).size;
  if (messages.length === 0 && hiddenCount === 0) return null;
  return <section className="analysis-warnings" aria-label="分析解讀警告" role="status">
    <h3>解讀邊界</h3>
    <ul>
      {messages.map((message) => <li key={message}>{message}</li>)}
      {hiddenCount > 0 ? <li>伺服器另附 {hiddenCount} 項未公開診斷；此介面不直接顯示未列入安全文案表的內部內容。</li> : null}
    </ul>
  </section>;
}
