"use client";

import { useMemo, useRef, useState } from "react";

type Message = { id: string; name: string; initials: string; text: string; agent?: boolean; self?: boolean; reply?: string; media?: string; time: string };
type Concept = { id: string; label: string; x: number; y: number };
type Edge = { id: string; from: string; to: string; phrase: string; state: "supported" | "question" | "challenge" };
type Person = { id: string; label: string; x: number; y: number; kind?: "agent" | "room" };
type SocialEdge = { from: string; to: string; label: string; kind: "communication" | "uptake" | "facilitation" };

const initialMessages: Message[] = [
  { id: "m1", name: "探索者 A", initials: "A", text: "我覺得太陽是生態系統的主要能量來源。", time: "09:04" },
  { id: "m2", name: "探索者 B", initials: "B", text: "生產者把光能儲存在有機物裡，再傳給消費者。", reply: "探索者 A：太陽是能量來源", time: "09:06" },
  { id: "m3", name: "Nova Agent", initials: "N", agent: true, text: "你們的說法都有證據嗎？能否指出能量流動與物質循環的差異？", time: "09:07" },
  { id: "m4", name: "探索者 C", initials: "C", text: "我上傳了池塘觀察草圖，分解者似乎把養分送回土壤。", media: "圖片卡片 · 池塘觀察草圖", time: "09:09" },
  { id: "m5", name: "探索者 D", initials: "D", text: "我不確定能量會不會循環，想找一個反例。", time: "09:11" },
  { id: "m6", name: "Nova Agent", initials: "N", agent: true, text: "目前共識：能量沿食物鏈單向流動；物質則在生產者、消費者與分解者間循環。還有哪一條需要驗證？", time: "09:13" },
];

const concepts: Concept[] = [
  { id: "sun", label: "太陽能", x: 16, y: 25 },
  { id: "producer", label: "生產者", x: 41, y: 25 },
  { id: "consumer", label: "消費者", x: 68, y: 25 },
  { id: "decomposer", label: "分解者", x: 68, y: 70 },
  { id: "nutrient", label: "養分", x: 41, y: 70 },
  { id: "energy", label: "能量流動", x: 16, y: 70 },
];
const edges: Edge[] = [
  { id: "e1", from: "sun", to: "producer", phrase: "透過光合作用儲存", state: "supported" },
  { id: "e2", from: "producer", to: "consumer", phrase: "作為食物傳遞", state: "supported" },
  { id: "e3", from: "consumer", to: "decomposer", phrase: "遺體被分解", state: "question" },
  { id: "e4", from: "decomposer", to: "nutrient", phrase: "釋放回土壤", state: "supported" },
  { id: "e5", from: "nutrient", to: "producer", phrase: "被根部吸收", state: "challenge" },
];
const people: Person[] = [
  { id: "a", label: "探索者 A", x: 19, y: 53 },
  { id: "b", label: "探索者 B", x: 42, y: 24 },
  { id: "c", label: "探索者 C", x: 67, y: 53 },
  { id: "d", label: "探索者 D", x: 43, y: 78 },
  { id: "nova", label: "Nova", x: 79, y: 21, kind: "agent" },
  { id: "room", label: "聊天室", x: 19, y: 21, kind: "room" },
];
const socialEdges: SocialEdge[] = [
  { from: "a", to: "b", label: "回覆", kind: "communication" },
  { from: "b", to: "a", label: "延展", kind: "uptake" },
  { from: "nova", to: "d", label: "促進", kind: "facilitation" },
  { from: "c", to: "room", label: "廣播超事件", kind: "communication" },
];

function Icon({ name }: { name: "image" | "mic" | "send" }) {
  if (name === "image") return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="8.5" cy="9" r="1.5" /><path d="m4 17 5-5 3 3 2-2 6 5" /></svg>;
  if (name === "mic") return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></svg>;
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m4 12 16-8-5 16-3-6-8-2Z" /><path d="m12 14 4-4" /></svg>;
}

