export type BrowserStorageSafetyOptions = Readonly<{
  allowedUuids?: readonly string[];
  forbiddenValues?: readonly string[];
}>;

/**
 * Runs inside the browser through Playwright. Keep this function self-contained:
 * page.evaluate serializes its body and does not preserve module closures.
 */
export function browserStorageHasNoCredentialArtifacts(
  options: BrowserStorageSafetyOptions = {},
): boolean {
  const MAX_DEBUG_KEYS = 8;
  const MAX_CHUNKS_PER_KEY = 1_024;
  const MAX_RAW_CHARS = 2 * 1024 * 1024;
  const MAX_CHUNK_CHARS = 512 * 1024;
  const MAX_DECODED_BYTES = 1024 * 1024;
  const DEBUG_KEY_PATTERN = /^__next_debug_channel:[A-Za-z0-9_-]{1,64}$/u;
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const UUID_GLOBAL_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu;
  const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
  const CREDENTIAL_MARKER_PATTERN = /(?:lo_session|magic-link\/consume|(?:^|[?&])token=|(?:\\?["'])?token(?:\\?["'])?\s*[:=]|(?:\\?["'])?(?:actor|teacher|room[-_]?member|session)[-_]?id(?:\\?["'])?\s*[:=]|(?:\\?["'])?(?:room|seat)[-_]?code(?:\\?["'])?\s*[:=]|(?:\\?["'])?pseudonym(?:\\?["'])?\s*[:=]|(?:\\?["'])role(?:\\?["'])\s*:\s*(?:\\?["'])(?:teacher|student)(?:\\?["']))/iu;

  try {
    if (localStorage.length !== 0 || sessionStorage.length > MAX_DEBUG_KEYS) return false;
    const currentRequestId = Reflect.get(self, "__next_r");
    if (currentRequestId !== undefined
      && (typeof currentRequestId !== "string"
        || !/^[A-Za-z0-9_-]{1,64}$/u.test(currentRequestId)
        || sessionStorage.getItem(`__next_debug_channel:${currentRequestId}`) === null)) return false;

    const allowedUuids = options.allowedUuids ?? [];
    const forbiddenValues = options.forbiddenValues ?? [];
    if (allowedUuids.length > 32
      || allowedUuids.some((value) => !UUID_PATTERN.test(value))) return false;
    if (forbiddenValues.length > 64
      || forbiddenValues.some((value) => value.length < 1 || value.length > 2_048)) return false;

    const allowedUuidSet = new Set(allowedUuids.map((value) => value.toLowerCase()));
    const foldedForbiddenValues = forbiddenValues.map((value) => value.toLowerCase());
    const scan = (value: string): boolean => {
      if (value.length > MAX_DECODED_BYTES * 2) return false;
      if (CREDENTIAL_MARKER_PATTERN.test(value)) return false;
      const folded = value.toLowerCase();
      if (foldedForbiddenValues.some((forbidden) => folded.includes(forbidden))) return false;
      for (const match of value.matchAll(UUID_GLOBAL_PATTERN)) {
        if (!allowedUuidSet.has(match[0].toLowerCase())) return false;
      }
      return true;
    };

    let totalRawChars = 0;
    let totalDecodedBytes = 0;
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (!key || !DEBUG_KEY_PATTERN.test(key)) return false;
      const raw = sessionStorage.getItem(key);
      if (raw === null) return false;
      totalRawChars += raw.length;
      if (totalRawChars > MAX_RAW_CHARS) return false;

      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length > MAX_CHUNKS_PER_KEY
        || parsed.some((chunk) => typeof chunk !== "string")
        || JSON.stringify(parsed) !== raw) return false;

      let binary = "";
      for (const chunk of parsed as string[]) {
        if (chunk.length > MAX_CHUNK_CHARS || chunk.length % 4 !== 0
          || !CANONICAL_BASE64_PATTERN.test(chunk)) return false;
        const decoded = atob(chunk);
        if (btoa(decoded) !== chunk) return false;
        totalDecodedBytes += decoded.length;
        if (totalDecodedBytes > MAX_DECODED_BYTES) return false;
        binary += decoded;
      }

      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (!scan(binary) || !scan(utf8)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
