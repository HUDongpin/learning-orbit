import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

import type { BrowserContext, Download, Page } from "@playwright/test";

import {
  browserStorageHasNoCredentialArtifacts,
  type BrowserStorageSafetyOptions,
} from "./browser-storage-safety.js";

const execFileAsync = promisify(execFile);
export const PILOT_PUBLIC_ORIGIN = process.env.LO_E2E_BASE_URL ?? "https://127.0.0.1:3000";
const PILOT_ADDRESS = /^pilot-[0-9a-f]{16}@example\.invalid$/u;
const ROOM_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/u;
const SEAT_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

export type RoomSocketObservation = {
  count: number;
  invalid: boolean;
  generation: number;
  ready: boolean;
  welcome: number;
  resumeComplete: number;
  durableEvents: number;
  acks: number;
  rejects: number;
  closed: number;
  socketErrors: number;
};

type MailpitMessage = unknown;
type MailpitClientLike = Readonly<{
  assertReady(): Promise<void>;
  findSingleMessage(recipient: string): Promise<string>;
  readMessage(id: string): Promise<MailpitMessage>;
  deleteRecipientMessages(recipient: string): Promise<void>;
  assertRecipientEmpty(recipient: string): Promise<void>;
}>;
type MailpitModule = Readonly<{
  MailpitClient: new () => MailpitClientLike;
  parseMagicLinkFromMessage(value: MailpitMessage): string;
}>;

export function fail(code: string): never {
  throw new Error(code);
}

export function observeRoomWebSockets(page: Page): RoomSocketObservation {
  const result: RoomSocketObservation = {
    count: 0,
    invalid: false,
    generation: 0,
    ready: false,
    welcome: 0,
    resumeComplete: 0,
    durableEvents: 0,
    acks: 0,
    rejects: 0,
    closed: 0,
    socketErrors: 0,
  };
  page.on("websocket", (socket) => {
    let url: URL;
    try { url = new URL(socket.url()); } catch { return; }
    if (!url.pathname.startsWith("/v1/rooms/")) return;
    result.count += 1;
    if (url.protocol !== "wss:" || url.origin !== PILOT_PUBLIC_ORIGIN.replace("https:", "wss:")
      || !/^\/v1\/rooms\/[0-9a-f-]{36}\/realtime$/iu.test(url.pathname)
      || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
      result.invalid = true;
    }
    const generation = result.generation + 1;
    result.generation = generation;
    result.ready = false;
    let currentWelcome = false;
    let currentResumeComplete = false;
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string" || payload.length > 1_000_000) return;
      let value: unknown;
      try { value = JSON.parse(payload); } catch { return; }
      const type = value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).type : undefined;
      if (type === "welcome") {
        result.welcome += 1;
        if (result.generation === generation) currentWelcome = true;
      } else if (type === "resume_complete") {
        result.resumeComplete += 1;
        if (result.generation === generation) currentResumeComplete = true;
      } else if (type === "event") {
        result.durableEvents += 1;
      } else if (type === "ack") {
        result.acks += 1;
      } else if (type === "reject") {
        result.rejects += 1;
      }
      if (result.generation === generation) {
        result.ready = currentWelcome && currentResumeComplete;
      }
    });
    socket.on("close", () => {
      result.closed += 1;
      if (result.generation === generation) result.ready = false;
    });
    socket.on("socketerror", () => {
      result.socketErrors += 1;
      if (result.generation === generation) result.ready = false;
    });
  });
  return result;
}

export function pilotTeacherAddress(): string {
  const value = process.env.LO_PILOT_TEACHER_ADDRESS;
  if (typeof value !== "string" || !PILOT_ADDRESS.test(value)) {
    fail("PILOT_TEACHER_ADDRESS_REQUIRED");
  }
  return value;
}

export function assertRoomCode(value: unknown): asserts value is string {
  if (typeof value !== "string" || !ROOM_CODE.test(value)) fail("PILOT_ROOM_CODE_INVALID");
}

export function assertSeatCode(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SEAT_CODE.test(value)) fail("PILOT_SEAT_CODE_INVALID");
}

