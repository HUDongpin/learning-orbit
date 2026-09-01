/**
 * Plain-language labels for server enum values.
 *
 * The analysis panels used to render raw server tokens — `supported`,
 * `provisional`, `uptake`, `lineage_adjusted` — directly to a 13-year-old.
 * These tables translate them.
 *
 * Two rules keep the translation honest:
 *
 *  1. A value that is not in a table falls through to the raw token. A friendly
 *     guess about an unknown enum would be an overclaim about what the server
 *     said, which is exactly what this product refuses to do.
 *  2. No label may attribute anything to an individual, or imply a ranking, a
 *     score, or an ability. Every label below describes evidence or a group
 *     pattern.
 */

function lookup(table: Readonly<Record<string, string>>, value: string): string {
  return table[value] ?? value;
}

/** ConceptNode / ConceptEdge `displayStatus`. */
const DISPLAY_STATUS: Readonly<Record<string, string>> = {
  confirmed: "已確認",
  provisional: "還在形成",
  disputed: "有不同意見",
  inactive: "暫時擱下",
};

/** ConceptNode / ConceptEdge `evidenceStatus`. */
const EVIDENCE_STATUS: Readonly<Record<string, string>> = {
  supported: "有證據支持",
  challenged: "有同學提出反例",
  uncertain: "證據還不夠",
  disputed: "同學之間有分歧",
  retracted: "相關內容已收回",
  superseded: "已被較新的說法取代",
  requires_replay: "需要重新分析",
};

/**
 * TRACE interaction layer. The enum widens by audience:
 * student bundles carry communication|uptake, human views add stance and
 * coordination, and teacher views add facilitation.
 */
const TRACE_LAYER: Readonly<Record<string, string>> = {
  communication: "對話往來",
  uptake: "接續同學的想法",
  stance: "表明立場",
  coordination: "協調分工",
  facilitation: "引導",
};

/** TRACE node kind, per trace-projection.v1.json: learner | agent | room. */
const TRACE_NODE_KIND: Readonly<Record<string, string>> = {
  learner: "同學",
  agent: "Nova",
  room: "全班",
};

export const displayStatusLabel = (value: string): string => lookup(DISPLAY_STATUS, value);
export const evidenceStatusLabel = (value: string): string => lookup(EVIDENCE_STATUS, value);
export const traceLayerLabel = (value: string): string => lookup(TRACE_LAYER, value);
export const traceNodeKindLabel = (value: string): string => lookup(TRACE_NODE_KIND, value);

/** Badge modifier class for `.state-badge`; unknown values get no modifier. */
export function statusBadgeClass(displayStatus: string): string {
  return displayStatus in DISPLAY_STATUS ? `state-badge ${displayStatus}` : "state-badge";
}

/**
 * What each group metric means, in one sentence a student can read.
 * Group-level only: none of these describes a person.
 */
export const METRIC_EXPLANATION: Readonly<Record<string, string>> = {
  participationBalance: "全班發言分布得有多平均。",
  reciprocity: "同學之間互相回應的比例。",
  agentShare: "這段時間內由 Nova 產生的事件比例。",
  semanticCoverage: "討論覆蓋了多少個不同概念。",
};