export default function RoomClient({ roomId }: { roomId: string }) {
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [selectedConcept, setSelectedConcept] = useState("producer");
  const [selectedEdge, setSelectedEdge] = useState("e1");
  const [snaView, setSnaView] = useState<"observed" | "human_only" | "lineage_adjusted">("observed");
  const [windowMinutes, setWindowMinutes] = useState("30");
  const [paused, setPaused] = useState(false);
  const [liveNote, setLiveNote] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const selected = concepts.find((node) => node.id === selectedConcept) ?? concepts[0]!;
  const statement = edges.find((edge) => edge.id === selectedEdge) ?? edges[0]!;
  const visibleSocialEdges = useMemo(() => snaView === "human_only" ? socialEdges.filter((edge) => edge.from !== "nova" && edge.to !== "nova" && edge.to !== "room") : socialEdges, [snaView]);

  function submit(text = draft) {
    const clean = text.trim();
    if (!clean) return;
    const id = `local-${Date.now()}`;
    const next: Message = {
      id,
      name: "探索者 A",
      initials: "A",
      self: true,
      text: clean,
      time: "現在",
      ...(replyTo ? { reply: replyTo.text } : {}),
    };
    setMessages((current) => [...current, next]);
    setDraft("");
    setReplyTo(null);
    setLiveNote("已加入聊天室；演示規則會在符合提示詞時更新分析圖。");
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
  }

  return (
    <main className="orbit-shell">
      <header className="orbit-header">
        <div className="orbit-brand">
          <div className="orbit-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="6" /><ellipse cx="16" cy="16" rx="14" ry="5" transform="rotate(-25 16 16)" /><circle cx="26" cy="10" r="1.8" fill="white" stroke="none" /></svg></div>
          <div><h1 className="orbit-title">Learning Orbit <span aria-hidden="true">·</span> 共學星球</h1><p className="orbit-subtitle">生態系統探究 · 4 位探索者 + Nova Agent</p></div>
        </div>
        <div className="orbit-status"><span className="orbit-status-dot" />本地演示 · 模擬即時 · 房間 {roomId.slice(0, 8)}</div>
      </header>

      <div className="orbit-grid">
        <section className="orbit-panel chat-panel" aria-labelledby="chat-title">
          <div className="panel-head"><div><div className="panel-kicker">Collaborative studio</div><h2 className="panel-title" id="chat-title">生態系統探究聊天室</h2><div className="panel-meta">45 分鐘任務 · 目前進度 17 分鐘</div></div><div><div className="panel-meta">探索者 4/4</div><div className="progress-track" aria-label="任務進度 38%"><div className="progress-fill" /></div></div></div>
          <div className="messages" aria-label="聊天室訊息">
            {messages.map((message) => <article className={`message${message.self ? " self" : ""}${message.agent ? " agent" : ""}`} key={message.id}>
              <div className={`avatar${message.agent ? " agent" : ""}`} aria-hidden="true"><span>{message.initials}</span></div>
              <div className="bubble-wrap"><div className="message-name">{message.name}</div><div className="bubble">{message.reply && <div className="reply-strip">回覆：{message.reply}</div>}{message.text}{message.media && <div className="media-card"><Icon name="image" /> {message.media}</div>}<span className="message-time">{message.time}</span></div><button className="sr-only" onClick={() => setReplyTo(message)}>回覆 {message.name}</button></div>
            </article>)}
          </div>
          <div className="chips" aria-label="探究提示"><button className="chip" onClick={() => submit("太陽提供能量給生產者")}>太陽 → 生產者</button><button className="chip" onClick={() => submit("能量沿食物鏈傳遞")}>能量沿食物鏈</button><button className="chip" onClick={() => submit("分解者把養分送回土壤")}>養分回到土壤</button></div>
          <div className="composer"><label className="sr-only" htmlFor="message-input">輸入訊息</label>{replyTo && <div className="reply-strip">回覆 {replyTo.name}：{replyTo.text.slice(0, 50)} <button className="icon-button" aria-label="取消回覆" onClick={() => setReplyTo(null)}>×</button></div>}<div className="composer-row"><button className="icon-button" aria-label="選擇圖片" title="選擇圖片（本地演示）"><Icon name="image" /></button><button className="icon-button" aria-label="錄製語音" title="錄製語音（本地演示）"><Icon name="mic" /></button><textarea id="message-input" ref={inputRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} placeholder="分享觀察、證據或一個問題…" rows={1} /><button className="send-button" aria-label="發送訊息" onClick={() => submit()} disabled={!draft.trim()}><Icon name="send" /></button></div><p className="composer-help">Enter 發送 · Shift+Enter 換行 · 可輸入 @Nova 提及促進者</p><p className="composer-error" aria-live="polite">{liveNote}</p></div>
        </section>

        <div className="analysis-column">
          <section className="orbit-panel analysis-panel" aria-labelledby="concept-title">
            <div className="panel-head"><div><div className="panel-kicker">Evidence-coupled map</div><h2 className="panel-title" id="concept-title">即時概念圖</h2><div className="panel-meta">焦點問題：能量如何流動，而物質如何循環？</div></div><div className="toolbar"><button aria-pressed={!paused} onClick={() => setPaused((value) => !value)}>{paused ? "繼續更新" : "暫停更新"}</button><button onClick={() => { setSelectedConcept("producer"); setSelectedEdge("e1"); }}>重新播放</button></div></div>
            <div className="analysis-body"><div className="graph-wrap"><svg viewBox="0 0 100 100" role="group" aria-label="概念命題圖">
              <defs><marker id="arrow-concept" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#7aab87" /></marker></defs>
              {edges.map((edge) => { const from = concepts.find((node) => node.id === edge.from)!; const to = concepts.find((node) => node.id === edge.to)!; return <g key={edge.id} onClick={() => setSelectedEdge(edge.id)} tabIndex={0} role="button" aria-label={`${from.label} — ${edge.phrase} — ${to.label}`} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedEdge(edge.id); }}><line className={`graph-edge ${edge.state === "challenge" ? "challenge" : edge.state === "question" ? "uncertain" : ""}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd="url(#arrow-concept)" /><text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 2} textAnchor="middle" className="graph-label">{edge.state === "supported" ? "✓" : edge.state === "question" ? "?" : "±"}</text></g>; })}
              {concepts.map((node) => <g key={node.id} onClick={() => setSelectedConcept(node.id)} tabIndex={0} role="button" aria-label={`概念：${node.label}`} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedConcept(node.id); }}><circle className={`graph-node ${selectedConcept === node.id ? "active" : ""}`} cx={node.x} cy={node.y} r="8" /><text className="graph-label" x={node.x} y={node.y + .8} textAnchor="middle">{node.label}</text></g>)}
            </svg></div><aside className="graph-inspector" aria-live="polite"><h3 className="inspector-title">選取詳情</h3><ul className="inspector-list"><li><strong>概念</strong><br />{selected.label}</li><li><strong>命題</strong><br />{statement.phrase}</li><li><strong>來源</strong><br />訊息 m2 · m4</li><li><strong>證據數</strong><br />3 · <span className={`state-badge ${statement.state}`}>{statement.state === "supported" ? "已確認" : statement.state === "question" ? "待確認" : "支持／質疑"}</span></li></ul></aside><ul className="statement-list" aria-label="概念命題列表">{edges.map((edge) => { const from = concepts.find((node) => node.id === edge.from)!; const to = concepts.find((node) => node.id === edge.to)!; return <li key={edge.id}><button onClick={() => setSelectedEdge(edge.id)}>{from.label} — {edge.phrase} — {to.label} <span className={`state-badge ${edge.state}`}>{edge.state === "supported" ? "✓" : edge.state === "question" ? "?" : "±"}</span></button></li>; })}</ul></div>
          </section>

          <section className="orbit-panel analysis-panel" aria-labelledby="sna-title">
            <div className="panel-head"><div><div className="panel-kicker">Observed interaction network</div><h2 className="panel-title" id="sna-title">近期互動網絡</h2><div className="panel-meta">群體視圖，不是個人評分</div></div><div className="toolbar"><select aria-label="時間窗口" value={windowMinutes} onChange={(event) => setWindowMinutes(event.target.value)}><option value="10">近 10 分鐘</option><option value="30">近 30 分鐘</option><option value="60">近 60 分鐘</option></select><button aria-pressed={paused} onClick={() => setPaused((value) => !value)}>{paused ? "繼續" : "暫停"}</button></div></div>
            <div className="sna-legend"><span className="legend-item"><span className="legend-dot" />學生</span><span className="legend-item"><span className="legend-dot agent" />Nova Agent</span><span className="legend-item"><span className="legend-line" />觀測事件</span></div>
            <div className="analysis-body"><div className="graph-wrap"><svg viewBox="0 0 100 100" role="group" aria-label="近期互動網絡圖"><defs><marker id="arrow-social" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#1f7a3b" /></marker></defs>{visibleSocialEdges.map((edge, index) => { const from = people.find((node) => node.id === edge.from)!; const to = people.find((node) => node.id === edge.to)!; const fan = index % 2 ? 2 : -2; return <g key={`${edge.from}-${edge.to}-${index}`} tabIndex={0} role="button" aria-label={`${from.label} — ${edge.label} → ${to.label}`}><path className="graph-edge" d={`M ${from.x} ${from.y} Q ${(from.x + to.x) / 2 + fan} ${(from.y + to.y) / 2 + fan} ${to.x} ${to.y}`} markerEnd="url(#arrow-social)" /></g>; })}{people.map((node) => <g key={node.id}><circle className={`graph-node ${node.kind === "agent" ? "agent" : ""}`} cx={node.x} cy={node.y} r={node.kind === "room" ? 7 : 6} /><text className="graph-label" x={node.x} y={node.y + 11} textAnchor="middle">{node.label}</text></g>)}</svg></div><aside className="graph-inspector"><h3 className="inspector-title">群體摘要</h3><ul className="inspector-list"><li>參與平衡 <strong>78%</strong></li><li>互惠程度 <strong>0.64</strong></li><li>Agent 互動佔比 <strong>22%</strong></li><li>證據覆蓋率 <strong>81%</strong></li><li>視圖 <strong>{snaView}</strong></li><li>窗口 <strong>{windowMinutes} 分鐘</strong></li></ul></aside><div style={{ gridColumn: "1 / -1" }} className="toolbar"><button aria-pressed={snaView === "observed"} onClick={() => setSnaView("observed")}>全體互動</button><button aria-pressed={snaView === "human_only"} onClick={() => setSnaView("human_only")}>只看同學</button><button aria-pressed={snaView === "lineage_adjusted"} onClick={() => setSnaView("lineage_adjusted")}>來源歸因</button></div></div>
            <p className="network-note">此圖呈現系統觀測到的近期互動事件，不等同友情、地位、能力、貢獻價值、學習成績或心理關係。</p>
          </section>
        </div>
      </div>
    </main>
  );
}
