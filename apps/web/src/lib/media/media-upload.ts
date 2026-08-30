import type { CompleteMediaUploadResponse } from "@learning-orbit/contracts";

import type { SessionGateway } from "../session/session-gateway";
import { sha256Blob } from "./media-file-hash";

export type MediaGateway = Pick<SessionGateway,
  "createMediaUpload" | "completeMediaUpload" | "getMedia" | "getMediaDownloadGrant">;
export type UploadableMediaKind = "image" | "audio";
export type MediaUploadResult = Readonly<{
  mediaId: string;
  state: CompleteMediaUploadResponse["state"];
}>;

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const AUDIO_MIME = new Set(["audio/webm", "audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

export function mediaMimeEssence(value: string, kind: UploadableMediaKind): string | null {
  if (!value || value.length > 127 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const essence = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (kind === "image" ? IMAGE_MIME : AUDIO_MIME).has(essence) ? essence : null;
}

function validLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

export function parseStorageBrowserOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const origins = new Set<string>();
  for (const candidate of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    let url: URL;
    try { url = new URL(candidate); }
    catch { throw new Error("STORAGE_BROWSER_ORIGIN_INVALID"); }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("STORAGE_BROWSER_ORIGIN_INVALID");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && validLoopback(url.hostname))) {
      throw new Error("STORAGE_BROWSER_ORIGIN_INVALID");
    }
    origins.add(url.origin);
  }
  return [...origins];
}

export async function validateImageDimensions(file: File): Promise<void> {
  if (typeof globalThis.createImageBitmap === "function") {
    const bitmap = await globalThis.createImageBitmap(file);
    try {
      if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > MAX_IMAGE_DIMENSION || bitmap.height > MAX_IMAGE_DIMENSION) {
        throw new Error("IMAGE_DIMENSIONS_OUT_OF_RANGE");
      }
    } finally { bitmap.close(); }
    return;
  }
  if (typeof globalThis.Image !== "function" || typeof URL.createObjectURL !== "function") {
    throw new Error("IMAGE_DECODE_UNAVAILABLE");
  }
  const localUrl = URL.createObjectURL(file);
  try {
    const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error("IMAGE_DECODE_FAILED"));
      image.src = localUrl;
    });
    if (dimensions.width < 1 || dimensions.height < 1
      || dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION) {
      throw new Error("IMAGE_DIMENSIONS_OUT_OF_RANGE");
    }
  } finally { URL.revokeObjectURL(localUrl); }
}

export async function uploadMediaFile(input: Readonly<{
  roomId: string;
  file: File;
  kind: UploadableMediaKind;
  altText: string | null;
  caption: string | null;
  gateway: MediaGateway;
  allowedUploadOrigins: readonly string[];
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
  hash?: typeof sha256Blob;
  validateImage?: (file: File) => Promise<void>;
  now?: () => Date;
}>): Promise<MediaUploadResult> {
  const mime = mediaMimeEssence(input.file.type, input.kind);
  const maxBytes = input.kind === "image" ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
  if (!mime) throw new Error("MEDIA_TYPE_UNSUPPORTED");
  if (input.file.size < 1 || input.file.size > maxBytes) throw new Error("MEDIA_SIZE_OUT_OF_RANGE");
  if (!input.file.name || input.file.name.length > 255) throw new Error("MEDIA_FILE_NAME_INVALID");
  const altText = input.kind === "image" ? input.altText?.trim() ?? "" : null;
  if (input.kind === "image" && !altText) throw new Error("MEDIA_ALT_REQUIRED");
  if (input.kind === "image") await (input.validateImage ?? validateImageDimensions)(input.file);
  const digest = await (input.hash ?? sha256Blob)(input.file, input.signal);
  assertNotAborted(input.signal);
  const grant = await input.gateway.createMediaUpload(input.roomId, {
    kind: input.kind,
    originalFileName: input.file.name,
    mime,
    sizeBytes: input.file.size,
    sha256: digest.hex,
    altText,
    caption: input.caption?.trim() || null,
  });
  assertNotAborted(input.signal);
  const now = (input.now ?? (() => new Date()))();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || Date.parse(grant.expiresAt) <= now.getTime()) {
    throw new Error("MEDIA_GRANT_EXPIRED");
  }
  let uploadUrl: URL;
  try { uploadUrl = new URL(grant.uploadUrl); }
  catch { throw new Error("MEDIA_GRANT_URL_INVALID"); }
  if (uploadUrl.username || uploadUrl.password || !input.allowedUploadOrigins.includes(uploadUrl.origin)) {
    throw new Error("MEDIA_GRANT_ORIGIN_REJECTED");
  }
  if (grant.requiredHeaders["x-amz-checksum-sha256"] !== digest.base64) throw new Error("MEDIA_GRANT_CHECKSUM_MISMATCH");
  const fetcher = input.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("MEDIA_UPLOAD_UNAVAILABLE");
  const uploaded = await fetcher(grant.uploadUrl, {
    method: "PUT",
    body: input.file,
    headers: grant.requiredHeaders,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: input.signal,
  });
  assertNotAborted(input.signal);
  if (uploaded.redirected || (uploaded.url && new URL(uploaded.url).origin !== uploadUrl.origin)) {
    throw new Error("MEDIA_UPLOAD_REDIRECT_REJECTED");
  }
  if (!uploaded.ok) throw new Error("MEDIA_UPLOAD_FAILED");
  const complete = await input.gateway.completeMediaUpload(input.roomId, grant.mediaId);
  assertNotAborted(input.signal);
  if (complete.mediaId !== grant.mediaId) throw new Error("MEDIA_COMPLETE_ID_MISMATCH");
  return { mediaId: complete.mediaId, state: complete.state };
}
