"use client";

import type { MediaAttachmentView, MediaDownloadGrant, MediaStatusFrame } from "@learning-orbit/contracts";
import React, { useEffect, useRef, useState } from "react";

import { SessionGatewayError } from "../session/session-gateway";
import { mediaMimeEssence, type MediaGateway } from "./media-upload";

type ObjectUrlPort = Readonly<{ create(value: Blob): string; revoke(value: string): void }>;
type AttachmentPhase =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "available"; view: MediaAttachmentView }>
  | Readonly<{ kind: "unavailable" }>;

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const AUDIO_MIME = new Set(["audio/webm", "audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg"]);
const TERMINAL_MEDIA_STATES = new Set<MediaStatusFrame["state"]>(["quarantined", "failed", "deleted"]);
const DEFAULT_OBJECT_URLS: ObjectUrlPort = {
  create: (value) => URL.createObjectURL(value),
  revoke: (value) => URL.revokeObjectURL(value),
};

function safeDownloadUrl(
  grant: MediaDownloadGrant,
  allowedOrigins: readonly string[],
  now: Date,
): URL {
  if (!Number.isFinite(now.getTime()) || Date.parse(grant.expiresAt) <= now.getTime()) {
    throw new Error("MEDIA_DOWNLOAD_GRANT_EXPIRED");
  }
  let url: URL;
  try { url = new URL(grant.downloadUrl); }
  catch { throw new Error("MEDIA_DOWNLOAD_URL_INVALID"); }
  if (url.username || url.password || !allowedOrigins.includes(url.origin)) {
    throw new Error("MEDIA_DOWNLOAD_ORIGIN_REJECTED");
  }
  return url;
}

function safeResponseMime(response: Response, view: MediaAttachmentView): string {
  const mime = mediaMimeEssence(response.headers.get("content-type") ?? "", view.kind);
  if (!mime || mime !== view.detectedMime || !(view.kind === "image" ? IMAGE_MIME : AUDIO_MIME).has(mime)) {
    throw new Error("MEDIA_DETECTED_MIME_INVALID");
  }
  return mime;
}

async function boundedResponseBlob(
  response: Response,
  view: MediaAttachmentView,
  signal: AbortSignal,
): Promise<Blob> {
  if (!response.ok) throw new Error("MEDIA_DOWNLOAD_FAILED");
  const maxBytes = view.kind === "image" ? 10 * 1024 * 1024 : MAX_MEDIA_BYTES;
  if (!Number.isSafeInteger(view.sizeBytes) || view.sizeBytes < 1 || view.sizeBytes > maxBytes) {
    throw new Error("MEDIA_DOWNLOAD_SIZE_INVALID");
  }
  const length = response.headers.get("content-length");
  const expectedLength = length === null ? undefined : Number(length);
  if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(expectedLength)
    || expectedLength !== view.sizeBytes)) {
    throw new Error("MEDIA_DOWNLOAD_LENGTH_MISMATCH");
  }
  const mime = safeResponseMime(response, view);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (bytes.byteLength !== view.sizeBytes) throw new Error("MEDIA_DOWNLOAD_LENGTH_MISMATCH");
    return new Blob([bytes], { type: mime });
  }

  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let received = 0;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > view.sizeBytes) {
        await reader.cancel();
        throw new Error("MEDIA_DOWNLOAD_LENGTH_MISMATCH");
      }
      const copied = new Uint8Array(next.value.byteLength);
      copied.set(next.value);
      chunks.push(copied.buffer);
    }
  } finally {
    reader.releaseLock();
  }
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (received !== view.sizeBytes) throw new Error("MEDIA_DOWNLOAD_LENGTH_MISMATCH");
  return new Blob(chunks, { type: mime });
}

