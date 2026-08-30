import type { LedgerMessage } from "./event-ledger.js";

export type ConceptNode = { id: string; label: string; x: number; y: number; evidenceIds: string[] };
export type ConceptEdge = {
  id: string;
  from: string;
  to: string;
  phrase: string;
  state: "supported" | "question" | "challenge" | "mixed";
  evidenceIds: string[];
};
export type SocialNode = { id: string; label: string; kind: "student" | "agent" | "room"; x: number; y: number };
export type SocialEdge = {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: "communication" | "uptake" | "facilitation";
  weight: number;
  evidenceIds: string[];
};

const positions: Record<string, [number, number]> = {
  sun: [15, 23], producer: [42, 23], consumer: [70, 23], energy: [15, 72], nutrient: [42, 72], decomposer: [70, 72],
};
const concepts: Record<string, string> = {
  sun: "太陽能", producer: "生產者", consumer: "消費者", energy: "能量流動", nutrient: "養分", decomposer: "分解者",
};

function has(text: string, ...terms: string[]): boolean { return terms.some((term) => text.includes(term)); }

/** Deterministic local projection used by the UI until a worker is connected. */
export function coordinateProjections(messages: readonly LedgerMessage[]): { nodes: ConceptNode[]; edges: ConceptEdge[]; people: SocialNode[]; socialEdges: SocialEdge[] } {
  const active = messages.filter((message) => message.operation !== "retract");
  const evidence = (predicate: (text: string) => boolean): string[] => active.filter((message) => predicate(message.text)).map((message) => message.eventId);
  const edge = (id: string, from: string, to: string, phrase: string, predicate: (text: string) => boolean): ConceptEdge => {
    const evidenceIds = evidence(predicate);
    const challenge = active.some((message) => has(message.text, "不確定", "反例", "不會循環"));
    return { id, from, to, phrase, state: challenge && id === "e3" ? "mixed" : evidenceIds.length ? "supported" : "question", evidenceIds };
  };
  const edges = [
    edge("e1", "sun", "producer", "透過光合作用儲存", (text) => has(text, "太陽", "光合作用", "光能")),
    edge("e2", "producer", "consumer", "作為食物傳遞", (text) => has(text, "食物鏈", "傳給消費者", "生產者")),
    edge("e3", "consumer", "decomposer", "遺體被分解", (text) => has(text, "分解者", "遺體", "分解")),
    edge("e4", "decomposer", "nutrient", "釋放回土壤", (text) => has(text, "養分", "土壤", "循環")),
    edge("e5", "nutrient", "producer", "被根部吸收", (text) => has(text, "根部", "吸收", "養分")),
  ];
  const nodes = Object.entries(concepts).map(([id, label]) => ({ id, label, x: positions[id]![0], y: positions[id]![1], evidenceIds: evidence((text) => text.includes(label)) }));
  const people: SocialNode[] = [
    { id: "student-a", label: "探索者 A", kind: "student", x: 18, y: 52 }, { id: "student-b", label: "探索者 B", kind: "student", x: 43, y: 22 },
    { id: "student-c", label: "探索者 C", kind: "student", x: 67, y: 53 }, { id: "student-d", label: "探索者 D", kind: "student", x: 42, y: 80 },
    { id: "nova", label: "Nova Agent", kind: "agent", x: 80, y: 21 }, { id: "room", label: "聊天室", kind: "room", x: 18, y: 21 },
  ];
  const actorByMessageId = new Map(active.map((message) => [message.messageId, message.actorId]));
  const socialEdges: SocialEdge[] = [];
  for (const message of active) {
    const actor = message.actorId || "student-a";
    if (message.replyTo) {
      // RoomEvent payloads carry the message-root ID.  Resolve it to the
      // server-assigned actor for the visual network while retaining the
      // original root in the message ledger and evidence metadata.
      const target = actorByMessageId.get(message.replyTo) ?? message.replyTo;
      socialEdges.push({ id: `${message.eventId}:reply`, from: actor, to: target, label: "回覆", kind: "communication", weight: 1, evidenceIds: [message.eventId] });
    }
    for (const mention of message.mentions) socialEdges.push({ id: `${message.eventId}:mention:${mention}`, from: actor, to: mention, label: "提及", kind: "communication", weight: 1, evidenceIds: [message.eventId] });
    if (message.actorKind === "agent") socialEdges.push({ id: `${message.eventId}:facilitation`, from: "nova", to: "student-d", label: "促進", kind: "facilitation", weight: 1, evidenceIds: [message.eventId] });
    if (message.actorKind === "human" && has(message.text, "沿食物鏈", "共識", "我同意")) socialEdges.push({ id: `${message.eventId}:uptake`, from: actor, to: "student-b", label: "採用觀點", kind: "uptake", weight: 1, evidenceIds: [message.eventId] });
    if (!message.replyTo && message.mentions.length === 0) socialEdges.push({ id: `${message.eventId}:broadcast`, from: actor, to: "room", label: "廣播超事件", kind: "communication", weight: 1, evidenceIds: [message.eventId] });
  }
  return { nodes, edges, people, socialEdges };
}