export function assertRoomId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) fail("PILOT_ROOM_ID_INVALID");
}

export async function provisionPilotTeacher(email: string): Promise<void> {
  if (!PILOT_ADDRESS.test(email) || typeof process.env.DATABASE_URL !== "string") {
    fail("PILOT_TEACHER_PROVISION_ENVIRONMENT_INVALID");
  }
  const cli = path.resolve(process.cwd(), "apps/server/dist/src/teacher-provision-cli.js");
  const invoke = async (expected: "0" | "1") => {
    let result: Awaited<ReturnType<typeof execFileAsync>>;
    try {
      result = await execFileAsync(process.execPath, [cli, "--email", email], {
        cwd: process.cwd(),
        env: { ...process.env },
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 15_000,
        windowsHide: true,
      });
    } catch {
      fail("PILOT_TEACHER_PROVISION_FAILED");
    }
    if (result.stdout !== `inserted: ${expected}\n` || result.stderr !== "") {
      fail("PILOT_TEACHER_PROVISION_OUTPUT_INVALID");
    }
  };
  await invoke("1");
  await invoke("0");
}

const delay = (milliseconds: number) => new Promise<void>((resolvePromise) => {
  setTimeout(resolvePromise, milliseconds);
});

async function mailpitModule(): Promise<MailpitModule> {
  const moduleUrl = pathToFileURL(path.resolve(process.cwd(), "scripts/local-pilot/mailpit.mjs")).href;
  try {
    return await import(moduleUrl) as unknown as MailpitModule;
  } catch {
    fail("PILOT_MAILPIT_HELPER_UNAVAILABLE");
  }
}

export async function clearPilotRecipientMail(recipient: string): Promise<void> {
  if (!PILOT_ADDRESS.test(recipient)) fail("PILOT_MAILPIT_RECIPIENT_INVALID");
  const module = await mailpitModule();
  const client = new module.MailpitClient();
  await client.deleteRecipientMessages(recipient);
  await client.assertRecipientEmpty(recipient);
}

export async function readSingleMagicLink(recipient: string): Promise<string> {
  if (!PILOT_ADDRESS.test(recipient)) fail("PILOT_MAILPIT_RECIPIENT_INVALID");
  const module = await mailpitModule();
  const client = new module.MailpitClient();
  await client.assertReady();
  let messageId: string | undefined;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      messageId = await client.findSingleMessage(recipient);
      break;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "MAILPIT_MESSAGE_NOT_READY") throw error;
      await delay(250);
    }
  }
  if (!messageId) fail("PILOT_MAILPIT_MESSAGE_TIMEOUT");
  const message = await client.readMessage(messageId);
  const link = module.parseMagicLinkFromMessage(message);
  const parsed = new URL(link);
  if (parsed.origin !== PILOT_PUBLIC_ORIGIN
    || parsed.pathname !== "/v1/auth/teacher/magic-link/consume"
    || parsed.searchParams.getAll("token").length !== 1) {
    fail("PILOT_MAGIC_LINK_INVALID");
  }
  return link;
}

export async function assertSecureSessionCookie(context: BrowserContext): Promise<void> {
  const matches = (await context.cookies(PILOT_PUBLIC_ORIGIN)).filter(({ name }) => name === "lo_session");
  const cookie = matches[0];
  if (matches.length !== 1 || !cookie || cookie.value.length < 8 || !cookie.httpOnly
    || !cookie.secure || cookie.sameSite !== "Lax" || cookie.path !== "/"
    || cookie.domain !== "127.0.0.1") {
    fail("PILOT_SESSION_COOKIE_INVALID");
  }
}

export async function assertNoSessionCookie(context: BrowserContext): Promise<void> {
  if ((await context.cookies(PILOT_PUBLIC_ORIGIN)).some(({ name }) => name === "lo_session")) {
    fail("PILOT_SESSION_COOKIE_NOT_CLEARED");
  }
}

