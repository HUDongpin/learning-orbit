"use client";

import { useMemo, useRef, useState } from "react";
import React from "react";
import { coordinateProjections, type ConceptEdge, type SocialEdge } from "../../../src/lib/session/projection-coordinator";
import type { LedgerMessage } from "../../../src/lib/session/event-ledger";

type Message = LedgerMessage & { name: string; initials: string; time: string; self?: boolean; mediaPreview?: string; mediaKind?: "image" | "audio"; alt?: string };
type ComposerMedia = { url: string; kind: "image" | "audio"; name: string; alt: string };

const seed = (messageId: string, eventId: string, actorId: string, text: string, time: string, extra: Partial<Message> = {}): Message => ({
  messageId, eventId, actorId, actorKind: actorId === "nova" ? "agent" : "human", actorRole: actorId === "nova" ? "socratic_facilitator" : "student",
  text, time, eventTime: `2026-08-30T${time}:00.000Z`, revision: 1, operation: "add", replyTo: null, mentions: [], mediaIds: [],
  name: actorId === "nova" ? "Nova Agent" : `探索者 ${actorId.slice(-1).toUpperCase()}`, initials: actorId === "nova" ? "N" : actorId.slice(-1).toUpperCase(), ...extra,
});

const initialMessages: Message[] = [
  seed("m1", "evt-1", "student-a", "我覺得太陽是生態系統的主要能量來源。", "09:04"),
  seed("m2", "evt-2", "student-b", "生產者把光能儲存在有機物裡，再傳給消費者。", "09:06", { replyTo: "student-a" }),
  seed("m3", "evt-3", "nova", "你們的說法都有證據嗎？能否指出能量流動與物質循環的差異？", "09:07"),
  seed("m4", "evt-4", "student-c", "我上傳了池塘觀察草圖，分解者似乎把養分送回土壤。", "09:09", { mediaPreview: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='720' height='420'%3E%3Crect width='720' height='420' fill='%23dff2e6'/%3E%3Cpath d='M0 330 Q170 230 360 320 T720 300 V420 H0Z' fill='%2368b69a'/%3E%3Ccircle cx='580' cy='84' r='45' fill='%23f4b942'/%3E%3Cpath d='M110 280 Q160 160 220 280M310 300 Q360 160 410 300' stroke='%231f7a3b' stroke-width='18' fill='none'/%3E%3C/svg%3E", mediaKind: "image", alt: "池塘、陽光和植物的觀察草圖" }),
  seed("m5", "evt-5", "student-d", "我不確定能量會不會循環，想找一個反例。", "09:11"),
  seed("m6", "evt-6", "nova", "目前共識：能量沿食物鏈單向流動；物質則在生產者、消費者與分解者間循環。還有哪一條需要驗證？", "09:13"),
];

const names: Record<string, string> = { "student-a": "探索者 A", "student-b": "探索者 B", "student-c": "探索者 C", "student-d": "探索者 D", nova: "Nova Agent", room: "聊天室" };
const id = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function Icon({ name }: { name: "image" | "mic" | "send" | "reply" | "edit" | "trash" }) {
  const common = { "aria-hidden": true, width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 };
  if (name === "image") return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="8.5" cy="9" r="1.5" /><path d="m4 17 5-5 3 3 2-2 6 5" /></svg>;
  if (name === "mic") return <svg {...common}><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></svg>;
  if (name === "send") return <svg {...common}><path d="m4 12 16-8-5 16-3-6-8-2Z" /><path d="m12 14 4-4" /></svg>;
  if (name === "reply") return <svg {...common}><path d="M9 8 4 12l5 4" /><path d="M5 12h8a6 6 0 0 1 6 6" /></svg>;
  if (name === "edit") return <svg {...common}><path d="m4 16-.8 4.8L8 20l10.7-10.7a2 2 0 0 0-2.8-2.8Z" /><path d="m14.5 8.5 2.8 2.8" /></svg>;
  return <svg {...common}><path d="M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" /></svg>;
}

function GraphEdge({ edge, from, to, selected, onSelect }: { edge: ConceptEdge; from: { x: number; y: number; label: string }; to: { x: number; y: number; label: string }; selected: boolean; onSelect: () => void }) {
  const marker = edge.state === "challenge" ? "#e95d64" : edge.state === "question" ? "#f4b942" : "#7aab87";
  const dash = edge.state === "question" ? "5 4" : edge.state === "challenge" ? "8 5" : undefined;
  return <g className={selected ? "graph-edge-group selected" : "graph-edge-group"} tabIndex={0} role="button" aria-label={`${from.label} — ${edge.phrase} — ${to.label}`} onClick={onSelect} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } }}>
    <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={marker} strokeWidth={selected ? 3 : 2} strokeDasharray={dash} markerEnd="url(#arrow-concept)" />
    <rect x={(from.x + to.x) / 2 - 4} y={(from.y + to.y) / 2 - 5} width="8" height="8" rx="4" fill="#fff" stroke={marker} />
    <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 + 1} textAnchor="middle" className="graph-edge-badge">{edge.state === "supported" ? "✓" : edge.state === "question" ? "?" : "±"}</text>
  </g>;
}

