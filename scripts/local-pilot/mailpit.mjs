export const MAILPIT_BASE_URL = "http://127.0.0.1:8025";
const MAILPIT_SEARCH_LIMIT = 50;
const MAX_JSON_BYTES = 1024 * 1024;
const consumeOrigin = "https://127.0.0.1:3000";
const consumePath = "/v1/auth/teacher/magic-link/consume";

const fail = (code) => {
  throw new Error(code);
};

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  return isObject(value)
    && Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function boundedString(value, max = 16_384) {
  return typeof value === "string" && value.length <= max && !value.includes("\u0000");
}

function unsigned(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function rfc3339(value) {
  return boundedString(value, 64) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function parseAddress(value) {
  if (!exactKeys(value, ["Address", "Name"])
    || !boundedString(value.Address, 320) || !boundedString(value.Name, 320)) {
    fail("MAILPIT_CONTRACT_MISMATCH");
  }
  return value;
}

function parseAddresses(value) {
  if (!Array.isArray(value) || value.length > 64) fail("MAILPIT_CONTRACT_MISMATCH");
  value.forEach(parseAddress);
  return value;
}

function parseSummaryAddresses(value) {
  if (value === null) return value;
  return parseAddresses(value);
}

function parseTags(value) {
  if (!Array.isArray(value) || value.length > 64
    || value.some((item) => !boundedString(item, 128))) {
    fail("MAILPIT_CONTRACT_MISMATCH");
  }
  return value;
}

const SUMMARY_KEYS = [
  "Attachments", "Bcc", "Cc", "Created", "From", "ID", "MessageID", "Read",
  "ReplyTo", "Size", "Snippet", "Subject", "Tags", "To", "Username",
];

function parseSummary(value) {
  if (!exactKeys(value, SUMMARY_KEYS) || !unsigned(value.Attachments)
    || !rfc3339(value.Created) || !/^[A-Za-z0-9]{1,64}$/.test(value.ID ?? "")
    || !boundedString(value.MessageID, 998) || typeof value.Read !== "boolean"
    || !unsigned(value.Size) || !boundedString(value.Snippet, 1_024)
    || !boundedString(value.Subject, 998) || !boundedString(value.Username, 320)) {
    fail("MAILPIT_CONTRACT_MISMATCH");
  }
  parseAddress(value.From);
  parseSummaryAddresses(value.Bcc);
  parseSummaryAddresses(value.Cc);
  parseSummaryAddresses(value.ReplyTo);
  parseAddresses(value.To);
  parseTags(value.Tags);
  return value;
}

const SEARCH_KEYS = [
  "total", "unread", "count", "messages_count", "messages_unread", "start", "tags", "messages",
];

export function parseMailpitSearch(value) {
  if (!exactKeys(value, SEARCH_KEYS)
    || !unsigned(value.total) || !unsigned(value.unread) || !unsigned(value.count)
    || !unsigned(value.messages_count) || !unsigned(value.messages_unread)
    || !unsigned(value.start) || !Array.isArray(value.messages)
    || value.messages.length > MAILPIT_SEARCH_LIMIT) {
    fail("MAILPIT_CONTRACT_MISMATCH");
  }
  parseTags(value.tags);
  value.messages.forEach(parseSummary);
  const ids = new Set(value.messages.map((item) => item.ID));
  if (ids.size !== value.messages.length || value.count !== value.messages.length
    || value.messages_count < value.count || value.messages_count > value.total
    || value.messages_unread > value.messages_count || value.unread > value.total) {
    fail("MAILPIT_CONTRACT_MISMATCH");
  }
  return value;
}

const MESSAGE_KEYS = [
  "Attachments", "Bcc", "Cc", "Date", "From", "HTML", "ID", "Inline",
  "ListUnsubscribe", "MessageID", "ReplyTo", "ReturnPath", "Size", "Subject",
  "Tags", "Text", "To", "Username",
];

export function parseMailpitMessage(value) {
  if (!exactKeys(value, MESSAGE_KEYS) || !Array.isArray(value.Attachments)
    || value.Attachments.length !== 0 || !Array.isArray(value.Inline) || value.Inline.length !== 0
    || !rfc3339(value.Date) || !boundedString(value.HTML, 512 * 1024)
    || !/^[A-Za-z0-9]{1,64}$/.test(value.ID ?? "") || !boundedString(value.MessageID, 998)
    || !boundedString(value.ReturnPath, 320) || !unsigned(value.Size)
    || !boundedString(value.Subject, 998) || !boundedString(value.Text, 512 * 1024)
    || !boundedString(value.Username, 320)
    || !exactKeys(value.ListUnsubscribe, ["Errors", "Header", "HeaderPost", "Links"])
    || !boundedString(value.ListUnsubscribe.Errors, 4_096)
    || !boundedString(value.ListUnsubscribe.Header, 4_096)
    || !boundedString(value.ListUnsubscribe.HeaderPost, 4_096)
    || !Array.isArray(value.ListUnsubscribe.Links)
    || value.ListUnsubscribe.Links.length > 2
    || value.ListUnsubscribe.Links.some((item) => !boundedString(item, 4_096))) {
    fail("MAILPIT_CONTRACT_MISMATCH");
  }
  parseAddress(value.From);
  parseAddresses(value.Bcc);
  parseAddresses(value.Cc);
  parseAddresses(value.ReplyTo);
  parseAddresses(value.To);
  parseTags(value.Tags);
  return value;
}

export function parseMagicLinkFromMessage(value) {
  const message = parseMailpitMessage(value);
  const text = message.Text.endsWith("\r\n") ? message.Text.slice(0, -2) : message.Text;
  if (text.trim() !== text) fail("MAILPIT_MAGIC_LINK_INVALID");
  let url;
  try {
    url = new URL(text);
  } catch {
    fail("MAILPIT_MAGIC_LINK_INVALID");
  }
  const tokenValues = url.searchParams.getAll("token");
  if (url.origin !== consumeOrigin || url.pathname !== consumePath
    || url.username !== "" || url.password !== "" || url.hash !== ""
    || [...url.searchParams.keys()].length !== 1 || tokenValues.length !== 1
    || !/^[A-Za-z0-9_-]{8,512}$/.test(tokenValues[0] ?? "")) {
    fail("MAILPIT_MAGIC_LINK_INVALID");
  }
  return url.href;
}

function assertRecipient(recipient) {
  if (typeof recipient !== "string"
    || !/^pilot-[0-9a-f]{16}@example\.invalid$/.test(recipient)) {
    fail("MAILPIT_RECIPIENT_INVALID");
  }
}

function assertMessageId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(id)) {
    fail("MAILPIT_MESSAGE_ID_INVALID");
  }
}

