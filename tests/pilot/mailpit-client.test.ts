import { describe, expect, it, vi } from "vitest";

import {
  MAILPIT_BASE_URL,
  MailpitClient,
  parseMagicLinkFromMessage,
  parseMailpitMessage,
  parseMailpitSearch,
  readBoundedResponseText,
} from "../../scripts/local-pilot/mailpit.mjs";

const recipient = "pilot-0123456789abcdef@example.invalid";
const address = (Address: string, Name = "") => ({ Address, Name });
const summary = {
  Attachments: 0,
  Bcc: [],
  Cc: [],
  Created: "2026-08-31T01:02:03.123456Z",
  From: address("no-reply@learning-orbit.local", "Learning Orbit"),
  ID: "4oRBnPtCXgAqZniRhzLNmS",
  MessageID: "message-id@example.invalid",
  Read: false,
  ReplyTo: [],
  Size: 321,
  Snippet: "Sign in",
  Subject: "Learning Orbit sign-in link",
  Tags: [],
  To: [address(recipient)],
  Username: "",
};
const search = {
  total: 1,
  unread: 1,
  count: 1,
  messages_count: 1,
  messages_unread: 1,
  start: 0,
  tags: [],
  messages: [summary],
};
const message = {
  Attachments: [],
  Bcc: [],
  Cc: [],
  Date: "2026-08-31T01:02:03Z",
  From: address("no-reply@learning-orbit.local", "Learning Orbit"),
  HTML: "",
  ID: summary.ID,
  Inline: [],
  ListUnsubscribe: { Errors: "", Header: "", HeaderPost: "", Links: [] },
  MessageID: summary.MessageID,
  ReplyTo: [],
  ReturnPath: "no-reply@learning-orbit.local",
  Size: 321,
  Subject: summary.Subject,
  Tags: [],
  Text: "https://127.0.0.1:3000/v1/auth/teacher/magic-link/consume?token=abc_DEF-123",
  To: [address(recipient)],
  Username: "",
};

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
});

describe("pinned Mailpit v1.31.0 contract", () => {
  it("strictly parses the query and single-message response shapes", () => {
    expect(parseMailpitSearch(search)).toEqual(search);
    expect(parseMailpitMessage(message)).toEqual(message);
    expect(() => parseMailpitSearch({ ...search, unexpected: true })).toThrow(
      "MAILPIT_CONTRACT_MISMATCH",
    );
    const missingLegacyCount = { ...search } as Record<string, unknown>;
    delete missingLegacyCount.count;
    expect(() => parseMailpitSearch(missingLegacyCount)).toThrow("MAILPIT_CONTRACT_MISMATCH");
    expect(() => parseMailpitMessage({ ...message, Text: 123 })).toThrow(
      "MAILPIT_CONTRACT_MISMATCH",
    );
    expect(() => parseMailpitMessage({ ...message, Attachments: [{}] })).toThrow(
      "MAILPIT_CONTRACT_MISMATCH",
    );
  });

  it("accepts only the canonical same-origin consume URL", () => {
    expect(parseMagicLinkFromMessage(message)).toBe(message.Text);
    expect(() => parseMagicLinkFromMessage({ ...message, Text: "https://evil.invalid/?token=abc" })).toThrow(
      "MAILPIT_MAGIC_LINK_INVALID",
    );
    expect(() => parseMagicLinkFromMessage({ ...message, Text: `${message.Text}&role=teacher` })).toThrow(
      "MAILPIT_MAGIC_LINK_INVALID",
    );
    expect(() => parseMagicLinkFromMessage({ ...message, Text: `${message.Text}\n${message.Text}` })).toThrow(
      "MAILPIT_MAGIC_LINK_INVALID",
    );
  });

  it("queries one recipient, reads one ID, deletes by recipient, then proves no residue", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }))
      .mockResolvedValueOnce(jsonResponse(search))
      .mockResolvedValueOnce(jsonResponse(message))
      .mockResolvedValueOnce(new Response("ok", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }))
      .mockResolvedValueOnce(jsonResponse({ ...search, total: 0, unread: 0, count: 0, messages_count: 0, messages_unread: 0, messages: [] }));
    const client = new MailpitClient({ fetch });
    await client.assertReady();
    expect(await client.findSingleMessage(recipient)).toBe(summary.ID);
    expect(await client.readMessage(summary.ID)).toEqual(message);
    await client.deleteRecipientMessages(recipient);
    await client.assertRecipientEmpty(recipient);

    const calls = fetch.mock.calls.map(([url, init]) => ({ url: String(url), init }));
    expect(calls[0]?.url).toBe(`${MAILPIT_BASE_URL}/readyz`);
    expect(calls[1]?.url).toBe(`${MAILPIT_BASE_URL}/api/v1/search?query=to%3A${encodeURIComponent(recipient)}&start=0&limit=50`);
    expect(calls[2]?.url).toBe(`${MAILPIT_BASE_URL}/api/v1/message/${summary.ID}`);
    expect(calls[3]?.url).toBe(`${MAILPIT_BASE_URL}/api/v1/search?query=to%3A${encodeURIComponent(recipient)}`);
    expect(calls[3]?.init).toMatchObject({ method: "DELETE", redirect: "error" });
    expect(calls.every(({ init }) => (init as RequestInit).credentials === "omit")).toBe(true);
  });

  it("fails on duplicate matches, endpoint drift, non-OK responses, and unsafe recipients", async () => {
    const duplicate = { ...search, total: 2, unread: 2, count: 2, messages_count: 2, messages_unread: 2, messages: [summary, { ...summary, ID: "hXayS6wnCgNnt6aFTvmOF6" }] };
    await expect(new MailpitClient({ fetch: vi.fn().mockResolvedValue(jsonResponse(duplicate)) })
      .findSingleMessage(recipient)).rejects.toThrow("MAILPIT_MESSAGE_COUNT_MISMATCH");
    await expect(new MailpitClient({ fetch: vi.fn().mockResolvedValue(jsonResponse({ ...search, extra: true })) })
      .findSingleMessage(recipient)).rejects.toThrow("MAILPIT_CONTRACT_MISMATCH");
    await expect(new MailpitClient({ fetch: vi.fn().mockResolvedValue(new Response("no", { status: 500 })) })
      .findSingleMessage(recipient)).rejects.toThrow("MAILPIT_REQUEST_FAILED");
    await expect(new MailpitClient({ fetch: vi.fn() }).findSingleMessage("victim@example.com OR true"))
      .rejects.toThrow("MAILPIT_RECIPIENT_INVALID");
  });

  it("rejects oversized bodies before buffering them", async () => {
    const declared = new Response("{}", {
      headers: { "content-length": String(1024 * 1024 + 1) },
    });
    await expect(readBoundedResponseText(declared, 1024 * 1024)).rejects.toThrow(
      "MAILPIT_CONTRACT_MISMATCH",
    );
    expect(declared.bodyUsed).toBe(false);

    let cancelled = false;
    let chunks = 0;
    const chunk = new Uint8Array(600 * 1024);
    const streamed = new Response(new ReadableStream({
      pull(controller) {
        chunks += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    }));
    await expect(readBoundedResponseText(streamed, 1024 * 1024)).rejects.toThrow(
      "MAILPIT_CONTRACT_MISMATCH",
    );
    expect(cancelled).toBe(true);
  });
});