export default function RoomClient({ roomId }: { roomId: string }) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [selectedConcept, setSelectedConcept] = useState("producer");
  const [selectedEdge, setSelectedEdge] = useState("e1");
  const [snaView, setSnaView] = useState<"observed" | "human_only" | "lineage_adjusted">("observed");
  const [windowMinutes, setWindowMinutes] = useState("30");
  const [paused, setPaused] = useState(false);
  const [liveNote, setLiveNote] = useState("概念圖與互動網絡會隨演示事件批次更新。 ");
  const [media, setMedia] = useState<ComposerMedia | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunks = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const projections = useMemo(() => coordinateProjections(messages), [messages]);
  const selected = projections.nodes.find((node) => node.id === selectedConcept) ?? projections.nodes[0]!;
  const statement = projections.edges.find((edge) => edge.id === selectedEdge) ?? projections.edges[0]!;
  const visibleSocialEdges = useMemo(() => {
    if (snaView === "human_only") return projections.socialEdges.filter((edge) => edge.from !== "nova" && edge.to !== "nova" && edge.to !== "room");
    if (snaView === "lineage_adjusted") return projections.socialEdges.filter((edge) => edge.kind === "uptake" || edge.kind === "facilitation");
    return projections.socialEdges;
  }, [projections.socialEdges, snaView]);

  function submit(text = draft) {
    const clean = text.trim();
    if (!clean || paused) return;
    if (editing) {
      setMessages((current) => current.map((message) => message.messageId === editing.messageId ? { ...message, text: clean, revision: message.revision + 1, operation: "revise", eventId: id("evt") } : message));
      setEditing(null); setDraft(""); setLiveNote("訊息已修訂；分析投影保留新的 revision 與來源。"); return;
    }
    const mentions = [...clean.matchAll(/@([\w-]+|Nova)/gi)].map((match) => match[1]?.toLowerCase() === "nova" ? "nova" : `student-${match[1]?.toLowerCase()}`).filter((value): value is string => Boolean(value));
    const now = new Date().toISOString();
    const newMessage: Message = { messageId: id("message"), eventId: id("evt"), actorId: "student-a", actorKind: "human", actorRole: "student", text: clean, time: "現在", eventTime: now, revision: 1, operation: "add", replyTo: replyTo?.actorId ?? null, mentions, mediaIds: media ? [id("media")] : [], name: "探索者 A", initials: "A", self: true, ...(media ? { mediaPreview: media.url, mediaKind: media.kind, alt: media.alt } : {}) };
    setMessages((current) => [...current, newMessage]); setDraft(""); setReplyTo(null); setMedia(null);
    setLiveNote(mentions.length ? "已加入聊天室，並記錄對 Nova 的提及事件。" : "已加入聊天室；演示規則會在符合提示詞時更新分析圖。");
  }

  function retract(message: Message) {
    setMessages((current) => current.map((item) => item.messageId === message.messageId ? { ...item, operation: "retract", revision: item.revision + 1, eventId: id("evt") } : item));
    setLiveNote("訊息已撤回；相關證據在可追溯記錄中標為 retract。");
  }

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setLiveNote("本地演示只接受圖片檔案；未上傳任何內容。"); return; }
    const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
    setMedia({ url, kind: "image", name: file.name, alt: file.name }); setLiveNote("圖片已在瀏覽器本地預覽；尚未上傳至伺服器。");
  }

  async function toggleRecording() {
    if (recording) { recorderRef.current?.stop(); return; }
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) { setLiveNote("此瀏覽器不支援本地錄音，請改用文字或圖片。"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream); recordingChunks.current = []; recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) recordingChunks.current.push(event.data); };
      recorder.onstop = () => { stream.getTracks().forEach((track) => track.stop()); const blob = new Blob(recordingChunks.current, { type: recorder.mimeType || "audio/webm" }); setMedia({ url: URL.createObjectURL(blob), kind: "audio", name: "本地錄音", alt: "尚未轉寫的本地語音" }); setRecording(false); setLiveNote("錄音已完成並可回放；新錄音尚未轉寫（未接入 ASR）。"); if (timerRef.current) clearInterval(timerRef.current); setRecordingSeconds(0); };
      recorder.start(); setRecording(true); setRecordingSeconds(0); timerRef.current = setInterval(() => setRecordingSeconds((seconds) => seconds + 1), 1000); setLiveNote("正在本地錄音；停止後可回放或刪除，未上傳至伺服器。");
    } catch { setRecording(false); setLiveNote("麥克風權限被拒絕，錄音未開始。請允許權限或改用文字／圖片。"); }
  }

  function keyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }
  function selectReply(message: Message) { setReplyTo(message); setEditing(null); inputRef.current?.focus(); }

  return <main className="orbit-shell">
    <header className="orbit-header"><div className="orbit-brand"><div className="orbit-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="6" /><ellipse cx="16" cy="16" rx="14" ry="5" transform="rotate(-25 16 16)" /><circle cx="26" cy="10" r="1.8" fill="white" stroke="none" /></svg></div><div><h1 className="orbit-title">Learning Orbit <span aria-hidden="true">·</span> 共學星球</h1><p className="orbit-subtitle">生態系統探究 · 4 位探索者 + Nova Agent</p></div></div><div className="orbit-status"><span className="orbit-status-dot" />本地演示 · 模擬即時 · 房間 {roomId.slice(0, 8)}</div></header>
    <div className="orbit-grid">
      <section className="orbit-panel chat-panel" aria-labelledby="chat-title"><div className="panel-head"><div><div className="panel-kicker">Collaborative studio</div><h2 className="panel-title" id="chat-title">生態系統探究聊天室</h2><div className="panel-meta">45 分鐘任務 · 目前進度 17 分鐘</div></div><div><div className="panel-meta">探索者 4/4</div><div className="progress-track" aria-label="任務進度 38%"><div className="progress-fill" /></div></div></div>
        <div className="messages" aria-label="聊天室訊息">{messages.map((message) => <article className={`message${message.self ? " self" : ""}${message.actorKind === "agent" ? " agent" : ""}${message.operation === "retract" ? " retracted" : ""}`} key={message.messageId}><div className={`avatar${message.actorKind === "agent" ? " agent" : ""}`} aria-hidden="true"><span>{message.initials}</span></div><div className="bubble-wrap"><div className="message-name">{message.name}{message.operation === "revise" && <span className="message-state"> · 已修訂</span>}{message.operation === "retract" && <span className="message-state"> · 已撤回</span>}</div><div className="bubble">{message.replyTo && <div className="reply-strip">回覆：{names[message.replyTo] ?? message.replyTo}</div>}{message.operation === "retract" ? <em>這則訊息已撤回。</em> : message.text}{message.mediaPreview && message.mediaKind === "image" && <figure className="local-media"><img src={message.mediaPreview} alt={message.alt || "本地圖片預覽"} /><figcaption>{message.alt || "本地圖片預覽"}</figcaption></figure>}{message.mediaPreview && message.mediaKind === "audio" && <div className="local-media"><audio controls src={message.mediaPreview} aria-label="尚未轉寫的本地語音" /><span className="media-caption">尚未轉寫 · 本地回放</span></div>}<span className="message-time">{message.time}</span></div><div className="message-actions"><button className="tiny-action" onClick={() => selectReply(message)} aria-label={`回覆 ${message.name}`}><Icon name="reply" />回覆</button>{message.self && message.operation !== "retract" && <><button className="tiny-action" onClick={() => { setEditing(message); setDraft(message.text); inputRef.current?.focus(); }} aria-label={`修訂 ${message.name} 的訊息`}><Icon name="edit" />修訂</button><button className="tiny-action" onClick={() => retract(message)} aria-label={`撤回 ${message.name} 的訊息`}><Icon name="trash" />撤回</button></>}</div></div></article>)}</div>
        <div className="chips" aria-label="探究提示"><button className="chip" onClick={() => submit("太陽提供能量給生產者")}>太陽 → 生產者</button><button className="chip" onClick={() => submit("能量沿食物鏈傳遞")}>能量沿食物鏈</button><button className="chip" onClick={() => submit("分解者把養分送回土壤")}>養分回到土壤</button><button className="chip" onClick={() => { setDraft((value) => `${value}@Nova `); inputRef.current?.focus(); }}>@Nova 提問</button></div>
        <div className="composer"><div aria-live="polite" className="sr-only">{liveNote}</div>{replyTo && <div className="reply-strip composer-context">回覆 {replyTo.name}：{replyTo.text.slice(0, 50)} <button className="context-close" aria-label="取消回覆" onClick={() => setReplyTo(null)}>×</button></div>}{editing && <div className="reply-strip composer-context">修訂自己的訊息 <button className="context-close" aria-label="取消修訂" onClick={() => { setEditing(null); setDraft(""); }}>×</button></div>}{media && <div className="attachment-preview"><span>{media.kind === "image" ? "圖片" : "語音"} · {media.name}</span><button className="context-close" onClick={() => { if (media.kind === "audio") URL.revokeObjectURL(media.url); setMedia(null); }} aria-label="刪除附件">×</button></div>}<div className="composer-row"><input ref={fileRef} className="sr-only" type="file" accept="image/*" onChange={(event) => { void chooseFile(event.target.files?.[0]); event.currentTarget.value = ""; }} /><button className="icon-button" aria-label="選擇圖片" title="選擇圖片（本地演示）" onClick={() => fileRef.current?.click()}><Icon name="image" /></button><button className={`icon-button${recording ? " is-recording" : ""}`} aria-label={recording ? "停止錄音" : "錄製語音"} title="錄製語音（本地演示）" onClick={() => { void toggleRecording(); }}>{recording ? <span className="recording-time">{recordingSeconds}s</span> : <Icon name="mic" />}</button><label className="sr-only" htmlFor="message-input">分享觀察、證據或一個問題…</label><textarea id="message-input" ref={inputRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} placeholder="分享觀察、證據或一個問題…" rows={1} /><button className="send-button" aria-label="發送訊息" onClick={() => submit()} disabled={!draft.trim() || paused}><Icon name="send" /></button></div><p className="composer-help">Enter 發送 · Shift+Enter 換行 · 可輸入 @Nova 提及促進者</p><p className="composer-note">{liveNote}</p></div>
      </section>
      <div className="analysis-column">
        <section className="orbit-panel analysis-panel" aria-labelledby="concept-title"><div className="panel-head"><div><div className="panel-kicker">Evidence-coupled map</div><h2 className="panel-title" id="concept-title">即時概念圖</h2><div className="panel-meta">焦點問題：能量如何流動，而物質如何循環？</div></div><div className="toolbar"><button aria-pressed={!paused} onClick={() => setPaused((value) => !value)}>{paused ? "繼續更新" : "自動更新"}</button><button onClick={() => { setMessages(initialMessages); setSelectedConcept("producer"); setSelectedEdge("e1"); setLiveNote("已重新播放合成事件；概念與 SNA 投影已重置。 "); }}>重新播放</button></div></div><div className="analysis-body"><div className="graph-wrap"><svg viewBox="0 0 100 100" role="group" aria-label="概念命題圖"><defs><marker id="arrow-concept" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#7aab87" /></marker></defs>{projections.edges.map((edge) => { const from = projections.nodes.find((node) => node.id === edge.from)!; const to = projections.nodes.find((node) => node.id === edge.to)!; return <GraphEdge key={edge.id} edge={edge} from={from} to={to} selected={selectedEdge === edge.id} onSelect={() => setSelectedEdge(edge.id)} />; })}{projections.nodes.map((node) => <g key={node.id} tabIndex={0} role="button" aria-label={`概念：${node.label}`} onClick={() => setSelectedConcept(node.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedConcept(node.id); } }}><circle className={`graph-node ${selectedConcept === node.id ? "active" : ""}`} cx={node.x} cy={node.y} r="8" /><text className="graph-label" x={node.x} y={node.y + .8} textAnchor="middle">{node.label}</text></g>)}</svg></div><aside className="graph-inspector" aria-live="polite"><h3 className="inspector-title">選取詳情</h3><ul className="inspector-list"><li><strong>概念</strong><br />{selected.label}</li><li><strong>命題</strong><br />{statement.phrase}</li><li><strong>來源</strong><br />{statement.evidenceIds.length ? statement.evidenceIds.join(", ") : "待補證據"}</li><li><strong>首次／最近</strong><br />09:04 ／ 現在</li><li><strong>證據數／信心</strong><br />{statement.evidenceIds.length} ／ {statement.evidenceIds.length ? "中" : "低"} · <span className={`state-badge ${statement.state}`}>{statement.state === "supported" ? "已確認" : statement.state === "question" ? "待確認" : "支持／質疑"}</span></li></ul></aside><ul className="statement-list" aria-label="概念命題列表">{projections.edges.map((edge) => { const from = projections.nodes.find((node) => node.id === edge.from)!; const to = projections.nodes.find((node) => node.id === edge.to)!; return <li key={edge.id}><button aria-pressed={selectedEdge === edge.id} onClick={() => setSelectedEdge(edge.id)}>{from.label} — {edge.phrase} — {to.label} <span className={`state-badge ${edge.state}`}>{edge.state === "supported" ? "✓ 已確認" : edge.state === "question" ? "? 待確認" : "± 支持／質疑"}</span></button></li>; })}</ul></div></section>
        <section className="orbit-panel analysis-panel" aria-labelledby="sna-title"><div className="panel-head"><div><div className="panel-kicker">Observed interaction network</div><h2 className="panel-title" id="sna-title">近期互動網絡</h2><div className="panel-meta">群體視圖，不是個人評分</div></div><div className="toolbar"><select aria-label="時間窗口" value={windowMinutes} onChange={(event) => setWindowMinutes(event.target.value)}><option value="10">近 10 分鐘</option><option value="30">近 30 分鐘</option><option value="60">近 60 分鐘</option></select><button aria-pressed={paused} onClick={() => setPaused((value) => !value)}>{paused ? "繼續" : "暫停"}</button></div></div><div className="sna-tabs" role="tablist" aria-label="互動網絡視圖"><button role="tab" aria-selected={snaView === "observed"} onClick={() => setSnaView("observed")}>全體互動</button><button role="tab" aria-selected={snaView === "human_only"} onClick={() => setSnaView("human_only")}>只看同學</button><button role="tab" aria-selected={snaView === "lineage_adjusted"} onClick={() => setSnaView("lineage_adjusted")}>來源歸因</button></div><div className="sna-legend"><span className="legend-item"><span className="legend-dot" />學生</span><span className="legend-item"><span className="legend-dot agent" />Nova Agent</span><span className="legend-item"><span className="legend-line" />觀測事件</span></div><div className="analysis-body"><div className="graph-wrap"><svg viewBox="0 0 100 100" role="group" aria-label={`近期互動網絡圖，${snaView}，${windowMinutes}分鐘`}><defs><marker id="arrow-social" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#1f7a3b" /></marker></defs>{visibleSocialEdges.map((edge: SocialEdge, index) => { const from = projections.people.find((node) => node.id === edge.from)!; const to = projections.people.find((node) => node.id === edge.to)!; if (!from || !to) return null; const offset = index % 2 ? 3 : -3; return <g key={edge.id} tabIndex={0} role="button" aria-label={`${from.label} — ${edge.label} → ${to.label}`}><path className="graph-edge social-edge" d={`M ${from.x} ${from.y} Q ${(from.x + to.x) / 2 + offset} ${(from.y + to.y) / 2 + offset} ${to.x} ${to.y}`} markerEnd="url(#arrow-social)" /><title>{`${from.label} — ${edge.label} → ${to.label} · 證據 ${edge.evidenceIds.join(", ")}`}</title></g>; })}{projections.people.map((node) => <g key={node.id} tabIndex={0} role="button" aria-label={`${node.label}，${node.kind === "agent" ? "Agent" : node.kind === "room" ? "聊天室" : "學生"}`}><circle className={`graph-node ${node.kind === "agent" ? "agent" : ""} ${node.kind === "room" ? "room" : ""}`} cx={node.x} cy={node.y} r={node.kind === "room" ? 7 : 6} /><text className="graph-label" x={node.x} y={node.y + 11} textAnchor="middle">{node.label}</text></g>)}</svg></div><aside className="graph-inspector"><h3 className="inspector-title">群體摘要</h3><ul className="inspector-list"><li>參與平衡 <strong>78%</strong></li><li>互惠程度 <strong>0.64</strong></li><li>Agent 互動佔比 <strong>22%</strong></li><li>證據覆蓋率 <strong>{Math.min(100, projections.socialEdges.length * 16)}%</strong></li><li>視圖 <strong>{snaView}</strong></li><li>窗口 <strong>{windowMinutes} 分鐘</strong></li></ul></aside><ul className="statement-list social-list" aria-label="互動關係列表">{visibleSocialEdges.map((edge) => <li key={edge.id}><button aria-label={`${names[edge.from] ?? edge.from} ${edge.label} ${names[edge.to] ?? edge.to}`}>{names[edge.from] ?? edge.from} — {edge.label} → {names[edge.to] ?? edge.to}<small> 證據 {edge.evidenceIds.join(", ")}</small></button></li>)}</ul></div><p className="network-note">此圖呈現系統觀測到的近期互動事件，不等同友情、地位、能力、貢獻價值、學習成績或心理關係。</p></section>
      </div>
    </div>
  </main>;
}