function recipientSearchUrl(recipient, paginated) {
  assertRecipient(recipient);
  const url = new URL("/api/v1/search", MAILPIT_BASE_URL);
  url.searchParams.set("query", `to:${recipient}`);
  if (paginated) {
    url.searchParams.set("start", "0");
    url.searchParams.set("limit", String(MAILPIT_SEARCH_LIMIT));
  }
  return url.href;
}

export async function readBoundedResponseText(response, maxBytes = MAX_JSON_BYTES) {
  if (!(response instanceof Response) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    fail("MAILPIT_CONTRACT_MISMATCH");
  }
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding !== null) fail("MAILPIT_CONTRACT_MISMATCH");
  const declaredLength = response.headers.get("content-length");
  let expectedLength;
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]{0,15})$/.test(declaredLength)) fail("MAILPIT_CONTRACT_MISMATCH");
    expectedLength = Number(declaredLength);
    if (!Number.isSafeInteger(expectedLength) || expectedLength > maxBytes) {
      fail("MAILPIT_CONTRACT_MISMATCH");
    }
  }
  if (!response.body) {
    if (expectedLength !== undefined && expectedLength !== 0) fail("MAILPIT_CONTRACT_MISMATCH");
    return "";
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail("MAILPIT_CONTRACT_MISMATCH");
      total += value.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        fail("MAILPIT_CONTRACT_MISMATCH");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof Error && error.message === "MAILPIT_CONTRACT_MISMATCH") throw error;
    fail("MAILPIT_CONTRACT_MISMATCH");
  } finally {
    reader.releaseLock();
  }
  if (expectedLength !== undefined && total !== expectedLength) fail("MAILPIT_CONTRACT_MISMATCH");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("MAILPIT_CONTRACT_MISMATCH");
  }
}