function stateCopy(view: MediaAttachmentView): string {
  if (view.state === "upload_pending" || view.state === "uploaded") {
    return "媒體已登記，但伺服器尚未完成處理；尚未可播放或下載。";
  }
  if (view.state === "processing") return "媒體仍在伺服器處理中；尚未可播放或下載，也沒有轉寫。";
  if (view.state === "quarantined") return "媒體未通過安全檢查，不能開啟。";
  if (view.state === "failed") return "媒體處理失敗；文字課堂仍可使用。";
  if (view.state === "deleted") return "媒體已刪除。";
  return "媒體已由伺服器確認可載入。";
}

export interface MediaAttachmentProps {
  roomId: string;
  mediaId: string;
  gateway: MediaGateway;
  allowedDownloadOrigins: readonly string[];
  liveStatus?: MediaStatusFrame;
  fetch?: typeof globalThis.fetch;
  objectUrls?: ObjectUrlPort;
  now?: () => Date;
}

export function MediaAttachment({
  roomId,
  mediaId,
  gateway,
  allowedDownloadOrigins,
  liveStatus,
  fetch: fetcher = globalThis.fetch,
  objectUrls = DEFAULT_OBJECT_URLS,
  now = () => new Date(),
}: Readonly<MediaAttachmentProps>) {
  const metadataToken = useRef(0);
  const downloadToken = useRef(0);
  const downloadAbort = useRef<AbortController | undefined>(undefined);
  const localUrlRef = useRef<string | undefined>(undefined);
  const [attachment, setAttachment] = useState<AttachmentPhase>({ kind: "loading" });
  const [localUrl, setLocalUrl] = useState<string>();
  const [downloadState, setDownloadState] = useState<"idle" | "loading" | "failed">("idle");

  function releaseLocalUrl() {
    if (localUrlRef.current) objectUrls.revoke(localUrlRef.current);
    localUrlRef.current = undefined;
    setLocalUrl(undefined);
  }

  useEffect(() => {
    const token = ++metadataToken.current;
    const controller = new AbortController();
    setAttachment({ kind: "loading" });
    void gateway.getMedia(roomId, mediaId).then((received) => {
      if (controller.signal.aborted || token !== metadataToken.current) return;
      if (received.mediaId !== mediaId) throw new Error("MEDIA_ID_MISMATCH");
      // A realtime status is a refresh hint, not enough evidence to upgrade
      // bytes to ready. Terminal frames may only make the view more restrictive.
      const merged = liveStatus?.mediaId === mediaId
        && TERMINAL_MEDIA_STATES.has(liveStatus.state)
        && Date.parse(liveStatus.updatedAt) >= Date.parse(received.updatedAt)
        ? { ...received, state: liveStatus.state, failureCode: liveStatus.failureCode, updatedAt: liveStatus.updatedAt }
        : received;
      setAttachment({ kind: "available", view: merged });
    }).catch(() => {
      if (!controller.signal.aborted && token === metadataToken.current) setAttachment({ kind: "unavailable" });
    });
    return () => controller.abort();
  }, [gateway, liveStatus?.mediaId, liveStatus?.state, liveStatus?.updatedAt, mediaId, roomId]);

  useEffect(() => {
    if (liveStatus?.mediaId !== mediaId || !TERMINAL_MEDIA_STATES.has(liveStatus.state)) return;
    // Terminal server status must invalidate already-loaded bytes immediately;
    // the metadata GET running in parallel only supplies the durable view.
    downloadAbort.current?.abort();
    downloadToken.current += 1;
    releaseLocalUrl();
    setDownloadState("idle");
    setAttachment((current) => current.kind === "available"
      ? { kind: "available", view: { ...current.view, state: liveStatus.state, failureCode: liveStatus.failureCode, updatedAt: liveStatus.updatedAt } }
      : current);
    // `objectUrls` is an attachment-lifetime port.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveStatus?.mediaId, liveStatus?.state, liveStatus?.updatedAt, mediaId]);

  useEffect(() => {
    downloadAbort.current?.abort();
    downloadToken.current += 1;
    releaseLocalUrl();
    setDownloadState("idle");
    // Object URL ownership changes only when the authoritative media identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId, roomId]);

  useEffect(() => {
    if (attachment.kind === "unavailable" || (attachment.kind === "available" && attachment.view.state !== "ready")) {
      downloadAbort.current?.abort();
      downloadToken.current += 1;
      releaseLocalUrl();
      setDownloadState("idle");
    }
    // `objectUrls` is a test/adapter port and must remain stable for an attachment lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachment.kind, attachment.kind === "available" ? attachment.view.state : undefined]);

  useEffect(() => () => {
    metadataToken.current += 1;
    downloadToken.current += 1;
    downloadAbort.current?.abort();
    if (localUrlRef.current) objectUrls.revoke(localUrlRef.current);
    localUrlRef.current = undefined;
  }, [objectUrls]);

  async function loadReadyAttachment(view: MediaAttachmentView) {
    if (view.state !== "ready" || allowedDownloadOrigins.length === 0 || typeof fetcher !== "function") return;
    const token = ++downloadToken.current;
    downloadAbort.current?.abort();
    const controller = new AbortController();
    downloadAbort.current = controller;
    releaseLocalUrl();
    setDownloadState("loading");
    try {
      const grant = await gateway.getMediaDownloadGrant(roomId, mediaId);
      if (controller.signal.aborted || token !== downloadToken.current) return;
      const url = safeDownloadUrl(grant, allowedDownloadOrigins, now());
      const response = await fetcher(url.href, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (response.redirected || (response.url && !allowedDownloadOrigins.includes(new URL(response.url).origin))) {
        throw new Error("MEDIA_DOWNLOAD_REDIRECT_REJECTED");
      }
      const blob = await boundedResponseBlob(response, view, controller.signal);
      if (controller.signal.aborted || token !== downloadToken.current) return;
      const nextUrl = objectUrls.create(blob);
      if (controller.signal.aborted || token !== downloadToken.current) {
        objectUrls.revoke(nextUrl);
        return;
      }
      localUrlRef.current = nextUrl;
      setLocalUrl(nextUrl);
      setDownloadState("idle");
    } catch (error) {
      if (controller.signal.aborted || token !== downloadToken.current) return;
      setDownloadState("failed");
      if (error instanceof SessionGatewayError && error.code === "AUTH_REQUIRED") return;
    }
  }

  if (attachment.kind === "loading") return <p className="media-caption" role="status">正在向伺服器確認附件…</p>;
  if (attachment.kind === "unavailable") return <p className="media-caption" role="status">附件目前不可用；沒有載入模擬媒體。</p>;

  const view = attachment.view;
  const ready = view.state === "ready";
  return (
    <section className="attachment-preview" aria-label={`${view.kind === "image" ? "圖片" : "音訊"}附件`}>
      {view.caption ? <p>{view.caption}</p> : null}
      <p className="media-caption" role="status">{stateCopy(view)}</p>
      {ready && allowedDownloadOrigins.length === 0 ? (
        <p className="media-caption">媒體 Provider 未配置；文字內容仍可使用。</p>
      ) : null}
      {ready && !localUrl && allowedDownloadOrigins.length > 0 ? (
        <button
          className="tiny-action"
          type="button"
          disabled={downloadState === "loading"}
          onClick={() => void loadReadyAttachment(view)}
        >{downloadState === "loading" ? "正在安全載入…" : `載入${view.kind === "image" ? "圖片" : "音訊"}附件`}</button>
      ) : null}
      {downloadState === "failed" ? <p className="composer-error" role="alert">附件未能安全載入；沒有顯示遠端網址或假成功狀態。</p> : null}
      {localUrl && view.kind === "image" ? <img src={localUrl} alt={view.altText ?? "課堂圖片附件"} /> : null}
      {localUrl && view.kind === "audio" ? (
        <div>
          <audio controls preload="metadata" src={localUrl}>瀏覽器不支援這個音訊附件。</audio>
          <p className="media-caption">伺服器確認的音訊；沒有產生或顯示轉寫。</p>
        </div>
      ) : null}
    </section>
  );
}
