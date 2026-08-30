const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export async function sha256Blob(blob: Blob, signal: AbortSignal): Promise<{ hex: string; base64: string }> {
  if (!Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > MAX_MEDIA_BYTES) {
    throw new Error("MEDIA_SIZE_OUT_OF_RANGE");
  }
  if (signal.aborted) throw abortError();
  const bytes = await blob.arrayBuffer();
  if (signal.aborted) throw abortError();
  if (!globalThis.crypto?.subtle) throw new Error("MEDIA_HASH_UNAVAILABLE");
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  if (signal.aborted) throw abortError();
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const base64 = globalThis.btoa(String.fromCharCode(...digest));
  return { hex, base64 };
}
