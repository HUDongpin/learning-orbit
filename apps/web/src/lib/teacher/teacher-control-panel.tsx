"use client";

import type {
  AnalyticsReviewCommand,
  DeleteRoomAccepted,
  DeletionStatus,
  DerivedTextArtifact,
  ServerFrame,
  TeacherConceptMapSnapshot,
} from "@learning-orbit/contracts";
import React, { useEffect, useMemo, useRef, useState } from "react";

import {
  SessionGatewayError,
  type RoomExportFile,
  type SessionGateway,
} from "../session/session-gateway";
import type { RoomCommandIntent } from "../session/session-command-bus";
import {
  buildTeacherCorrectionCommand,
  type TeacherCorrectionKind,
} from "./teacher-correction-command";

const CORRECTION_LABELS: Readonly<Record<TeacherCorrectionKind, string>> = {
  replace_text: "修正文字",
  replace_evidence_span: "替換證據片段",
  replace_relation: "修正概念關係",
  merge_alias: "合併同義概念",
  split_alias: "拆分同義概念",
  undo_merge: "撤銷本次合併",
  retract: "撤回分析目標",
};
const REVIEW_DECISIONS = ["approve", "reject", "revoke", "review_pass", "review_concerns", "review_fail"] as const;

type Gateway = Pick<SessionGateway,
  | "getDerivedTextArtifacts"
  | "getAnalyticsReviewDetail"
  | "submitAnalyticsReview"
  | "exportRoom"
  | "requestRoomDeletion"
  | "getRoomDeletion"
  | "setAgentSettings"
>;

export type TeacherLifecycleRuntime = Readonly<{
  sendIntent(intent: RoomCommandIntent): string;
  refreshAgentCurrent?(): Promise<void>;
  sessionState?: Readonly<{ connected: boolean }>;
  pendingCommandIds?(): string[];
  acks?: ReadonlyMap<string, unknown>;
  rejects?: readonly Pick<Extract<ServerFrame, { type: "reject" }>, "commandId" | "code" | "retryable">[];
}>;

export type TeacherControlPanelProps = Readonly<{
  roomId: string;
  roomStatus: "scheduled" | "open" | "paused" | "closed";
  echo?: TeacherConceptMapSnapshot;
  agentEnabled?: boolean;
  analyticsCorrectionEventIds?: readonly string[];
  gateway: Gateway;
  runtime: TeacherLifecycleRuntime;
  onDeletionAccepted(accepted: DeleteRoomAccepted | DeletionStatus): void;
  onDeletionUncertain?(): void;
  onSessionExpired?(): void;
}>;

type DownloadPort = Readonly<{
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  click(url: string, fileName: string): void;
}>;

function browserDownloadPort(): DownloadPort {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    click: (url, fileName) => {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    },
  };
}

export function saveRoomExport(file: RoomExportFile, port: DownloadPort = browserDownloadPort()): void {
  const url = port.createObjectURL(file.blob);
  try { port.click(url, file.fileName); }
  finally { port.revokeObjectURL(url); }
}

function selected<T>(values: readonly T[], index: number): T | undefined {
  return Number.isSafeInteger(index) && index >= 0 ? values[index] : undefined;
}

function lifecycleActions(status: TeacherControlPanelProps["roomStatus"]): Array<Readonly<{
  type: Extract<RoomCommandIntent, { type: `room.${string}` }>["type"];
  label: string;
}>> {
  if (status === "scheduled") return [{ type: "room.open", label: "開始課堂" }];
  if (status === "open") return [{ type: "room.pause", label: "暫停課堂" }, { type: "room.close", label: "結束課堂" }];
  if (status === "paused") return [{ type: "room.resume", label: "繼續課堂" }, { type: "room.close", label: "結束課堂" }];
  return [];
}

