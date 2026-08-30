"use client";

import React, { useEffect, useRef, useState } from "react";

import { SessionGatewayError } from "../session/session-gateway";
import type { SessionStatus } from "../session/session-store";
import { mediaMimeEssence, uploadMediaFile, type MediaGateway, type MediaUploadResult, type UploadableMediaKind } from "./media-upload";

type SelectedMedia = Readonly<{ file: File; kind: UploadableMediaKind; localUrl: string }>;
export type ObjectUrlPort = Readonly<{ create(value: Blob): string; revoke(value: string): void }>;
export type MediaUploadFunction = typeof uploadMediaFile;

const ACCEPT = "image/png,image/jpeg,image/webp,audio/webm,audio/mpeg,audio/mp4,audio/wav,audio/ogg";

function mediaKind(file: File): UploadableMediaKind | null {
  if (mediaMimeEssence(file.type, "image")) return "image";
  if (mediaMimeEssence(file.type, "audio")) return "audio";
  return null;
}

export interface MediaComposerProps {
  roomId: string;
  gateway: MediaGateway;
  allowedUploadOrigins: readonly string[];
  mediaIds: readonly string[];
  onReady(mediaId: string): void;
  onRemoveReady?(mediaId: string): void;
  resetGeneration?: number;
  submittedMediaIds?: readonly string[];
  roomStatus?: SessionStatus;
  upload?: MediaUploadFunction;
  objectUrls?: ObjectUrlPort;
}

