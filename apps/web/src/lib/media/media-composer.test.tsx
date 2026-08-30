import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionGatewayError } from "../session/session-gateway.js";
import { MediaComposer, type MediaUploadFunction } from "./media-composer.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const MEDIA_ID = "00000000-0000-4000-8000-000000000701";
const gateway = {
  createMediaUpload: vi.fn(), completeMediaUpload: vi.fn(), getMedia: vi.fn(), getMediaDownloadGrant: vi.fn(),
};

describe("local preview and honest media status", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("keeps local image preview distinct and requires alt text before real upload", async () => {
    const createObjectURL = vi.fn(() => "blob:local-preview");
    const revokeObjectURL = vi.fn();
    render(<MediaComposer
      roomId={ROOM_ID}
      gateway={gateway}
      allowedUploadOrigins={["https://storage.learning-orbit.test"]}
      mediaIds={[]}
      onReady={vi.fn()}
      objectUrls={{ create: createObjectURL, revoke: revokeObjectURL }}
      upload={vi.fn(async () => ({ mediaId: MEDIA_ID, state: "processing" as const }))}
    />);
    const file = new File(["abc"], "pond.png", { type: "image/png" });
    await userEvent.upload(screen.getByLabelText("本地媒體檔案"), file);
    expect(screen.getByRole("img", { name: /本地圖片預覽/ })).toHaveAttribute("src", "blob:local-preview");
    expect(screen.getByRole("button", { name: "上傳並由伺服器確認" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("圖片替代文字"), "池塘草圖");
    expect(screen.getByRole("button", { name: "上傳並由伺服器確認" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "清除本地媒體" }));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:local-preview");
  });

  it("rejects SVG and every non-allowlisted MIME before creating a local URL", async () => {
    const objectUrls = { create: vi.fn(() => "blob:must-not-exist"), revoke: vi.fn() };
    render(<MediaComposer
      roomId={ROOM_ID} gateway={gateway} allowedUploadOrigins={["https://storage.learning-orbit.test"]}
      mediaIds={[]} onReady={vi.fn()} objectUrls={objectUrls}
    />);
    await userEvent.upload(
      screen.getByLabelText("本地媒體檔案"),
      new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"] , "active.svg", { type: "image/svg+xml" }),
      { applyAccept: false },
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("檔案類型或大小不符合媒體規則");
    expect(objectUrls.create).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows provider unavailable without creating a media id or disabling text chat", async () => {
    const onReady = vi.fn();
    const upload = vi.fn(async () => { throw new SessionGatewayError("MEDIA_SERVICE_UNAVAILABLE"); });
    render(<MediaComposer
      roomId={ROOM_ID} gateway={gateway} allowedUploadOrigins={["https://storage.learning-orbit.test"]}
      mediaIds={[]} onReady={onReady} upload={upload}
      objectUrls={{ create: () => "blob:audio", revoke: vi.fn() }}
    />);
    await userEvent.upload(screen.getByLabelText("本地媒體檔案"), new File(["abc"], "note.webm", { type: "audio/webm" }));
    expect(screen.getByText("本地音訊預覽；沒有產生或顯示轉寫。"), "local preview disclosure").toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "上傳並由伺服器確認" }));
    expect(await screen.findByRole("status")).toHaveTextContent("媒體 Provider 目前不可用；文字聊天仍可使用");
    expect(onReady).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/已轉寫|遠端音訊可播放/);
  });

  it("adds only a complete-acknowledged media id and never displays it", async () => {
    const onReady = vi.fn();
    render(<MediaComposer
      roomId={ROOM_ID} gateway={gateway} allowedUploadOrigins={["https://storage.learning-orbit.test"]}
      mediaIds={[]} onReady={onReady}
      upload={vi.fn(async () => ({ mediaId: MEDIA_ID, state: "processing" as const }))}
      objectUrls={{ create: () => "blob:audio", revoke: vi.fn() }}
    />);
    await userEvent.upload(screen.getByLabelText("本地媒體檔案"), new File(["abc"], "note.webm", { type: "audio/webm" }));
    await userEvent.click(screen.getByRole("button", { name: "上傳並由伺服器確認" }));
    expect(onReady).toHaveBeenCalledWith(MEDIA_ID);
    expect(await screen.findByRole("status")).toHaveTextContent("伺服器已確認上傳；處理尚未完成");
    expect(document.body.innerHTML).not.toContain(MEDIA_ID);
  });

  it("aborts an in-flight upload and revokes local bytes when the room leaves open", async () => {
    let resolveUpload!: (value: { mediaId: string; state: "processing" }) => void;
    let uploadSignal: AbortSignal | undefined;
    const upload = vi.fn((input: Parameters<MediaUploadFunction>[0]) => {
      uploadSignal = input.signal;
      return new Promise<{ mediaId: string; state: "processing" }>((resolve) => { resolveUpload = resolve; });
    });
    const onReady = vi.fn();
    const objectUrls = { create: vi.fn(() => "blob:audio"), revoke: vi.fn() };
    const props = {
      roomId: ROOM_ID, gateway, allowedUploadOrigins: ["https://storage.learning-orbit.test"],
      mediaIds: [] as string[], onReady, upload, objectUrls,
    };
    const rendered = render(<MediaComposer {...props} roomStatus="open" />);
    await userEvent.upload(screen.getByLabelText("本地媒體檔案"), new File(["abc"], "note.webm", { type: "audio/webm" }));
    await userEvent.click(screen.getByRole("button", { name: "上傳並由伺服器確認" }));
    expect(uploadSignal?.aborted).toBe(false);

    rendered.rerender(<MediaComposer {...props} roomStatus="paused" />);
    expect(uploadSignal?.aborted).toBe(true);
    expect(objectUrls.revoke).toHaveBeenCalledWith("blob:audio");
    expect(screen.getByRole("button", { name: "選擇本地媒體" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("媒體選取與上傳已停止");
    resolveUpload({ mediaId: MEDIA_ID, state: "processing" });
    await Promise.resolve();
    expect(onReady).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "上傳並由伺服器確認" })).not.toBeInTheDocument();
  });
});
