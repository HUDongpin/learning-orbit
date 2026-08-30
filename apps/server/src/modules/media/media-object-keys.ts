import { MediaError } from "./media-errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type SafeDerivativeKind = "sanitized_image" | "playback_audio";

/** Canonical Plan 02 key; deletion and download verification must share it. */
export function safeDerivativeObjectKey(
  roomId: string,
  mediaId: string,
  kind: SafeDerivativeKind,
): string {
  if (!UUID.test(roomId) || !UUID.test(mediaId)
    || (kind !== "sanitized_image" && kind !== "playback_audio")) {
    throw new MediaError("INVALID_MEDIA_STATE", 500);
  }
  return `rooms/${roomId}/derivative/${mediaId}/${kind}`;
}
