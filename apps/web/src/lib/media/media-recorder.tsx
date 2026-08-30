"use client";

import React, { useEffect, useRef, useState } from "react";

import { SessionGatewayError } from "../session/session-gateway";
import type { SessionStatus } from "../session/session-store";
import {
  mediaMimeEssence,
  uploadMediaFile,
  type MediaGateway,
  type MediaUploadResult,
} from "./media-upload";

export interface MediaDevicesPort {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface MediaRecorderPort {
  readonly mimeType: string;
  readonly state: RecordingState;
  ondataavailable: ((event: Readonly<{ data: Blob }>) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(timesliceMs?: number): void;
  stop(): void;
}

export type MediaRecorderFactory = (stream: MediaStream) => MediaRecorderPort;
export type RecordedAudioUpload = typeof uploadMediaFile;

export interface RecordingObjectUrlPort {
  create(value: Blob): string;
  revoke(value: string): void;
}

export interface MediaRecorderControlProps {
  roomId: string;
  gateway: MediaGateway;
  allowedUploadOrigins: readonly string[];
  onReady(mediaId: string): void;
  upload?: RecordedAudioUpload;
  mediaDevices?: MediaDevicesPort | null;
  recorderFactory?: MediaRecorderFactory | null;
  objectUrls?: RecordingObjectUrlPort;
  maxRecordingMs?: number;
  stopWatchdogMs?: number;
  roomStatus?: SessionStatus;
}

type RecorderPhase =
  | "checking"
  | "disabled"
  | "unsupported"
  | "idle"
  | "requesting"
  | "recording"
  | "stopping"
  | "recorded"
  | "uploading"
  | "processing"
  | "ready"
  | "denied"
  | "failed";

type RecorderSession = {
  token: number;
  stream: MediaStream;
  recorder: MediaRecorderPort;
  chunks: Blob[];
  chunkBytes: number;
  recordingTimer: ReturnType<typeof setTimeout> | undefined;
  stopTimer: ReturnType<typeof setTimeout> | undefined;
};

type LocalRecording = Readonly<{ blob: Blob; localUrl: string }>;

const defaultObjectUrls: RecordingObjectUrlPort = {
  create: (value) => URL.createObjectURL(value),
  revoke: (value) => URL.revokeObjectURL(value),
};
const MAX_RECORDING_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_RECORDING_MS = 120_000;
const DEFAULT_STOP_WATCHDOG_MS = 3_000;
const RECORDER_TIMESLICE_MS = 1_000;

function browserMediaDevices(): MediaDevicesPort | null {
  if (typeof navigator === "undefined"
    || typeof navigator.mediaDevices?.getUserMedia !== "function") return null;
  return navigator.mediaDevices;
}

export function browserRecorderFactory(): MediaRecorderFactory | null {
  if (typeof globalThis.MediaRecorder !== "function") return null;
  return (stream) => {
    const recorder = new globalThis.MediaRecorder(stream);
    const port: MediaRecorderPort = {
      get mimeType() { return recorder.mimeType; },
      get state() { return recorder.state; },
      ondataavailable: null,
      onstop: null,
      onerror: null,
      start: (timesliceMs) => timesliceMs === undefined ? recorder.start() : recorder.start(timesliceMs),
      stop: () => recorder.stop(),
    };
    recorder.ondataavailable = (event) => port.ondataavailable?.({ data: event.data });
    recorder.onstop = () => port.onstop?.();
    recorder.onerror = () => port.onerror?.();
    return port;
  };
}

function errorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error
    && typeof error.name === "string") return error.name;
  return "";
}

function recordingFile(blob: Blob): File {
  const mime = mediaMimeEssence(blob.type || "audio/webm", "audio");
  if (!mime) throw new Error("RECORDER_MIME_UNSUPPORTED");
  const extension = mime === "audio/ogg" ? "ogg"
    : mime === "audio/mp4" ? "m4a"
      : mime === "audio/wav" ? "wav"
        : mime === "audio/mpeg" ? "mp3" : "webm";
  return new File([blob], `learning-orbit-recording.${extension}`, {
    type: mime,
  });
}

