import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserRecorderFactory,
  MediaRecorderControl,
  type MediaRecorderPort,
  type RecordedAudioUpload,
} from "./media-recorder.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const MEDIA_ID = "00000000-0000-4000-8000-000000000702";
const gateway = {
  createMediaUpload: vi.fn(),
  completeMediaUpload: vi.fn(),
  getMedia: vi.fn(),
  getMediaDownloadGrant: vi.fn(),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeStream() {
  const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

class FakeRecorder implements MediaRecorderPort {
  readonly mimeType: string;
  state: RecordingState = "inactive";
  ondataavailable: ((event: Readonly<{ data: Blob }>) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(mimeType = "audio/webm") { this.mimeType = mimeType; }

  readonly start = vi.fn((_timesliceMs?: number) => { this.state = "recording"; });
  readonly stop = vi.fn(() => {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["recorded voice"], { type: this.mimeType }) });
    this.onstop?.();
  });
}

const uploadOrigins = ["https://storage.learning-orbit.test"];

describe("honest audio recording", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows an explicit unsupported state without requesting a microphone", () => {
    const onReady = vi.fn();
    render(
      <MediaRecorderControl
        roomId={ROOM_ID}
        gateway={gateway}
        allowedUploadOrigins={uploadOrigins}
        onReady={onReady}
        mediaDevices={null}
        recorderFactory={null}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("此瀏覽器不支援音訊錄製");
    expect(screen.getByRole("button", { name: "開始錄音" })).toBeDisabled();
    expect(onReady).not.toHaveBeenCalled();
  });

  it("uses the same checking markup for server render and hydration before browser capability detection", async () => {
    const { stream } = fakeStream();
    const props = {
      roomId: ROOM_ID,
      gateway,
      allowedUploadOrigins: uploadOrigins,
      onReady: vi.fn(),
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
      recorderFactory: () => new FakeRecorder(),
    };
    const html = renderToString(<MediaRecorderControl {...props} />);
    expect(html).toContain("正在檢查瀏覽器錄音能力");
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const hydrationError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const root = hydrateRoot(container, <MediaRecorderControl {...props} />);
    await act(async () => undefined);
    expect(container.textContent).toContain("尚未錄音");
    expect(hydrationError).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    container.remove();
  });

  it("forwards the one-second timeslice through the real browser adapter", () => {
    const nativeStart = vi.fn();
    class NativeRecorder {
      readonly mimeType = "audio/webm;codecs=opus";
      readonly state: RecordingState = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      readonly start = nativeStart;
      readonly stop = vi.fn();
    }
    vi.stubGlobal("MediaRecorder", NativeRecorder);
    const { stream } = fakeStream();
    const port = browserRecorderFactory()?.(stream);
    expect(port).not.toBeNull();
    port?.start(1_000);
    expect(nativeStart).toHaveBeenCalledWith(1_000);
    vi.unstubAllGlobals();
  });

  it("reports permission denial without a media id or transcript success", async () => {
    const onReady = vi.fn();
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    render(
      <MediaRecorderControl
        roomId={ROOM_ID}
        gateway={gateway}
        allowedUploadOrigins={uploadOrigins}
        onReady={onReady}
        mediaDevices={{ getUserMedia }}
        recorderFactory={() => new FakeRecorder()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "開始錄音" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("未取得麥克風權限");
    expect(onReady).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/已轉寫|轉寫成功/);
  });

  it("stops a late permission stream after reset and never enters recording", async () => {
    const pending = deferred<MediaStream>();
    const { stream, track } = fakeStream();
    const recorderFactory = vi.fn(() => new FakeRecorder());
    render(
      <MediaRecorderControl
        roomId={ROOM_ID}
        gateway={gateway}
        allowedUploadOrigins={uploadOrigins}
        onReady={vi.fn()}
        mediaDevices={{ getUserMedia: vi.fn(() => pending.promise) }}
        recorderFactory={recorderFactory}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "開始錄音" }));
    await userEvent.click(screen.getByRole("button", { name: "取消錄音請求" }));
    await act(async () => { pending.resolve(stream); });

    await waitFor(() => expect(track.stop).toHaveBeenCalledTimes(1));
    expect(recorderFactory).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "停止錄音" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("尚未錄音");
  });

  it.each([
    ["normal stop", async (unmount: () => void) => {
      await userEvent.click(screen.getByRole("button", { name: "停止錄音" }));
      unmount();
    }],
    ["clear", async (_unmount: () => void) => {
      await userEvent.click(screen.getByRole("button", { name: "取消並清除錄音" }));
    }],
    ["unmount", async (unmount: () => void) => { unmount(); }],
  ])("clears every microphone track exactly once on %s", async (_label, finish) => {
    const { stream, track } = fakeStream();
    const recorder = new FakeRecorder();
    const objectUrls = { create: vi.fn(() => "blob:recording"), revoke: vi.fn() };
    const view = render(
      <MediaRecorderControl
        roomId={ROOM_ID}
        gateway={gateway}
        allowedUploadOrigins={uploadOrigins}
        onReady={vi.fn()}
        mediaDevices={{ getUserMedia: vi.fn(async () => stream) }}
        recorderFactory={() => recorder}
        objectUrls={objectUrls}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "開始錄音" }));
    expect(await screen.findByRole("button", { name: "停止錄音" })).toBeEnabled();

    await finish(view.unmount);

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(recorder.stop).toHaveBeenCalledTimes(1);
  });

  it("sends the completed Blob through the injected media upload and succeeds only via onReady", async () => {
    const { stream, track } = fakeStream();
    const recorder = new FakeRecorder("audio/webm;codecs=opus");
    const pendingUpload = deferred<{ mediaId: string; state: "processing" }>();
    const upload = vi.fn<RecordedAudioUpload>(() => pendingUpload.promise);
    const onReady = vi.fn();
    const objectUrls = { create: vi.fn(() => "blob:recording"), revoke: vi.fn() };
    render(
      <MediaRecorderControl
        roomId={ROOM_ID}
        gateway={gateway}
        allowedUploadOrigins={uploadOrigins}
        onReady={onReady}
        upload={upload}
        mediaDevices={{ getUserMedia: vi.fn(async () => stream) }}
        recorderFactory={() => recorder}
        objectUrls={objectUrls}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "開始錄音" }));
    await userEvent.click(await screen.findByRole("button", { name: "停止錄音" }));
    await userEvent.click(await screen.findByRole("button", { name: "上傳錄音並由伺服器確認" }));

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({
      roomId: ROOM_ID,
      file: expect.any(File),
      kind: "audio",
      altText: null,
      caption: null,
      gateway,
      allowedUploadOrigins: uploadOrigins,
      signal: expect.any(AbortSignal),
    }));
    expect(upload.mock.calls[0]?.[0].file.type).toBe("audio/webm");
    expect(onReady).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("正在取得 Grant");

    await act(async () => { pendingUpload.resolve({ mediaId: MEDIA_ID, state: "processing" }); });

    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(onReady).toHaveBeenCalledWith(MEDIA_ID);
    expect(screen.getByRole("status")).toHaveTextContent("伺服器已確認錄音可附加");
    expect(document.body.textContent).not.toMatch(/已轉寫|轉寫成功/);
    expect(document.body.innerHTML).not.toContain(MEDIA_ID);
    expect(objectUrls.revoke).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("本地錄音預覽")).not.toBeInTheDocument();
  });

  it("fails closed before creating a URL when recorded chunks exceed 25 MiB", async () => {
    const { stream, track } = fakeStream();
    const recorder = new FakeRecorder();
    recorder.stop.mockImplementation(() => {
      recorder.state = "inactive";
      recorder.ondataavailable?.({ data: new Blob([new Uint8Array(25 * 1024 * 1024 + 1)], { type: "audio/webm" }) });
      recorder.onstop?.();
    });
    const objectUrls = { create: vi.fn(() => "blob:oversize"), revoke: vi.fn() };
    render(<MediaRecorderControl
      roomId={ROOM_ID} gateway={gateway} allowedUploadOrigins={uploadOrigins} onReady={vi.fn()}
      mediaDevices={{ getUserMedia: vi.fn(async () => stream) }} recorderFactory={() => recorder}
      objectUrls={objectUrls}
    />);
    await userEvent.click(screen.getByRole("button", { name: "開始錄音" }));
    await userEvent.click(await screen.findByRole("button", { name: "停止錄音" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("錄音大小超出安全上限");
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(objectUrls.create).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("本地錄音預覽")).not.toBeInTheDocument();
  });

  it("uses a bounded stop watchdog when the native recorder never emits onstop", async () => {
    vi.useFakeTimers();
    try {
      const { stream, track } = fakeStream();
      const recorder = new FakeRecorder();
      recorder.stop.mockImplementation(() => { recorder.state = "inactive"; });
      render(<MediaRecorderControl
        roomId={ROOM_ID} gateway={gateway} allowedUploadOrigins={uploadOrigins} onReady={vi.fn()}
        mediaDevices={{ getUserMedia: vi.fn(async () => stream) }} recorderFactory={() => recorder}
        stopWatchdogMs={100}
      />);
      fireEvent.click(screen.getByRole("button", { name: "開始錄音" }));
      await act(async () => Promise.resolve());
      fireEvent.click(screen.getByRole("button", { name: "停止錄音" }));
      await act(async () => { vi.advanceTimersByTime(101); });
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(recorder.stop).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("alert")).toHaveTextContent("未能完成停止");
      expect(screen.queryByLabelText("本地錄音預覽")).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it("automatically stops and fails closed at the recording duration deadline", async () => {
    vi.useFakeTimers();
    try {
      const { stream, track } = fakeStream();
      const recorder = new FakeRecorder();
      render(<MediaRecorderControl
        roomId={ROOM_ID} gateway={gateway} allowedUploadOrigins={uploadOrigins} onReady={vi.fn()}
        mediaDevices={{ getUserMedia: vi.fn(async () => stream) }} recorderFactory={() => recorder}
        maxRecordingMs={100}
      />);
      fireEvent.click(screen.getByRole("button", { name: "開始錄音" }));
      await act(async () => Promise.resolve());
      await act(async () => { vi.advanceTimersByTime(101); });
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("alert")).toHaveTextContent("2 分鐘安全上限");
      expect(screen.queryByLabelText("本地錄音預覽")).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it("stops every microphone track immediately when an open room becomes closed", async () => {
    const { stream, track } = fakeStream();
    const recorder = new FakeRecorder();
    const objectUrls = { create: vi.fn(() => "blob:must-not-exist"), revoke: vi.fn() };
    const props = {
      roomId: ROOM_ID, gateway, allowedUploadOrigins: uploadOrigins, onReady: vi.fn(),
      mediaDevices: { getUserMedia: vi.fn(async () => stream) }, recorderFactory: () => recorder,
      objectUrls,
    };
    const rendered = render(<MediaRecorderControl {...props} roomStatus="open" />);
    await userEvent.click(screen.getByRole("button", { name: "開始錄音" }));
    expect(await screen.findByRole("button", { name: "停止錄音" })).toBeEnabled();

    rendered.rerender(<MediaRecorderControl {...props} roomStatus="closed" />);
    await waitFor(() => expect(track.stop).toHaveBeenCalledTimes(1));
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(objectUrls.create).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "開始錄音" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("麥克風、錄音預覽與上傳已停止");
  });

  it("ignores a late upload result after clear", async () => {
    const { stream } = fakeStream();
    const recorder = new FakeRecorder();
    const pendingUpload = deferred<{ mediaId: string; state: "ready" }>();
    const onReady = vi.fn();
    render(
      <MediaRecorderControl
        roomId={ROOM_ID}
        gateway={gateway}
        allowedUploadOrigins={uploadOrigins}
        onReady={onReady}
        upload={() => pendingUpload.promise}
        mediaDevices={{ getUserMedia: vi.fn(async () => stream) }}
        recorderFactory={() => recorder}
        objectUrls={{ create: () => "blob:recording", revoke: vi.fn() }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "開始錄音" }));
    await userEvent.click(await screen.findByRole("button", { name: "停止錄音" }));
    await userEvent.click(await screen.findByRole("button", { name: "上傳錄音並由伺服器確認" }));
    await userEvent.click(screen.getByRole("button", { name: "清除錄音" }));
    await act(async () => { pendingUpload.resolve({ mediaId: MEDIA_ID, state: "ready" }); });

    expect(onReady).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("尚未錄音");
  });
});