export async function assertTeacherSession(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const response = await fetch("/v1/auth/session", { credentials: "include", cache: "no-store" });
    let value: unknown;
    try { value = await response.json(); } catch { return { status: response.status, valid: false }; }
    const body = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
    return {
      status: response.status,
      valid: body.role === "teacher"
        && typeof body.teacherId === "string"
        && typeof body.actorId === "string"
        && !Object.hasOwn(body, "email"),
    };
  });
  if (result.status !== 200 || !result.valid) fail("PILOT_TEACHER_SESSION_INVALID");
}

export async function assertStudentSession(page: Page, roomId: string, pseudonym: string): Promise<void> {
  const result = await page.evaluate(async ({ expectedRoomId, expectedPseudonym }) => {
    const response = await fetch("/v1/auth/session", { credentials: "include", cache: "no-store" });
    let value: unknown;
    try { value = await response.json(); } catch { return { status: response.status, valid: false }; }
    const body = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
    const nova = body.nova && typeof body.nova === "object" && !Array.isArray(body.nova)
      ? body.nova as Record<string, unknown> : {};
    return {
      status: response.status,
      valid: body.role === "student"
        && body.roomId === expectedRoomId
        && body.pseudonym === expectedPseudonym
        && typeof body.roomMemberId === "string"
        && typeof body.actorId === "string"
        && nova.actorKind === "agent"
        && nova.actorRole === "socratic_facilitator"
        && typeof nova.actorId === "string"
        && !Object.hasOwn(body, "name")
        && !Object.hasOwn(body, "email"),
    };
  }, { expectedRoomId: roomId, expectedPseudonym: pseudonym });
  if (result.status !== 200 || !result.valid) fail("PILOT_STUDENT_SESSION_INVALID");
}

export async function assertSessionMissing(page: Page): Promise<void> {
  const status = await page.evaluate(async () => (
    await fetch("/v1/auth/session", { credentials: "include", cache: "no-store" })
  ).status);
  if (status !== 401) fail("PILOT_SESSION_NOT_REVOKED");
}

export async function assertNoBrowserCredentialArtifacts(
  page: Page,
  options: BrowserStorageSafetyOptions = {},
): Promise<void> {
  try {
    await page.waitForFunction(() => {
      const requestId = Reflect.get(self, "__next_r");
      return requestId === undefined
        || (typeof requestId === "string"
          && /^[A-Za-z0-9_-]{1,64}$/u.test(requestId)
          && sessionStorage.getItem(`__next_debug_channel:${requestId}`) !== null);
    }, undefined, { timeout: 10_000 });
  } catch {
    fail("PILOT_BROWSER_STORAGE_NOT_STABLE");
  }
  const storageSafe = await page.evaluate(browserStorageHasNoCredentialArtifacts, options);
  const result = await page.evaluate(() => ({
    httpOnlyHidden: !document.cookie.includes("lo_session"),
    noTokenText: !/(?:token=|magic-link\/consume|lo_session=)/iu.test(document.body.innerText),
  }));
  if (!storageSafe || !result.httpOnlyHidden || !result.noTokenText) {
    fail("PILOT_BROWSER_CREDENTIAL_ARTIFACT");
  }
}

export async function assertNoUuidInVisibleText(page: Page): Promise<void> {
  const exposed = await page.evaluate(() => (
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu
      .test(document.body.innerText)
  ));
  if (exposed) fail("PILOT_UUID_VISIBLE_IN_DOM");
}

export async function readDownloadText(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  if (!stream) fail("PILOT_DOWNLOAD_STREAM_UNAVAILABLE");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    total += bytes.byteLength;
    if (!Number.isSafeInteger(total) || total > MAX_DOWNLOAD_BYTES) {
      stream.destroy();
      fail("PILOT_DOWNLOAD_TOO_LARGE");
    }
    chunks.push(bytes);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    fail("PILOT_DOWNLOAD_UTF8_INVALID");
  }
}

export function assertSafeDownloadName(value: string, format: "json" | "csv"): void {
  if (value !== `learning-orbit-room-export.${format}` || /[\\/\r\n\u0000]/u.test(value)) {
    fail("PILOT_DOWNLOAD_FILENAME_INVALID");
  }
}