export class MailpitClient {
  #fetch;

  constructor({ fetch = globalThis.fetch } = {}) {
    if (typeof fetch !== "function") fail("MAILPIT_FETCH_INVALID");
    this.#fetch = fetch;
  }

  async #request(url, init = {}, expectedContentType) {
    let response;
    try {
      const headers = new Headers(init.headers);
      headers.set("accept-encoding", "identity");
      response = await this.#fetch(url, {
        ...init,
        headers,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      fail("MAILPIT_REQUEST_FAILED");
    }
    if (!(response instanceof Response) || response.status !== 200) {
      fail("MAILPIT_REQUEST_FAILED");
    }
    const contentTypeHeader = response.headers.get("content-type");
    const contentType = contentTypeHeader?.split(";", 1)[0]?.trim().toLowerCase();
    if (expectedContentType === null
      ? contentTypeHeader !== null
      : contentType !== expectedContentType) {
      fail("MAILPIT_CONTRACT_MISMATCH");
    }
    return response;
  }

  async #search(recipient) {
    const response = await this.#request(recipientSearchUrl(recipient, true), {}, "application/json");
    let value;
    try {
      value = JSON.parse(await readBoundedResponseText(response));
    } catch (error) {
      if (error instanceof Error && error.message === "MAILPIT_CONTRACT_MISMATCH") throw error;
      fail("MAILPIT_CONTRACT_MISMATCH");
    }
    return parseMailpitSearch(value);
  }

  async assertReady() {
    const response = await this.#request(`${MAILPIT_BASE_URL}/readyz`, {}, null);
    if (response.headers.get("content-length") !== "0"
      || await readBoundedResponseText(response, 64) !== "") {
      fail("MAILPIT_CONTRACT_MISMATCH");
    }
  }

  async findSingleMessage(recipient) {
    const result = await this.#search(recipient);
    if (result.messages_count === 0) fail("MAILPIT_MESSAGE_NOT_READY");
    if (result.messages_count !== 1 || result.count !== 1 || result.messages.length !== 1) {
      fail("MAILPIT_MESSAGE_COUNT_MISMATCH");
    }
    const message = result.messages[0];
    if (!message.To.some((item) => item.Address === recipient)) {
      fail("MAILPIT_RECIPIENT_MISMATCH");
    }
    return message.ID;
  }

  async readMessage(id) {
    assertMessageId(id);
    const response = await this.#request(
      `${MAILPIT_BASE_URL}/api/v1/message/${encodeURIComponent(id)}`,
      {},
      "application/json",
    );
    let value;
    try {
      value = JSON.parse(await readBoundedResponseText(response));
    } catch (error) {
      if (error instanceof Error && error.message === "MAILPIT_CONTRACT_MISMATCH") throw error;
      fail("MAILPIT_CONTRACT_MISMATCH");
    }
    const message = parseMailpitMessage(value);
    if (message.ID !== id) fail("MAILPIT_MESSAGE_ID_MISMATCH");
    return message;
  }

  async deleteRecipientMessages(recipient) {
    const response = await this.#request(
      recipientSearchUrl(recipient, false),
      { method: "DELETE" },
      "text/plain",
    );
    if ((await readBoundedResponseText(response, 64)).trim().toLowerCase() !== "ok") {
      fail("MAILPIT_CONTRACT_MISMATCH");
    }
  }

  async assertRecipientEmpty(recipient) {
    const result = await this.#search(recipient);
    if (result.messages_count !== 0 || result.count !== 0 || result.messages.length !== 0) {
      fail("MAILPIT_RESIDUAL_MESSAGE");
    }
  }
}
