import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MediaAttachmentView, MediaStatusFrame } from "@learning-orbit/contracts";
import { MediaAttachment } from "./media-attachment.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const MEDIA_ID = "00000000-0000-4000-8000-000000000701";
const AT = "2026-08-31T01:05:00.000Z";

function view(overrides: Partial<MediaAttachmentView> = {}): MediaAttachmentView {
  return {
    mediaId: MEDIA_ID,
    kind: "image",
    state: "ready",
    detectedMime: "image/png",
    sizeBytes: 3,
    altText: "池塘草圖",
    caption: "本組觀察",
    failureCode: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function gateway(initial: MediaAttachmentView = view()) {
  return {
    createMediaUpload: vi.fn(),
    completeMediaUpload: vi.fn(),
    getMedia: vi.fn(async () => initial),
    getMediaDownloadGrant: vi.fn(async () => ({
      downloadUrl: "https://storage.learning-orbit.test/private/signed?secret=never-render",
      expiresAt: "2026-08-31T02:00:00.000Z",
    })),
  };
}

describe("server-confirmed media attachment", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("hydrates metadata but fetches signed bytes only after a user action and exposes only a local blob URL", async () => {
    const api = gateway(view({ sizeBytes: 4 }));
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      // Safe derivatives may have a different byte size from the original
      // public attachment metadata.
      headers: { "content-length": "4", "content-type": "image/png" },
    }));
    const objectUrls = { create: vi.fn(() => "blob:confirmed-media"), revoke: vi.fn() };
    const rendered = render(<MediaAttachment
      roomId={ROOM_ID}
      mediaId={MEDIA_ID}
      gateway={api}
      allowedDownloadOrigins={["https://storage.learning-orbit.test"]}
      fetch={fetcher}
      objectUrls={objectUrls}
      now={() => new Date("2026-08-31T01:10:00.000Z")}
    />);

    expect(await screen.findByText("本組觀察")).toBeInTheDocument();
    expect(api.getMedia).toHaveBeenCalledWith(ROOM_ID, MEDIA_ID);
    expect(api.getMediaDownloadGrant).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "載入圖片附件" }));
    expect(await screen.findByRole("img", { name: "池塘草圖" })).toHaveAttribute("src", "blob:confirmed-media");
    expect(fetcher).toHaveBeenCalledWith(
      "https://storage.learning-orbit.test/private/signed?secret=never-render",
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      }),
    );
    expect(document.body.innerHTML).not.toContain("signed?secret");
    expect(document.body.innerHTML).not.toContain(MEDIA_ID);

    rendered.unmount();
    expect(objectUrls.revoke).toHaveBeenCalledWith("blob:confirmed-media");
  });

  it("keeps processing honest and refreshes metadata when a real-time status changes", async () => {
    const processing = view({ state: "processing", detectedMime: null });
    const ready = view();
    const api = gateway(processing);
    api.getMedia.mockResolvedValueOnce(processing).mockResolvedValueOnce(ready);
    const status = (state: MediaStatusFrame["state"], updatedAt: string): MediaStatusFrame => ({
      type: "media_status", mediaId: MEDIA_ID, state, failureCode: null, updatedAt,
    });
    const props = {
      roomId: ROOM_ID,
      mediaId: MEDIA_ID,
      gateway: api,
      allowedDownloadOrigins: ["https://storage.learning-orbit.test"],
      fetch: vi.fn(),
      objectUrls: { create: vi.fn(), revoke: vi.fn() },
      now: () => new Date("2026-08-31T01:10:00.000Z"),
    };
    const rendered = render(<MediaAttachment {...props} liveStatus={status("processing", AT)} />);
    expect(await screen.findByText("媒體仍在伺服器處理中；尚未可播放或下載，也沒有轉寫。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /載入/ })).not.toBeInTheDocument();

    rendered.rerender(<MediaAttachment {...props} liveStatus={status("ready", "2026-08-31T01:06:00.000Z")} />);
    expect(await screen.findByRole("button", { name: "載入圖片附件" })).toBeInTheDocument();
    expect(api.getMedia).toHaveBeenCalledTimes(2);
  });

  it("treats a ready real-time frame as a refetch hint and never upgrades stale GET metadata", async () => {
    const processing = view({ state: "processing", detectedMime: null });
    const api = gateway(processing);
    render(<MediaAttachment
      roomId={ROOM_ID}
      mediaId={MEDIA_ID}
      gateway={api}
      allowedDownloadOrigins={["https://storage.learning-orbit.test"]}
      liveStatus={{ type: "media_status", mediaId: MEDIA_ID, state: "ready", failureCode: null, updatedAt: "2026-08-31T01:06:00.000Z" }}
    />);
    expect(await screen.findByText("媒體仍在伺服器處理中；尚未可播放或下載，也沒有轉寫。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /載入/ })).not.toBeInTheDocument();
    expect(api.getMediaDownloadGrant).not.toHaveBeenCalled();
  });

  it("immediately hides and revokes loaded bytes on a terminal real-time frame while GET is still pending", async () => {
    const api = gateway();
    let resolveRefresh!: (value: MediaAttachmentView) => void;
    api.getMedia.mockResolvedValueOnce(view()).mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    const objectUrls = { create: vi.fn(() => "blob:confirmed-media"), revoke: vi.fn() };
    const props = {
      roomId: ROOM_ID,
      mediaId: MEDIA_ID,
      gateway: api,
      allowedDownloadOrigins: ["https://storage.learning-orbit.test"],
      fetch: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "3", "content-type": "image/png" } })),
      objectUrls,
      now: () => new Date("2026-08-31T01:10:00.000Z"),
    };
    const rendered = render(<MediaAttachment {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: "載入圖片附件" }));
    expect(await screen.findByRole("img", { name: "池塘草圖" })).toBeInTheDocument();

    rendered.rerender(<MediaAttachment {...props} liveStatus={{
      type: "media_status", mediaId: MEDIA_ID, state: "quarantined", failureCode: "POLICY", updatedAt: "2026-08-31T01:06:00.000Z",
    }} />);
    await waitFor(() => expect(screen.queryByRole("img", { name: "池塘草圖" })).not.toBeInTheDocument());
    expect(objectUrls.revoke).toHaveBeenCalledWith("blob:confirmed-media");
    expect(screen.queryByRole("button", { name: /載入/ })).not.toBeInTheDocument();
    resolveRefresh(view({ state: "quarantined", failureCode: "POLICY", updatedAt: "2026-08-31T01:06:00.000Z" }));
  });

  it("revokes loaded bytes when metadata refresh loses authority and requires a new user action after recovery", async () => {
    const api = gateway();
    api.getMedia.mockResolvedValueOnce(view()).mockRejectedValueOnce(new Error("authority lost")).mockResolvedValueOnce(view({ updatedAt: "2026-08-31T01:07:00.000Z" }));
    const objectUrls = { create: vi.fn(() => "blob:confirmed-media"), revoke: vi.fn() };
    const props = {
      roomId: ROOM_ID, mediaId: MEDIA_ID, gateway: api,
      allowedDownloadOrigins: ["https://storage.learning-orbit.test"],
      fetch: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "3", "content-type": "image/png" } })),
      objectUrls,
      now: () => new Date("2026-08-31T01:10:00.000Z"),
    };
    const rendered = render(<MediaAttachment {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: "載入圖片附件" }));
    expect(await screen.findByRole("img", { name: "池塘草圖" })).toBeInTheDocument();

    rendered.rerender(<MediaAttachment {...props} liveStatus={{
      type: "media_status", mediaId: MEDIA_ID, state: "ready", failureCode: null, updatedAt: "2026-08-31T01:06:00.000Z",
    }} />);
    expect(await screen.findByText("附件目前不可用；沒有載入模擬媒體。")).toBeInTheDocument();
    expect(objectUrls.revoke).toHaveBeenCalledWith("blob:confirmed-media");

    rendered.rerender(<MediaAttachment {...props} liveStatus={{
      type: "media_status", mediaId: MEDIA_ID, state: "ready", failureCode: null, updatedAt: "2026-08-31T01:07:00.000Z",
    }} />);
    expect(await screen.findByRole("button", { name: "載入圖片附件" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "池塘草圖" })).not.toBeInTheDocument();
  });

  it.each([
    ["quarantined", "媒體未通過安全檢查，不能開啟"],
    ["failed", "媒體處理失敗；文字課堂仍可使用"],
    ["deleted", "媒體已刪除"],
  ] as const)("renders the real %s terminal state without requesting a grant", async (state, copy) => {
    const api = gateway(view({ state }));
    render(<MediaAttachment
      roomId={ROOM_ID} mediaId={MEDIA_ID} gateway={api}
      allowedDownloadOrigins={["https://storage.learning-orbit.test"]}
    />);
    expect(await screen.findByText(`${copy}。`)).toBeInTheDocument();
    expect(api.getMediaDownloadGrant).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /載入/ })).not.toBeInTheDocument();
  });

  it("rejects an expired or untrusted signed URL before network use and never renders it", async () => {
    const api = gateway();
    api.getMediaDownloadGrant.mockResolvedValue({
      downloadUrl: "https://evil.example/private?credential=do-not-show",
      expiresAt: "2026-08-31T01:00:00.000Z",
    });
    const fetcher = vi.fn();
    render(<MediaAttachment
      roomId={ROOM_ID} mediaId={MEDIA_ID} gateway={api}
      allowedDownloadOrigins={["https://storage.learning-orbit.test"]}
      fetch={fetcher}
      now={() => new Date("2026-08-31T01:10:00.000Z")}
    />);
    await userEvent.click(await screen.findByRole("button", { name: "載入圖片附件" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("附件未能安全載入");
    expect(fetcher).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain("evil.example");
    expect(document.body.innerHTML).not.toContain("credential");
  });

  it("discards a late byte response after unmount without creating an object URL", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const objectUrls = { create: vi.fn(() => "blob:late"), revoke: vi.fn() };
    const rendered = render(<MediaAttachment
      roomId={ROOM_ID} mediaId={MEDIA_ID} gateway={gateway()}
      allowedDownloadOrigins={["https://storage.learning-orbit.test"]}
      fetch={fetcher}
      objectUrls={objectUrls}
      now={() => new Date("2026-08-31T01:10:00.000Z")}
    />);
    await userEvent.click(await screen.findByRole("button", { name: "載入圖片附件" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    rendered.unmount();
    resolveFetch(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "3" } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(objectUrls.create).not.toHaveBeenCalled();
  });
});
