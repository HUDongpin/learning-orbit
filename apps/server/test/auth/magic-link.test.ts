import { createHash } from "node:crypto";

import { Pool } from "pg";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { resetBusinessTables } from "../db/reset.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for auth tests");
const allowedOrigin = "https://app.learning-orbit.test";

async function seedTeacher(email: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try { await pool.query("INSERT INTO teacher_account(email) VALUES ($1)", [email]); } finally { await pool.end(); }
}

describe("teacher magic links", () => {
  beforeEach(async () => resetBusinessTables(databaseUrl));
  afterEach(async () => resetBusinessTables(databaseUrl));

  it("gives known, unknown, malformed, and sender-failed requests the identical public response", async () => {
    const sent: string[] = [];
    await seedTeacher("teacher@example.edu");
    const app = await buildApp({
      databaseUrl,
      config: { allowedOrigins: [allowedOrigin], publicBaseOrigin: allowedOrigin },
      sendMagicLink: async (_email, url) => { sent.push(url); },
    });
    const post = (payload: unknown) => app.inject({
      method: "POST", url: "/v1/auth/teacher/magic-link", payload,
      headers: { origin: allowedOrigin },
    });
    const responses = await Promise.all([
      post({ email: "teacher@example.edu" }), post({ email: "unknown@example.edu" }), post({ email: "not-email" }),
    ]);
    expect(responses.map((response) => [response.statusCode, response.body]))
      .toEqual([[202, '{"accepted":true}'], [202, '{"accepted":true}'], [202, '{"accepted":true}']]);
    expect(sent).toHaveLength(1);
    const audit = new Pool({ connectionString: databaseUrl });
    try {
      const stored = await audit.query("SELECT count(*)::int AS count FROM magic_link");
      expect(stored.rows[0]).toEqual({ count: 1 });
    } finally { await audit.end(); }
    await app.close();

    await seedTeacher("failure@example.edu");
    const senderFailed = await buildApp({
      databaseUrl, config: { allowedOrigins: [allowedOrigin], publicBaseOrigin: allowedOrigin },
      sendMagicLink: async () => { throw new Error("smtp unavailable"); },
    });
    const failed = await senderFailed.inject({ method: "POST", url: "/v1/auth/teacher/magic-link", payload: { email: "failure@example.edu" }, headers: { origin: allowedOrigin } });
    expect([failed.statusCode, failed.body]).toEqual([202, '{"accepted":true}']);
    expect(failed.body).not.toContain("smtp");
    await senderFailed.close();
  });

  it("stores only a hash and consumes a sent link exactly once without token leaks", async () => {
    const sent: string[] = [];
    await seedTeacher("teacher@example.edu");
    const app = await buildApp({
      databaseUrl,
      config: { allowedOrigins: [allowedOrigin], publicBaseOrigin: allowedOrigin },
      sendMagicLink: async (_email, url) => { sent.push(url); },
    });
    await app.inject({ method: "POST", url: "/v1/auth/teacher/magic-link", payload: { email: "teacher@example.edu" }, headers: { origin: allowedOrigin } });
    const token = new URL(sent[0]!).searchParams.get("token")!;
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const links = await pool.query<{ token_hash: Buffer }>("SELECT token_hash FROM magic_link");
      expect(links).toHaveProperty("rowCount", 1);
      expect(links.rows[0]?.token_hash.equals(createHash("sha256").update(token).digest())).toBe(true);
      expect(links.rows[0]?.token_hash.toString("utf8")).not.toContain(token);
    } finally { await pool.end(); }
    const [first, second] = await Promise.all([
      app.inject({ method: "GET", url: `/v1/auth/teacher/magic-link/consume?token=${encodeURIComponent(token)}` }),
      app.inject({ method: "GET", url: `/v1/auth/teacher/magic-link/consume?token=${encodeURIComponent(token)}` }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([303, 400]);
    const success = first.statusCode === 303 ? first : second;
    expect(success.headers.location).toBe("/teacher");
    expect(success.headers["set-cookie"]).toContain("HttpOnly");
    expect(success.headers["set-cookie"]).toContain("Secure");
    expect(success.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(success.headers["cache-control"]).toContain("no-store");
    expect(success.headers["referrer-policy"]).toBe("no-referrer");
    expect(`${first.body}${second.body}${first.headers.location ?? ""}${second.headers.location ?? ""}`).not.toContain(token);
    await app.close();
  });

  it("returns the same bounded recovery for sequential reuse and expiry", async () => {
    let now = new Date("2026-08-30T00:00:00.000Z");
    const sent: string[] = [];
    await seedTeacher("teacher@example.edu");
    const app = await buildApp({
      databaseUrl, clock: { now: () => now }, config: { allowedOrigins: [allowedOrigin], publicBaseOrigin: allowedOrigin },
      sendMagicLink: async (_email, url) => { sent.push(url); },
    });
    await app.inject({ method: "POST", url: "/v1/auth/teacher/magic-link", payload: { email: "teacher@example.edu" }, headers: { origin: allowedOrigin } });
    const oneUse = `/v1/auth/teacher/magic-link/consume?token=${encodeURIComponent(new URL(sent[0]!).searchParams.get("token")!)}`;
    expect((await app.inject({ method: "GET", url: oneUse })).statusCode).toBe(303);
    const reused = await app.inject({ method: "GET", url: oneUse });
    expect([reused.statusCode, reused.body]).toEqual([400, "This sign-in link is no longer available. Request a new link."]);
    await app.inject({ method: "POST", url: "/v1/auth/teacher/magic-link", payload: { email: "teacher@example.edu" }, headers: { origin: allowedOrigin } });
    now = new Date(now.getTime() + 15 * 60 * 1000 + 1);
    const expired = await app.inject({ method: "GET", url: `/v1/auth/teacher/magic-link/consume?token=${encodeURIComponent(new URL(sent[1]!).searchParams.get("token")!)}` });
    expect([expired.statusCode, expired.body]).toEqual([400, "This sign-in link is no longer available. Request a new link."]);
    await app.close();
  });
});