export function MediaComposer({
  roomId,
  gateway,
  allowedUploadOrigins,
  mediaIds,
  onReady,
  onRemoveReady = () => undefined,
  resetGeneration = 0,
  submittedMediaIds = [],
  roomStatus = "open",
  upload = uploadMediaFile,
  objectUrls = { create: (value) => URL.createObjectURL(value), revoke: (value) => URL.revokeObjectURL(value) },
}: Readonly<MediaComposerProps>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef(0);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const urlRef = useRef<string | undefined>(undefined);
  const completedMediaIdRef = useRef<string | undefined>(undefined);
  const resetGenerationRef = useRef(resetGeneration);
  const [selected, setSelected] = useState<SelectedMedia>();
  const [altText, setAltText] = useState("");
  const [caption, setCaption] = useState("");
  const [phase, setPhase] = useState<"idle" | "uploading" | "processing" | "ready" | "unavailable" | "failed">("idle");
  const [error, setError] = useState<string>();

  function releaseLocal() {
    abortRef.current?.abort();
    abortRef.current = undefined;
    tokenRef.current += 1;
    if (urlRef.current) objectUrls.revoke(urlRef.current);
    urlRef.current = undefined;
    completedMediaIdRef.current = undefined;
  }

  function reset() {
    releaseLocal();
    setSelected(undefined);
    setAltText("");
    setCaption("");
    setPhase("idle");
    setError(undefined);
    if (inputRef.current) inputRef.current.value = "";
  }

  useEffect(() => () => releaseLocal(), []);

  useEffect(() => {
    if (resetGenerationRef.current === resetGeneration) return;
    resetGenerationRef.current = resetGeneration;
    if (completedMediaIdRef.current && submittedMediaIds.includes(completedMediaIdRef.current)) reset();
    // Reset is intentionally keyed by the parent's opaque submission generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetGeneration, submittedMediaIds]);

  useEffect(() => {
    if (roomStatus !== "open") reset();
    // Status transitions revoke preview/upload resources but preserve the
    // parent-owned UUIDs that already passed Complete.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomStatus]);

  function select(file: File | undefined) {
    if (roomStatus !== "open") return;
    releaseLocal();
    setError(undefined);
    setPhase("idle");
    setAltText("");
    setCaption("");
    completedMediaIdRef.current = undefined;
    if (!file) { setSelected(undefined); return; }
    const kind = mediaKind(file);
    if (!kind || file.size < 1 || file.size > (kind === "image" ? 10 * 1024 * 1024 : 25 * 1024 * 1024)) {
      setSelected(undefined);
      setError("檔案類型或大小不符合媒體規則；沒有向伺服器提出上傳。");
      return;
    }
    const localUrl = objectUrls.create(file);
    urlRef.current = localUrl;
    setSelected({ file, kind, localUrl });
  }

  async function beginUpload() {
    if (roomStatus !== "open" || !selected || mediaIds.length >= 4 || allowedUploadOrigins.length === 0
      || (selected.kind === "image" && !altText.trim())) return;
    const token = ++tokenRef.current;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setPhase("uploading");
    setError(undefined);
    try {
      const result: MediaUploadResult = await upload({
        roomId,
        file: selected.file,
        kind: selected.kind,
        altText: selected.kind === "image" ? altText : null,
        caption,
        gateway,
        allowedUploadOrigins,
        signal: controller.signal,
      });
      if (token !== tokenRef.current || controller.signal.aborted) return;
      completedMediaIdRef.current = result.mediaId;
      onReady(result.mediaId);
      setPhase(result.state === "ready" ? "ready" : "processing");
    } catch (uploadError) {
      if (token !== tokenRef.current || controller.signal.aborted) return;
      if (uploadError instanceof SessionGatewayError && uploadError.code === "MEDIA_SERVICE_UNAVAILABLE") {
        setPhase("unavailable");
        return;
      }
      if (uploadError instanceof Error && uploadError.message === "MEDIA_ATTACHMENT_LIMIT") {
        setPhase("failed");
        setError("每則訊息最多可保留 4 個媒體項目；請先送出或移除現有項目。");
        return;
      }
      setPhase("failed");
      setError("媒體未獲伺服器確認，因此不會附加到訊息。你可以重試或只使用文字聊天。");
    }
  }

  const uploadDisabled = roomStatus !== "open" || !selected || mediaIds.length >= 4 || allowedUploadOrigins.length === 0
    || phase === "uploading" || phase === "processing" || phase === "ready"
    || (selected.kind === "image" && !altText.trim());
  const status = roomStatus !== "open" ? "課堂目前不是進行中；媒體選取與上傳已停止，已 Complete 的附件識別仍由訊息草稿保留。"
    : phase === "uploading" ? "正在取得 Grant、上傳並等待伺服器 Complete…"
    : phase === "processing" ? "伺服器已確認上傳；處理尚未完成，不會顯示遠端成功或轉寫。"
      : phase === "ready" ? "伺服器已確認媒體可附加。"
        : phase === "unavailable" || allowedUploadOrigins.length === 0 ? "媒體 Provider 目前不可用；文字聊天仍可使用。"
          : selected ? "目前只顯示本地預覽；尚未上傳。" : "可先選擇本地圖片或音訊；本地預覽不代表上傳成功。";

  return (
    <section className="media-card" aria-label="訊息媒體" aria-busy={phase === "uploading"} data-async-slot="media-upload">
      <div className="composer-row">
        <button className="icon-button" type="button" disabled={roomStatus !== "open"} onClick={() => inputRef.current?.click()}>選擇本地媒體</button>
        <input
          className="sr-only"
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          aria-label="本地媒體檔案"
          disabled={roomStatus !== "open"}
          onChange={(event) => select(event.target.files?.[0])}
        />
        {selected ? <button className="icon-button" type="button" onClick={reset}>清除本地媒體</button> : null}
      </div>
      {selected?.kind === "image" ? (
        <div className="local-media">
          {/* The blob URL is local-only and is revoked on reset/replacement/unmount. */}
          <img src={selected.localUrl} alt={altText || "本地圖片預覽（尚未填寫替代文字）"} />
          <label>圖片替代文字<input value={altText} maxLength={500} onChange={(event) => setAltText(event.target.value)} /></label>
        </div>
      ) : null}
      {selected?.kind === "audio" ? (
        <div className="local-media">
          <audio controls src={selected.localUrl}>瀏覽器不支援本地音訊預覽。</audio>
          <p>本地音訊預覽；沒有產生或顯示轉寫。</p>
        </div>
      ) : null}
      {selected ? <label>媒體說明（可選）<input value={caption} maxLength={1000} onChange={(event) => setCaption(event.target.value)} /></label> : null}
      <p role="status" className="media-caption">{status}</p>
      {error ? <p role="alert" className="composer-error">{error}</p> : null}
      {selected ? <button className="send-button" type="button" disabled={uploadDisabled} onClick={() => void beginUpload()}>上傳並由伺服器確認</button> : null}
      {mediaIds.length ? (
        <div className="attachment-preview">
          <p>{mediaIds.length} 個媒體項目已通過 Complete，可隨訊息送出；不代表處理或轉寫完成。</p>
          {mediaIds.map((mediaId, index) => (
            <button className="tiny-action" disabled={roomStatus !== "open"} key={mediaId} type="button" onClick={() => {
              onRemoveReady(mediaId);
              if (completedMediaIdRef.current === mediaId) reset();
            }}>移除媒體項目 {index + 1}</button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