export function MediaRecorderControl({
  roomId,
  gateway,
  allowedUploadOrigins,
  onReady,
  upload = uploadMediaFile,
  mediaDevices,
  recorderFactory,
  objectUrls = defaultObjectUrls,
  maxRecordingMs = DEFAULT_MAX_RECORDING_MS,
  stopWatchdogMs = DEFAULT_STOP_WATCHDOG_MS,
  roomStatus = "open",
}: Readonly<MediaRecorderControlProps>) {
  const devicesRef = useRef<MediaDevicesPort | null>(null);
  const recorderFactoryRef = useRef<MediaRecorderFactory | null>(null);
  const supportedRef = useRef(false);
  const mountedRef = useRef(false);
  const tokenRef = useRef(0);
  const sessionRef = useRef<RecorderSession | undefined>(undefined);
  const recordingRef = useRef<LocalRecording | undefined>(undefined);
  const uploadAbortRef = useRef<AbortController | undefined>(undefined);
  const stoppedTracksRef = useRef(new WeakSet<MediaStreamTrack>());
  const [phase, setPhase] = useState<RecorderPhase>("checking");
  const [recording, setRecording] = useState<LocalRecording | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  function stopStream(stream: MediaStream) {
    for (const track of stream.getTracks()) {
      if (stoppedTracksRef.current.has(track)) continue;
      stoppedTracksRef.current.add(track);
      try { track.stop(); } catch { /* continue clearing the remaining tracks */ }
    }
  }

  function clearSessionTimers(session: RecorderSession) {
    if (session.recordingTimer) clearTimeout(session.recordingTimer);
    if (session.stopTimer) clearTimeout(session.stopTimer);
    session.recordingTimer = undefined;
    session.stopTimer = undefined;
  }

  function revokeRecording() {
    const current = recordingRef.current;
    recordingRef.current = undefined;
    if (current) objectUrls.revoke(current.localUrl);
  }

  function discardSession() {
    const session = sessionRef.current;
    sessionRef.current = undefined;
    if (!session) return;
    clearSessionTimers(session);
    session.recorder.ondataavailable = null;
    session.recorder.onstop = null;
    session.recorder.onerror = null;
    try {
      if (session.recorder.state !== "inactive") session.recorder.stop();
    } finally {
      stopStream(session.stream);
    }
  }

  function releaseResources() {
    tokenRef.current += 1;
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = undefined;
    discardSession();
    revokeRecording();
  }

  function clearRecording() {
    releaseResources();
    setRecording(undefined);
    setError(undefined);
    setPhase(roomStatus === "open" ? (supportedRef.current ? "idle" : "unsupported") : "disabled");
  }

  useEffect(() => {
    mountedRef.current = true;
    devicesRef.current = mediaDevices === undefined ? browserMediaDevices() : mediaDevices;
    recorderFactoryRef.current = recorderFactory === undefined ? browserRecorderFactory() : recorderFactory;
    supportedRef.current = Boolean(devicesRef.current && recorderFactoryRef.current);
    if (roomStatus !== "open") {
      setRecording(undefined);
      setError(undefined);
      setPhase("disabled");
    } else {
      setPhase(supportedRef.current ? "idle" : "unsupported");
    }
    return () => {
      mountedRef.current = false;
      releaseResources();
    };
  }, [mediaDevices, recorderFactory, roomStatus]);

  function failStart(errorValue: unknown, stream: MediaStream | undefined, token: number) {
    if (stream) stopStream(stream);
    if (!mountedRef.current || token !== tokenRef.current) return;
    const name = errorName(errorValue);
    if (name === "NotAllowedError" || name === "SecurityError") {
      setPhase("denied");
      setError("未取得麥克風權限；你可以調整瀏覽器權限，或改用本地音訊檔案／文字聊天。");
      return;
    }
    if (name === "NotSupportedError") {
      supportedRef.current = false;
      setPhase("unsupported");
      setError(undefined);
      return;
    }
    setPhase("failed");
    setError("麥克風目前無法使用；沒有建立錄音或媒體項目。你可以重試或改用文字聊天。");
  }

  function finishSession(session: RecorderSession) {
    const current = sessionRef.current;
    const valid = mountedRef.current
      && tokenRef.current === session.token
      && current === session;
    if (current === session) sessionRef.current = undefined;
    session.recorder.ondataavailable = null;
    session.recorder.onstop = null;
    session.recorder.onerror = null;
    clearSessionTimers(session);
    stopStream(session.stream);
    if (!valid) return;
    if (session.chunkBytes < 1 || session.chunkBytes > MAX_RECORDING_BYTES) {
      setPhase("failed");
      setError("錄音大小超出安全上限；沒有建立預覽或向伺服器提出上傳。");
      return;
    }
    const mime = mediaMimeEssence(
      session.recorder.mimeType || session.chunks.find((chunk) => chunk.type)?.type || "audio/webm",
      "audio",
    );
    if (!mime) {
      setPhase("failed");
      setError("錄音格式不受支援；沒有建立預覽或向伺服器提出上傳。");
      return;
    }
    const blob = new Blob(session.chunks, { type: mime });
    if (blob.size === 0 || blob.size !== session.chunkBytes || blob.size > MAX_RECORDING_BYTES) {
      setPhase("failed");
      setError("錄音沒有可用內容；沒有向伺服器提出上傳。");
      return;
    }
    try {
      revokeRecording();
      const next = { blob, localUrl: objectUrls.create(blob) };
      recordingRef.current = next;
      setRecording(next);
      setError(undefined);
      setPhase("recorded");
    } catch {
      setPhase("failed");
      setError("無法建立本地錄音預覽；沒有向伺服器提出上傳。");
    }
  }

  async function startRecording() {
    const devices = devicesRef.current;
    const createRecorder = recorderFactoryRef.current;
    if (roomStatus !== "open" || !devices || !createRecorder
      || ["checking", "disabled", "requesting", "recording", "stopping", "uploading"].includes(phase)) return;
    releaseResources();
    setRecording(undefined);
    setError(undefined);
    const token = ++tokenRef.current;
    setPhase("requesting");
    let stream: MediaStream | undefined;
    try {
      stream = await devices.getUserMedia({ audio: true });
      if (!mountedRef.current || token !== tokenRef.current) {
        stopStream(stream);
        return;
      }
      const recorder = createRecorder(stream);
      const session: RecorderSession = {
        token, stream, recorder, chunks: [], chunkBytes: 0, recordingTimer: undefined, stopTimer: undefined,
      };
      recorder.ondataavailable = (event) => {
        if (event.data.size < 1 || sessionRef.current !== session || tokenRef.current !== token) return;
        if (session.chunkBytes + event.data.size > MAX_RECORDING_BYTES) {
          tokenRef.current += 1;
          discardSession();
          if (mountedRef.current) {
            setPhase("failed");
            setError("錄音大小超出安全上限；沒有建立預覽或向伺服器提出上傳。");
          }
          return;
        }
        session.chunkBytes += event.data.size;
        session.chunks.push(event.data);
      };
      recorder.onstop = () => finishSession(session);
      recorder.onerror = () => {
        if (sessionRef.current !== session || tokenRef.current !== token) return;
        tokenRef.current += 1;
        discardSession();
        if (!mountedRef.current) return;
        setPhase("failed");
        setError("錄音裝置已中斷；沒有建立媒體項目。你可以重試或改用文字聊天。");
      };
      sessionRef.current = session;
      session.recordingTimer = setTimeout(() => {
        if (sessionRef.current !== session || tokenRef.current !== token) return;
        tokenRef.current += 1;
        discardSession();
        if (mountedRef.current) {
          setPhase("failed");
          setError("錄音已達 2 分鐘安全上限並停止；沒有建立媒體項目。");
        }
      }, maxRecordingMs);
      recorder.start(RECORDER_TIMESLICE_MS);
      if (mountedRef.current && tokenRef.current === token) setPhase("recording");
    } catch (startError) {
      if (sessionRef.current?.token === token) sessionRef.current = undefined;
      failStart(startError, stream, token);
    }
  }

  function stopRecording() {
    const session = sessionRef.current;
    if (!session || session.token !== tokenRef.current) return;
    setPhase("stopping");
    try {
      if (session.recorder.state === "inactive") finishSession(session);
      else {
        if (session.recordingTimer) clearTimeout(session.recordingTimer);
        session.recordingTimer = undefined;
        session.stopTimer = setTimeout(() => {
          if (sessionRef.current !== session || tokenRef.current !== session.token) return;
          tokenRef.current += 1;
          discardSession();
          if (mountedRef.current) {
            setPhase("failed");
            setError("錄音裝置未能完成停止；已關閉麥克風，沒有建立媒體項目。");
          }
        }, stopWatchdogMs);
        session.recorder.stop();
      }
    } catch (stopError) {
      sessionRef.current = undefined;
      stopStream(session.stream);
      failStart(stopError, undefined, session.token);
    }
  }

  async function uploadRecording() {
    const current = recordingRef.current;
    if (roomStatus !== "open" || !current || phase === "uploading" || allowedUploadOrigins.length === 0) return;
    const token = tokenRef.current;
    const controller = new AbortController();
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = controller;
    setError(undefined);
    setPhase("uploading");
    try {
      const result: MediaUploadResult = await upload({
        roomId,
        file: recordingFile(current.blob),
        kind: "audio",
        altText: null,
        caption: null,
        gateway,
        allowedUploadOrigins,
        signal: controller.signal,
      });
      if (!mountedRef.current || token !== tokenRef.current || controller.signal.aborted) return;
      revokeRecording();
      setRecording(undefined);
      onReady(result.mediaId);
      if (!mountedRef.current || token !== tokenRef.current || controller.signal.aborted) return;
      setPhase(result.state === "ready" ? "ready" : "processing");
    } catch (uploadError) {
      if (!mountedRef.current || token !== tokenRef.current || controller.signal.aborted) return;
      setPhase("failed");
      if (uploadError instanceof SessionGatewayError && uploadError.code === "MEDIA_SERVICE_UNAVAILABLE") {
        setError("媒體 Provider 目前不可用；錄音沒有附加，文字聊天仍可使用。");
      } else if (uploadError instanceof Error && uploadError.message === "MEDIA_ATTACHMENT_LIMIT") {
        setError("每則訊息最多可保留 4 個媒體項目；請先送出或移除現有項目。");
      } else {
        setError("錄音未獲伺服器確認，因此不會附加到訊息。你可以重試或只使用文字聊天。");
      }
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = undefined;
    }
  }

  const status = phase === "disabled" ? "課堂目前不是進行中；麥克風、錄音預覽與上傳已停止。"
    : phase === "checking" ? "正在檢查瀏覽器錄音能力…"
    : phase === "unsupported" ? "此瀏覽器不支援音訊錄製；可改用本地音訊檔案或文字聊天。"
    : phase === "requesting" ? "正在請求麥克風權限…"
      : phase === "recording" ? "正在錄音；音訊只保留在目前瀏覽器，尚未上傳。"
        : phase === "stopping" ? "正在停止錄音並整理本地音訊…"
          : phase === "recorded" && allowedUploadOrigins.length === 0 ? "錄音已在本機準備好；媒體 Provider 目前不可用，文字聊天仍可使用。"
            : phase === "recorded" ? "錄音已在本機準備好；尚未上傳，也沒有產生轉寫。"
              : phase === "uploading" ? "正在取得 Grant、上傳並等待伺服器 Complete…"
                : phase === "processing" ? "伺服器已確認錄音可附加；媒體處理尚未完成，沒有顯示轉寫。"
                  : phase === "ready" ? "伺服器已確認錄音可附加。"
                    : phase === "denied" ? "麥克風權限未提供；沒有建立錄音。"
                      : phase === "failed" ? "錄音尚未獲得可附加的伺服器確認。"
                        : "尚未錄音；錄音只會先保留在本機。";
  const canUpload = Boolean(recording)
    && roomStatus === "open"
    && phase !== "uploading" && phase !== "processing" && phase !== "ready"
    && allowedUploadOrigins.length > 0;

  return (
    <section
      className="media-card"
      aria-label="錄製音訊"
      aria-busy={["requesting", "stopping", "uploading"].includes(phase)}
      data-async-slot="audio-recording"
    >
      <div className="composer-row">
        {!recording && !sessionRef.current && phase !== "requesting" ? (
          <button
            className="icon-button"
            type="button"
            disabled={!supportedRef.current || roomStatus !== "open"}
            onClick={() => void startRecording()}
          >開始錄音</button>
        ) : null}
        {phase === "requesting" ? (
          <button className="icon-button" type="button" onClick={clearRecording}>取消錄音請求</button>
        ) : null}
        {phase === "recording" || phase === "stopping" ? (
          <>
            <button
              className="icon-button is-recording"
              type="button"
              disabled={phase === "stopping"}
              onClick={stopRecording}
            >停止錄音</button>
            <button className="icon-button" type="button" onClick={clearRecording}>取消並清除錄音</button>
          </>
        ) : null}
        {recording ? <button className="icon-button" type="button" onClick={clearRecording}>清除錄音</button> : null}
      </div>
      {recording ? (
        <div className="local-media">
          <audio aria-label="本地錄音預覽" controls src={recording.localUrl}>
            瀏覽器不支援本地音訊預覽。
          </audio>
          <p>本地錄音預覽；尚未產生或顯示轉寫。</p>
        </div>
      ) : null}
      <p role="status" className="media-caption">{status}</p>
      {error ? <p role="alert" className="composer-error">{error}</p> : null}
      {recording && phase !== "processing" && phase !== "ready" ? (
        <button
          className="send-button"
          type="button"
          disabled={!canUpload}
          onClick={() => void uploadRecording()}
        >上傳錄音並由伺服器確認</button>
      ) : null}
    </section>
  );
}