export function TeacherControlPanel({
  roomId,
  roomStatus,
  echo,
  agentEnabled,
  analyticsCorrectionEventIds = [],
  gateway,
  runtime,
  onDeletionAccepted,
  onDeletionUncertain,
  onSessionExpired,
}: TeacherControlPanelProps) {
  const [artifacts, setArtifacts] = useState<DerivedTextArtifact[]>([]);
  const [nextArtifactId, setNextArtifactId] = useState<string | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(true);
  const [artifactError, setArtifactError] = useState<string>();
  const [artifactIndex, setArtifactIndex] = useState(0);
  const [reviewDecision, setReviewDecision] = useState<typeof REVIEW_DECISIONS[number]>("approve");
  const [rationale, setRationale] = useState("");
  const [correctionKind, setCorrectionKind] = useState<TeacherCorrectionKind>("replace_text");
  const [reason, setReason] = useState("");
  const [replacementText, setReplacementText] = useState("");
  const [languageTag, setLanguageTag] = useState("zh-Hant");
  const [edgeIndex, setEdgeIndex] = useState(0);
  const [replacementEdgeIndex, setReplacementEdgeIndex] = useState(0);
  const [targetEvidenceIndex, setTargetEvidenceIndex] = useState(0);
  const [replacementEvidenceIndex, setReplacementEvidenceIndex] = useState(0);
  const [canonicalIndex, setCanonicalIndex] = useState(0);
  const [aliasIndex, setAliasIndex] = useState(1);
  const [predicate, setPredicate] = useState("");
  const [relationFamily, setRelationFamily] = useState("");
  const [newCanonicalNodeId, setNewCanonicalNodeId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [retractType, setRetractType] = useState<"derived_text" | "evidence" | "projection">("derived_text");
  const [mergeUndoCandidate, setMergeUndoCandidate] = useState<Readonly<{
    reviewEventId: string;
    canonicalNodeId: string;
    aliasNodeId: string;
  }> | undefined>(undefined);
  const [commandPending, setCommandPending] = useState(false);
  const [actionStatus, setActionStatus] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [deletePhrase, setDeletePhrase] = useState("");
  const [agentPolicy, setAgentPolicy] = useState<boolean | undefined>(agentEnabled);
  const [lifecycleRequest, setLifecycleRequest] = useState<Readonly<{
    commandId: string;
    targetStatus: TeacherControlPanelProps["roomStatus"];
  }>>();
  const projectionAuthorityKey = echo ? `${echo.analysisEpoch}:${echo.projectionVersion}` : "unavailable";
  const previousProjectionAuthorityKey = useRef<string | undefined>(undefined);
  const actionController = useRef<AbortController | undefined>(undefined);
  const paginationController = useRef<AbortController | undefined>(undefined);
  const actionErrorRef = useRef<HTMLParagraphElement>(null);
  const onSessionExpiredRef = useRef(onSessionExpired);

  const edges = echo?.payload.edges ?? [];
  const nodes = echo?.payload.nodes ?? [];
  const lifecycle = lifecycleActions(roomStatus);
  const selectedArtifact = selected(artifacts, artifactIndex);
  const selectedEdge = selected(edges, edgeIndex);
  const replacementEdge = selected(edges, replacementEdgeIndex);
  const targetEvidenceRefs = selectedEdge?.evidenceRefs ?? [];
  const replacementEvidenceRefs = replacementEdge?.evidenceRefs ?? [];
  const targetEvidence = selected(targetEvidenceRefs, targetEvidenceIndex);
  const replacementEvidence = selected(replacementEvidenceRefs, replacementEvidenceIndex);
  const canonicalNode = selected(nodes, canonicalIndex);
  const aliasNode = selected(nodes, aliasIndex);
  const currentNodeIds = new Set(nodes.map(({ nodeId }) => nodeId));
  const mergeIsEffective = mergeUndoCandidate !== undefined
    && currentNodeIds.has(mergeUndoCandidate.canonicalNodeId)
    && !currentNodeIds.has(mergeUndoCandidate.aliasNodeId);
  const projectionAuthority = echo
    ? { expectedAnalysisEpoch: echo.analysisEpoch, expectedProjectionVersion: echo.projectionVersion }
    : undefined;
  const connected = runtime.sessionState?.connected === true;
  const lifecycleReject = lifecycleRequest
    ? [...(runtime.rejects ?? [])].reverse().find(({ commandId }) => commandId === lifecycleRequest.commandId)
    : undefined;
  const lifecycleConfirmed = lifecycleRequest !== undefined && roomStatus === lifecycleRequest.targetStatus;
  const lifecycleAcknowledged = lifecycleRequest !== undefined && runtime.acks?.has(lifecycleRequest.commandId) === true;
  const lifecycleNonRetryableReject = lifecycleReject !== undefined && lifecycleReject.retryable !== true;
  const lifecycleAwaiting = lifecycleRequest !== undefined
    && !lifecycleConfirmed
    && !lifecycleNonRetryableReject;
  const lifecycleTransportPending = lifecycleRequest !== undefined
    && (runtime.pendingCommandIds?.().includes(lifecycleRequest.commandId) ?? false);
  const correctionCanSubmit = Boolean(projectionAuthority && reason.trim()) && (() => {
    switch (correctionKind) {
      case "replace_text":
        return Boolean(selectedArtifact && replacementText.trim() && languageTag.trim());
      case "replace_evidence_span":
        return Boolean(selectedEdge && targetEvidence && replacementEvidence);
      case "replace_relation":
        return Boolean(selectedEdge && canonicalNode && aliasNode
          && predicate.trim() && relationFamily.trim());
      case "merge_alias":
        return Boolean(canonicalNode && aliasNode && canonicalNode.nodeId !== aliasNode.nodeId);
      case "split_alias":
        return Boolean(canonicalNode && aliasNode
          && canonicalNode.nodeId !== aliasNode.nodeId
          && newCanonicalNodeId.trim() && newLabel.trim()
          && !currentNodeIds.has(newCanonicalNodeId.trim())
          && newCanonicalNodeId.trim() !== canonicalNode.nodeId
          && newCanonicalNodeId.trim() !== aliasNode.nodeId);
      case "undo_merge":
        return mergeIsEffective;
      case "retract":
        return retractType === "derived_text" ? selectedArtifact !== undefined
          : retractType === "projection" ? selectedEdge !== undefined
            : targetEvidence !== undefined;
    }
  })();

  useEffect(() => {
    const controller = new AbortController();
    setArtifactLoading(true);
    setArtifactError(undefined);
    void gateway.getDerivedTextArtifacts(
      roomId,
      { reviewStatus: "unreviewed", includeHistory: false, limit: 50 },
      { signal: controller.signal },
    ).then((page) => {
      if (controller.signal.aborted) return;
      setArtifacts(page.items);
      setNextArtifactId(page.nextAfterArtifactId);
      setArtifactIndex(0);
      setArtifactLoading(false);
    }, (error) => {
      if (controller.signal.aborted) return;
      if (error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED") {
        onSessionExpiredRef.current?.();
        return;
      }
      setArtifactError("未能載入真實 Artifact Queue；沒有建立本地替代資料。");
      setArtifactLoading(false);
    });
    return () => controller.abort();
  }, [gateway, projectionAuthorityKey, roomId]);

  useEffect(() => { setAgentPolicy(agentEnabled); }, [agentEnabled]);

  useEffect(() => { onSessionExpiredRef.current = onSessionExpired; }, [onSessionExpired]);

  useEffect(() => {
    if (actionError) actionErrorRef.current?.focus();
  }, [actionError]);

  useEffect(() => () => {
    actionController.current?.abort();
    paginationController.current?.abort();
  }, []);

  const latestCorrectionEventId = analyticsCorrectionEventIds.at(-1);
  useEffect(() => {
    // A content-free correction notice is never sufficient undo authority.
    // Invalidate the previous candidate synchronously with every new latest
    // correction before asking the server for its closed review detail.  A
    // failed, aborted, or non-merge lookup therefore stays fail closed.
    setMergeUndoCandidate(undefined);
    if (!latestCorrectionEventId) return;
    const controller = new AbortController();
    void gateway.getAnalyticsReviewDetail(
      roomId,
      latestCorrectionEventId,
      { signal: controller.signal },
    ).then((detail) => {
      if (controller.signal.aborted) return;
      const payload = detail.payload;
      if ("correctionKind" in payload && payload.correctionKind === "merge_alias") {
        setMergeUndoCandidate({
          reviewEventId: detail.reviewEventId,
          canonicalNodeId: payload.targetCanonicalNodeId,
          aliasNodeId: payload.replacement.aliasNodeId,
        });
      } else {
        // Server permits undo only when the merge is the latest correction;
        // any later correction makes the prior merge ineligible.
        setMergeUndoCandidate(undefined);
      }
    }, (error) => {
      if (controller.signal.aborted) return;
      if (error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED") {
        onSessionExpiredRef.current?.();
      }
      // A missing/corrupt detail is fail-closed: no undo authority is
      // reconstructed from the content-free RoomEvent notice alone.
    });
    return () => controller.abort();
  }, [gateway, latestCorrectionEventId, roomId]);

  useEffect(() => {
    const previous = previousProjectionAuthorityKey.current;
    previousProjectionAuthorityKey.current = projectionAuthorityKey;
    if (previous === undefined || previous === projectionAuthorityKey) return;
    setArtifactIndex(0);
    paginationController.current?.abort();
    setEdgeIndex(0);
    setReplacementEdgeIndex(0);
    setTargetEvidenceIndex(0);
    setReplacementEvidenceIndex(0);
    setCanonicalIndex(0);
    setAliasIndex(1);
    setRationale("");
    setReason("");
    setReplacementText("");
    setPredicate("");
    setRelationFamily("");
    setNewCanonicalNodeId("");
    setNewLabel("");
    setActionError(undefined);
    setActionStatus("伺服器 Projection Authority 已更新；請重新選擇目標並確認審閱或修正內容。");
  }, [projectionAuthorityKey]);

  const edgeOptions = useMemo(() => {
    const labels = new Map(nodes.map((node) => [node.nodeId, node.label]));
    return edges.map((edge) => {
      const head = labels.get(edge.head);
      const tail = labels.get(edge.tail);
      return head && tail ? `${head} → ${edge.predicate} → ${tail}` : "未能驗證的概念關係";
    });
  }, [edges, nodes]);
  const targetEvidenceOptions = targetEvidenceRefs.map(({ start, end }, index) => (
    `片段 ${index + 1}（${start}–${end}）`
  ));
  const replacementEvidenceOptions = replacementEvidenceRefs.map(({ start, end }, index) => (
    `片段 ${index + 1}（${start}–${end}）`
  ));

  function startAction(): AbortSignal {
    actionController.current?.abort();
    const controller = new AbortController();
    actionController.current = controller;
    setActionError(undefined);
    setActionStatus(undefined);
    setCommandPending(true);
    return controller.signal;
  }

  function actionIsCurrent(signal: AbortSignal): boolean {
    return !signal.aborted && actionController.current?.signal === signal;
  }

  function finishAction(signal: AbortSignal): void {
    if (actionIsCurrent(signal)) setCommandPending(false);
  }

  function routeExpiredSession(error: unknown): boolean {
    if (error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED") {
      onSessionExpiredRef.current?.();
      return true;
    }
    return false;
  }

  async function loadMoreArtifacts(): Promise<void> {
    if (!nextArtifactId || artifactLoading) return;
    paginationController.current?.abort();
    const controller = new AbortController();
    paginationController.current = controller;
    setArtifactLoading(true);
    setArtifactError(undefined);
    try {
      const page = await gateway.getDerivedTextArtifacts(roomId, {
        reviewStatus: "unreviewed",
        afterArtifactId: nextArtifactId,
        includeHistory: false,
        limit: 50,
      }, { signal: controller.signal });
      if (controller.signal.aborted || paginationController.current !== controller) return;
      setArtifacts((current) => [...current, ...page.items]);
      setNextArtifactId(page.nextAfterArtifactId);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (routeExpiredSession(error)) return;
      setArtifactError("未能載入下一頁 Artifact；現有已驗證項目仍可使用。");
    } finally {
      if (!controller.signal.aborted && paginationController.current === controller) {
        setArtifactLoading(false);
      }
    }
  }

  async function submitReview(): Promise<void> {
    if (!selectedArtifact || !projectionAuthority) return;
    const signal = startAction();
    try {
      const input: AnalyticsReviewCommand = {
        targetType: "derived_text",
        targetId: selectedArtifact.artifactId,
        decision: reviewDecision,
        rationale: rationale.trim(),
        ...projectionAuthority,
      };
      await gateway.submitAnalyticsReview(roomId, input, { signal });
      if (!actionIsCurrent(signal)) return;
      setActionStatus("審閱已記錄，正在等待伺服器分析重建與 Projection 更新。");
      setRationale("");
    } catch (error) {
      if (signal.aborted) return;
      if (routeExpiredSession(error)) return;
      setActionError("伺服器未接受審閱；Artifact 與 Projection 沒有被本地改寫。");
    } finally {
      finishAction(signal);
    }
  }

  async function submitCorrection(): Promise<void> {
    if (!projectionAuthority || !correctionCanSubmit) return;
    const signal = startAction();
    try {
      const retractTarget = retractType === "derived_text" && selectedArtifact
        ? { targetType: retractType, targetId: selectedArtifact.artifactId } as const
        : retractType === "projection" && selectedEdge
          ? { targetType: retractType, targetId: selectedEdge.edgeId } as const
          : retractType === "evidence" && targetEvidence
            ? { targetType: retractType, targetId: targetEvidence.eventId } as const
            : undefined;
      const input = buildTeacherCorrectionCommand({
        correctionKind,
        reason,
        ...projectionAuthority,
        ...(selectedArtifact ? { artifactId: selectedArtifact.artifactId } : {}),
        ...(selectedEdge ? { projectionEdgeId: selectedEdge.edgeId } : {}),
        ...(targetEvidence ? { targetEvidence } : {}),
        ...(replacementEvidence ? { replacementEvidence } : {}),
        ...(canonicalNode ? { canonicalNodeId: canonicalNode.nodeId, replacementHead: canonicalNode.nodeId } : {}),
        ...(aliasNode ? { aliasNodeId: aliasNode.nodeId, replacementTail: aliasNode.nodeId } : {}),
        ...(mergeIsEffective && mergeUndoCandidate ? { mergeReviewEventId: mergeUndoCandidate.reviewEventId } : {}),
        ...(retractTarget ? { retractTarget } : {}),
        replacementText,
        languageTag,
        replacementPredicate: predicate,
        replacementRelationFamily: relationFamily,
        newCanonicalNodeId,
        newLabel,
      });
      const accepted = await gateway.submitAnalyticsReview(roomId, input, { signal });
      if (!actionIsCurrent(signal)) return;
      if (correctionKind === "merge_alias" && canonicalNode && aliasNode) {
        setMergeUndoCandidate({
          reviewEventId: accepted.reviewEventId,
          canonicalNodeId: canonicalNode.nodeId,
          aliasNodeId: aliasNode.nodeId,
        });
      }
      if (correctionKind === "undo_merge") setMergeUndoCandidate(undefined);
      setActionStatus("修正已記錄，正在等待伺服器分析重建與 Projection 更新。");
      setReason("");
    } catch (error) {
      if (signal.aborted) return;
      if (routeExpiredSession(error)) return;
      setActionError("伺服器未接受修正；目前 Projection 保持不變。");
    } finally {
      finishAction(signal);
    }
  }

  async function download(format: "json" | "csv"): Promise<void> {
    const signal = startAction();
    try {
      const file = await gateway.exportRoom(roomId, format, { signal });
      if (!actionIsCurrent(signal)) return;
      saveRoomExport(file);
      setActionStatus(`伺服器 ${format.toUpperCase()} 匯出內容已通過驗證，並已交由瀏覽器處理下載。`);
    } catch (error) {
      if (signal.aborted) return;
      if (routeExpiredSession(error)) return;
      setActionError("匯出不可用；系統沒有建立空白或部分成功檔案。");
    } finally {
      finishAction(signal);
    }
  }

  async function requestDeletion(): Promise<void> {
    if (deletePhrase !== "刪除課堂") return;
    const signal = startAction();
    try {
      const accepted = await gateway.requestRoomDeletion(roomId, { signal });
      if (!actionIsCurrent(signal)) return;
      onDeletionAccepted(accepted);
    } catch (error) {
      if (signal.aborted) return;
      if (routeExpiredSession(error)) return;
      setActionStatus("刪除回應未能確認，正在向伺服器恢復房間的 Deletion Job 狀態。");
      try {
        const recovered = await gateway.getRoomDeletion(roomId, { signal });
        if (!actionIsCurrent(signal)) return;
        onDeletionAccepted(recovered);
        return;
      } catch (recoveryError) {
        if (signal.aborted) return;
        if (routeExpiredSession(recoveryError)) return;
        setActionError("目前無法確認刪除要求是否已提交；課堂操作保持鎖定，系統將只恢復 Deletion Job。");
        onDeletionUncertain?.();
        return;
      }
    }
  }

  async function updateAgentPolicy(enabled: boolean): Promise<void> {
    const signal = startAction();
    try {
      const confirmed = await gateway.setAgentSettings(roomId, { enabled }, { signal });
      if (!actionIsCurrent(signal)) return;
      setAgentPolicy(confirmed.enabled);
      try {
        await runtime.refreshAgentCurrent?.();
      } catch (error) {
        if (signal.aborted) return;
        if (routeExpiredSession(error)) return;
        if (!actionIsCurrent(signal)) return;
        setActionStatus(confirmed.enabled
          ? "伺服器已啟用 Nova 政策，但最新 Agent 狀態暫時無法刷新。"
          : "伺服器已停用 Nova 政策，但最新 Agent 狀態暫時無法刷新。");
        return;
      }
      if (!actionIsCurrent(signal)) return;
      setActionStatus(confirmed.enabled
        ? "伺服器已啟用 Nova 政策；只有真實 Executor 與 RoomEvent 才會產生回覆。"
        : "伺服器已停用 Nova 政策；進行中的 Run 如存在亦由伺服器取消。");
    } catch (error) {
      if (signal.aborted) return;
      if (routeExpiredSession(error)) return;
      setActionError("Nova 政策未更新；目前狀態保持未確認或原值。");
    } finally {
      finishAction(signal);
    }
  }

  return (
    <section className="teacher-control-stack" aria-label="教師監督與治理">
      <section className="orbit-panel teacher-control-card" aria-labelledby="lifecycle-title">
        <header className="panel-head"><div><span className="panel-kicker">Room lifecycle</span><h2 className="panel-title" id="lifecycle-title">課堂控制</h2></div></header>
        <div className="teacher-control-body">
          {lifecycle.length ? lifecycle.map((action) => (
            <button key={action.type} className="teacher-secondary" disabled={!connected || lifecycleAwaiting || commandPending} type="button" onClick={() => {
              try {
                if (!connected) throw new Error("REALTIME_NOT_CONNECTED");
                const commandId = runtime.sendIntent({ type: action.type });
                const targetStatus = action.type === "room.open" || action.type === "room.resume"
                  ? "open" as const
                  : action.type === "room.pause" ? "paused" as const : "closed" as const;
                setLifecycleRequest({ commandId, targetStatus });
                setActionError(undefined);
              } catch {
                setActionError("課堂指令未送出；目前狀態保持不變。");
              }
            }}>{action.label}</button>
          )) : <p>課堂已結束；生命週期控制已停用。</p>}
          {!connected ? <p role="status">WebSocket 尚未連線；課堂生命週期控制保持停用。</p> : null}
          {lifecycleConfirmed ? <p role="status">伺服器 RoomEvent 已確認新的課堂狀態。</p>
            : lifecycleNonRetryableReject ? <p className="composer-error" role="alert">伺服器拒絕課堂指令（{lifecycleReject?.code}）；狀態沒有被本地改寫。</p>
              : lifecycleReject?.retryable === true ? <p role="status">伺服器暫時拒絕課堂指令（{lifecycleReject.code}）；原指令仍在可靠佇列等待重送。</p>
                : lifecycleAwaiting ? <p role="status">{connected ? lifecycleAcknowledged ? "伺服器已 ACK，等待 RoomEvent 確認狀態。" : lifecycleTransportPending ? "指令已進入可靠佇列，等待伺服器 ACK。" : "正在等待伺服器 ACK；控制保持鎖定。" : "連線中斷；指令保留在可靠佇列等待恢復。"}</p>
                : null}
          <div className="invite-state-control">
            <h3>一次性邀請碼</h3>
            <p>Room Code 與四個 Seat Code 只會在建立課堂成功時顯示一次。本房間頁不能恢復或重新顯示任何代碼。</p>
            <p>若尚未分發而代碼已遺失，請結束此課堂並建立新課堂。</p>
          </div>
          <div className="agent-policy-control">
            <h3>Nova 政策</h3>
            <p>{agentPolicy === undefined ? "正在等待伺服器確認 Nova 是否啟用。" : agentPolicy ? "伺服器政策：已啟用。" : "伺服器政策：已停用。"}</p>
            <button className="teacher-secondary" disabled={commandPending || agentPolicy === undefined} onClick={() => void updateAgentPolicy(!(agentPolicy ?? false))} type="button">
              {agentPolicy ? "停用 Nova" : "啟用 Nova"}
            </button>
          </div>
        </div>
      </section>

      <section className="orbit-panel teacher-control-card" aria-labelledby="artifact-title">
        <header className="panel-head"><div><span className="panel-kicker">Artifact Queue</span><h2 className="panel-title" id="artifact-title">分析審閱與修正</h2></div><span className="panel-meta">只讀取伺服器未審閱項目</span></header>
        <div className="teacher-control-body">
          {artifactLoading && artifacts.length === 0 ? <p role="status">正在載入 Artifact Queue…</p> : null}
          {artifactError ? <p role="alert" className="composer-error">{artifactError}</p> : null}
          {artifacts.length ? (
            <ol className="artifact-review-list" aria-label="未審閱 Artifact">
              {artifacts.map((artifact, index) => (
                <li key={artifact.artifactId}>
                  <button type="button" aria-pressed={artifactIndex === index} onClick={() => setArtifactIndex(index)}>
                    <strong>{artifact.sourceModality === "text" ? "文字證據" : artifact.sourceModality === "audio" ? "音訊衍生文字" : "圖片衍生文字"}</strong>
                    <span>{artifact.text}</span>
                    <small>{artifact.languageTag} · {artifact.warnings.length ? `${artifact.warnings.length} 個伺服器警告` : "沒有警告"}</small>
                  </button>
                </li>
              ))}
            </ol>
          ) : !artifactLoading ? <p>目前沒有伺服器回傳的未審閱 Artifact。</p> : null}
          {nextArtifactId ? <button className="teacher-secondary" disabled={artifactLoading} onClick={() => void loadMoreArtifacts()} type="button">載入下一頁</button> : null}

          <fieldset className="teacher-form-grid" disabled={commandPending || !selectedArtifact || !projectionAuthority}>
            <legend>記錄審閱</legend>
            <label>審閱結果<select value={reviewDecision} onChange={(event) => setReviewDecision(event.target.value as typeof reviewDecision)}>{REVIEW_DECISIONS.map((decision) => <option key={decision} value={decision}>{decision}</option>)}</select></label>
            <label>審閱理由<textarea value={rationale} onChange={(event) => setRationale(event.target.value)} maxLength={2000} required /></label>
            <button className="teacher-create" disabled={!rationale.trim()} onClick={() => void submitReview()} type="button">提交審閱</button>
          </fieldset>

          <fieldset className="teacher-form-grid" disabled={commandPending || !projectionAuthority}>
            <legend>記錄 Correction</legend>
            <label>修正分支<select value={correctionKind} onChange={(event) => setCorrectionKind(event.target.value as TeacherCorrectionKind)}>{Object.entries(CORRECTION_LABELS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
            {correctionKind === "replace_text" ? <><label>替換文字<textarea value={replacementText} onChange={(event) => setReplacementText(event.target.value)} maxLength={20000} /></label><label>語言標籤<input value={languageTag} onChange={(event) => setLanguageTag(event.target.value)} /></label></> : null}
            {correctionKind === "replace_evidence_span" ? <>
              <IndexedSelect label="原證據關係" values={edgeOptions} value={edgeIndex} onChange={(value) => { setEdgeIndex(value); setTargetEvidenceIndex(0); }} />
              <IndexedSelect label="原證據片段" values={targetEvidenceOptions} value={targetEvidenceIndex} onChange={setTargetEvidenceIndex} />
              <IndexedSelect label="替換證據關係" values={edgeOptions} value={replacementEdgeIndex} onChange={(value) => { setReplacementEdgeIndex(value); setReplacementEvidenceIndex(0); }} />
              <IndexedSelect label="替換證據片段" values={replacementEvidenceOptions} value={replacementEvidenceIndex} onChange={setReplacementEvidenceIndex} />
            </> : null}
            {correctionKind === "replace_relation" ? <><IndexedSelect label="目標關係" values={edgeOptions} value={edgeIndex} onChange={setEdgeIndex} /><IndexedSelect label="新關係起點" values={nodes.map(({ label }) => label)} value={canonicalIndex} onChange={setCanonicalIndex} /><IndexedSelect label="新關係終點" values={nodes.map(({ label }) => label)} value={aliasIndex} onChange={setAliasIndex} /><label>關係描述<input value={predicate} onChange={(event) => setPredicate(event.target.value)} /></label><label>關係類別<input value={relationFamily} onChange={(event) => setRelationFamily(event.target.value)} /></label></> : null}
            {correctionKind === "merge_alias" || correctionKind === "split_alias" ? <><IndexedSelect label="主要概念" values={nodes.map(({ label }) => label)} value={canonicalIndex} onChange={setCanonicalIndex} /><IndexedSelect label="同義概念" values={nodes.map(({ label }) => label)} value={aliasIndex} onChange={setAliasIndex} /></> : null}
            {correctionKind === "split_alias" ? <><label>新概念鍵<input value={newCanonicalNodeId} onChange={(event) => setNewCanonicalNodeId(event.target.value)} maxLength={160} /></label><label>新概念名稱<input value={newLabel} onChange={(event) => setNewLabel(event.target.value)} maxLength={160} /></label></> : null}
            {correctionKind === "undo_merge" ? <p>{mergeIsEffective ? "伺服器新 Projection 已確認合併生效；現在可撤銷。" : mergeUndoCandidate ? "合併已記錄，等待伺服器新 Projection 確認生效後才可撤銷。" : "本頁尚沒有可撤銷的伺服器合併記錄。"}</p> : null}
            {correctionKind === "retract" ? <label>撤回類型<select value={retractType} onChange={(event) => setRetractType(event.target.value as typeof retractType)}><option value="derived_text">衍生文字</option><option value="evidence">證據</option><option value="projection">概念關係</option></select></label> : null}
            <label>修正理由<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} required /></label>
            <button className="teacher-create" disabled={!correctionCanSubmit} onClick={() => void submitCorrection()} type="button">提交修正</button>
          </fieldset>
          {!projectionAuthority ? <p role="status">等待伺服器 teacher ECHO 的 Analysis Epoch 與 Projection Version；審閱提交保持停用。</p> : null}
        </div>
      </section>

      <section className="orbit-panel teacher-control-card" aria-labelledby="governance-title">
        <header className="panel-head"><div><span className="panel-kicker">Governance</span><h2 className="panel-title" id="governance-title">匯出與刪除</h2></div></header>
        <div className="teacher-control-body">
          <div className="teacher-control-actions"><button className="teacher-secondary" disabled={commandPending} onClick={() => void download("json")} type="button">下載 JSON</button><button className="teacher-secondary" disabled={commandPending} onClick={() => void download("csv")} type="button">下載 CSV</button></div>
          <div className="danger-zone">
            <h3>刪除課堂</h3>
            <p>輸入「刪除課堂」後送出。伺服器會回傳真實 Job 狀態；此頁不會提前宣告完成。</p>
            <label>確認文字<input autoComplete="off" value={deletePhrase} onChange={(event) => setDeletePhrase(event.target.value)} /></label>
            <button className="danger-button" disabled={commandPending || deletePhrase !== "刪除課堂"} onClick={() => void requestDeletion()} type="button">要求刪除</button>
          </div>
        </div>
      </section>

      {actionStatus ? <p className="teacher-action-status" role="status" aria-live="polite">{actionStatus}</p> : null}
      {actionError ? <p ref={actionErrorRef} className="teacher-alert" role="alert" tabIndex={-1}>{actionError}</p> : null}
    </section>
  );
}

function IndexedSelect({ label, values, value, onChange }: Readonly<{
  label: string;
  values: readonly string[];
  value: number;
  onChange(value: number): void;
}>) {
  return (
    <label>{label}<select value={String(value)} onChange={(event) => onChange(Number(event.target.value))}>
      {values.length ? values.map((text, index) => <option key={`${index}:${text}`} value={String(index)}>{text}</option>) : <option value="-1">沒有伺服器目標</option>}
    </select></label>
  );
}
