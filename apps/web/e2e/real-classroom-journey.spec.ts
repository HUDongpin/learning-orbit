import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { routes } from "@learning-orbit/contracts";

import {
  PILOT_PUBLIC_ORIGIN,
  assertNoBrowserCredentialArtifacts,
  assertNoSessionCookie,
  assertNoUuidInVisibleText,
  assertRoomCode,
  assertRoomId,
  assertSafeDownloadName,
  assertSeatCode,
  assertSecureSessionCookie,
  assertSessionMissing,
  assertStudentSession,
  assertTeacherSession,
  clearPilotRecipientMail,
  fail,
  pilotTeacherAddress,
  provisionPilotTeacher,
  readDownloadText,
  readSingleMagicLink,
  observeRoomWebSockets,
  type RoomSocketObservation,
} from "./pilot-journey-helpers";

const TOPIC = "生態系統探究";
const TEACHER_ACCEPTED_COPY = "如果此電郵已獲授權，登入連結將會送出。請檢查收件匣。";
const PSEUDONYMS = ["探索者 A", "探索者 B", "探索者 C", "探索者 D"] as const;
const REQUIRED_VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
] as const;

type Invite = Readonly<{ pseudonym: typeof PSEUDONYMS[number]; code: string }>;
type StudentBrowser = Readonly<{ context: BrowserContext; page: Page; pseudonym: typeof PSEUDONYMS[number] }>;
type TeacherProjectionKey = "echo.teacher_shadow" | "trace.teacher_bundle";

async function assertNoPageOverflow(page: Page, code: string): Promise<void> {
  const valid = await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
    && document.body.scrollWidth <= document.body.clientWidth
  ));
  if (!valid) fail(`PILOT_REFLOW_${code}`);
}

async function assertStudentComposerState(
  page: Page,
  studentIndex: number,
  enabled: boolean,
  socket: RoomSocketObservation,
): Promise<void> {
  try {
    const assertion = expect(page.getByLabel("輸入訊息"));
    if (enabled) await assertion.toBeEnabled({ timeout: 30_000 });
    else await assertion.toBeDisabled({ timeout: 30_000 });
  } catch {
    const status = (await page.locator(".teacher-status").first().textContent({ timeout: 1_000 }).catch(() => null))?.trim();
    const statusCode = status === "尚未開始" ? "SCHEDULED"
      : status === "進行中" ? "OPEN"
        : status === "已暫停" ? "PAUSED"
          : status === "已結束" ? "CLOSED"
            : "UNKNOWN";
    const flag = (value: number) => Math.min(9, Math.max(0, value));
    fail(`PILOT_STUDENT_${studentIndex + 1}_COMPOSER_${enabled ? "DISABLED" : "ENABLED"}_${statusCode}`
      + `_W${flag(socket.welcome)}_R${flag(socket.resumeComplete)}_E${flag(socket.durableEvents)}`
      + `_A${flag(socket.acks)}_D${flag(socket.rejects)}`
      + `_C${flag(socket.closed)}_X${flag(socket.socketErrors)}`);
  }
}

async function readTeacherBoundaryState(page: Page, roomId: string): Promise<{
  surface: number;
  sessionStatus: number;
  roomStatus: number;
  closeCodes: string[];
}> {
  return page.evaluate(async ({ sessionPath, roomPath }) => {
    const headings = [...document.querySelectorAll("h1")]
      .map((heading) => heading.textContent?.trim() ?? "");
    const surface = headings.includes("生態系統探究") ? 1
      : headings.includes("即時同步已停止") ? 2
        : headings.includes("目前的 Session 無法再開啟這個課堂") ? 3
          : headings.includes("課堂服務暫時不可用") ? 4
            : headings.includes("無法開啟這個課堂") ? 5 : 0;
    // A socket that dropped has to say why: 4401/4403/4410 mean the server
    // ended it, 1006 means the transport did.
    const closeCodes = (window as unknown as { __loCloseCodes?: string[] }).__loCloseCodes ?? [];
    const [sessionResponse, roomResponse] = await Promise.all([
      fetch(sessionPath, { credentials: "include", cache: "no-store" }),
      fetch(roomPath, { credentials: "include", cache: "no-store" }),
    ]);
    return { surface, sessionStatus: sessionResponse.status, roomStatus: roomResponse.status, closeCodes };
  }, { sessionPath: routes.auth.session(), roomPath: routes.rooms.get(roomId) })
    .catch(() => ({ surface: 9, sessionStatus: 0, roomStatus: 0, closeCodes: [] }));
}

function socketDiagnosticCode(socket: RoomSocketObservation): string {
  const bounded = (value: number) => Math.min(9, Math.max(0, value));
  return `G${bounded(socket.generation)}N${bounded(socket.count)}`
    + `W${bounded(socket.welcome)}R${bounded(socket.resumeComplete)}E${bounded(socket.durableEvents)}`
    + `A${bounded(socket.acks)}D${bounded(socket.rejects)}`
    + `C${bounded(socket.closed)}X${bounded(socket.socketErrors)}Y${socket.ready ? 1 : 0}`
    // 4401/4403/4410 mean the server ended the socket; 1006 means the
    // transport dropped it. Without this a close says only that it happened.
    + `K${socket.closeCodes.length === 0 ? "none" : socket.closeCodes.join("-")}`;
}

async function countUndersizedTargets(page: Page): Promise<number> {
  return page.evaluate(() => {
    const candidates = document.querySelectorAll<HTMLElement>(
      "button, a[href], input:not([type='hidden']), textarea, select, audio[controls]",
    );
    return [...candidates].filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const hidden = style.display === "none" || style.visibility === "hidden"
        || element.getAttribute("aria-hidden") === "true"
        || (element instanceof HTMLInputElement && element.type === "file" && element.classList.contains("sr-only"));
      return !hidden && rect.width > 0 && rect.height > 0
        && (rect.width < 43.5 || rect.height < 43.5);
    }).length;
  });
}

async function assertProtectedSurfaceQuality(page: Page, code: string): Promise<void> {
  for (const viewport of REQUIRED_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await assertNoPageOverflow(page, `${code}_${viewport.width}`);
    if (await countUndersizedTargets(page) !== 0) {
      fail(`PILOT_TARGET_SIZE_${code}_${viewport.width}`);
    }
  }

  // Chromium headless does not expose browser-chrome zoom controls. This CDP
  // profile gives a 1280×900 physical screen a 640×450 CSS viewport at DPR 2,
  // the same reflow pressure as 200% browser zoom, before restoring the normal
  // viewport for keyboard/axe checks.
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 640,
      height: 450,
      screenWidth: 1280,
      screenHeight: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const metrics = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio,
    }));
    if (metrics.width !== 640 || metrics.height !== 450 || metrics.devicePixelRatio !== 2) {
      fail(`PILOT_ZOOM_PROFILE_${code}`);
    }
    await assertNoPageOverflow(page, `${code}_ZOOM_200`);
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.detach();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page }).analyze();
  if (axe.violations.length !== 0) {
    const ruleIds = [...new Set(axe.violations.map(({ id }) => id))]
      .sort().join("_").toUpperCase().replaceAll(/[^A-Z0-9_]/gu, "_").slice(0, 240);
    fail(`PILOT_AXE_${code}_${ruleIds || "UNKNOWN_RULE"}`);
  }
}

async function readTeacherProjectionAuthority(
  page: Page,
  roomId: string,
  projectionKey: TeacherProjectionKey,
): Promise<Readonly<{
  analysisEpoch: string;
  completeThroughRoomSeq: number;
  projectionVersion: number;
}>> {
  const result = await page.evaluate(async ({ path, expectedProjectionKey, expectedRoomId }) => {
    const response = await fetch(path, { credentials: "include", cache: "no-store" });
    let body: unknown;
    try { body = await response.json(); } catch { return { valid: false } as const; }
    const value = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown> : {};
    return {
      valid: response.status === 200
        && value.roomId === expectedRoomId
        && value.projectionKey === expectedProjectionKey
        && typeof value.analysisEpoch === "string"
        && typeof value.completeThroughRoomSeq === "number"
        && typeof value.projectionVersion === "number",
      analysisEpoch: value.analysisEpoch,
      completeThroughRoomSeq: value.completeThroughRoomSeq,
      projectionVersion: value.projectionVersion,
    };
  }, {
    path: routes.analytics.latest(roomId, projectionKey),
    expectedProjectionKey: projectionKey,
    expectedRoomId: roomId,
  });
  if (!result.valid || typeof result.analysisEpoch !== "string"
    || typeof result.completeThroughRoomSeq !== "number"
    || !Number.isSafeInteger(result.completeThroughRoomSeq)
    || result.completeThroughRoomSeq < 0
    || typeof result.projectionVersion !== "number"
    || !Number.isSafeInteger(result.projectionVersion)) {
    fail(projectionKey === "echo.teacher_shadow"
      ? "PILOT_ECHO_AUTHORITY_INVALID"
      : "PILOT_TRACE_AUTHORITY_INVALID");
  }
  return {
    analysisEpoch: result.analysisEpoch,
    completeThroughRoomSeq: result.completeThroughRoomSeq,
    projectionVersion: result.projectionVersion,
  };
}

function readTeacherEchoAuthority(page: Page, roomId: string) {
  return readTeacherProjectionAuthority(page, roomId, "echo.teacher_shadow");
}

function readTeacherTraceAuthority(page: Page, roomId: string) {
  return readTeacherProjectionAuthority(page, roomId, "trace.teacher_bundle");
}

async function submitTeacherAnalyticsFact(
  page: Page,
  roomId: string,
  buttonName: "提交審閱" | "提交修正",
): Promise<void> {
  const responsePromise = page.waitForResponse((response) => {
    try {
      return new URL(response.url()).pathname === routes.analytics.reviews(roomId)
        && response.request().method() === "POST";
    } catch {
      return false;
    }
  });
  await page.getByRole("button", { name: buttonName }).click();
  const response = await responsePromise;
  if (response.status() !== 200 && response.status() !== 201) {
    fail(buttonName === "提交審閱"
      ? "PILOT_REVIEW_REQUEST_REJECTED"
      : "PILOT_CORRECTION_REQUEST_REJECTED");
  }
}

async function readRoomThroughSeq(page: Page, roomId: string): Promise<number> {
  const result = await page.evaluate(async ({ path, expectedRoomId }) => {
    const response = await fetch(path, { credentials: "include", cache: "no-store" });
    let body: unknown;
    try { body = await response.json(); } catch { return { valid: false } as const; }
    const value = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown> : {};
    const events = Array.isArray(value.events) ? value.events : [];
    return {
      valid: response.status === 200
        && Array.isArray(value.events)
        && Number.isSafeInteger(value.throughRoomSeq)
        && events.every((event) => event && typeof event === "object" && !Array.isArray(event)
          && (event as Record<string, unknown>).roomId === expectedRoomId
          && Number.isSafeInteger((event as Record<string, unknown>).roomSeq)),
      throughRoomSeq: value.throughRoomSeq,
    };
  }, { path: routes.rooms.events(roomId, { afterSeq: 0, limit: 500 }), expectedRoomId: roomId });
  if (!result.valid || typeof result.throughRoomSeq !== "number"
    || !Number.isSafeInteger(result.throughRoomSeq) || result.throughRoomSeq < 0) {
    fail("PILOT_ROOM_CURSOR_INVALID");
  }
  return result.throughRoomSeq;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertTeacherJsonExport(text: string, roomId: string, codes: readonly string[]): void {
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail("PILOT_JSON_EXPORT_INVALID"); }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.exportKind !== "teacher_room"
    || value.roomId !== roomId || !Number.isSafeInteger(value.throughRoomSeq)
    || !Array.isArray(value.events) || value.throughRoomSeq !== value.events.length
    || !Array.isArray(value.artifacts) || !Array.isArray(value.projections)
    || !isRecord(value.provenance)) {
    fail("PILOT_JSON_EXPORT_INVALID");
  }
  if (value.events.length < 5 || !value.events.every((event) => isRecord(event) && event.roomId === roomId)) {
    fail("PILOT_JSON_EXPORT_EVENT_CORRELATION_INVALID");
  }
  if (!value.artifacts.every((artifact) => isRecord(artifact)
    && ["approved", "corrected"].includes(String(artifact.reviewStatus)))) {
    fail("PILOT_JSON_EXPORT_ARTIFACT_POLICY_INVALID");
  }
  if (!value.projections.every((projection) => isRecord(projection)
    && ["echo.teacher_shadow", "trace.teacher_bundle"].includes(String(projection.projectionKey)))) {
    fail("PILOT_JSON_EXPORT_ROLE_BOUNDARY_INVALID");
  }
  const forbiddenKey = /(?:token|cookie|secret|password|api[-_]?key|confidence|content)/iu;
  const walk = (candidate: unknown): void => {
    if (Array.isArray(candidate)) { candidate.forEach(walk); return; }
    if (!isRecord(candidate)) return;
    for (const [key, child] of Object.entries(candidate)) {
      if (forbiddenKey.test(key)) fail("PILOT_JSON_EXPORT_PROVENANCE_LEAK");
      walk(child);
    }
  };
  walk(value.provenance);
  if (codes.some((code) => text.includes(code))) fail("PILOT_JSON_EXPORT_INVITE_LEAK");
}

async function consumeStatus(page: Page, link: string): Promise<number> {
  const responsePromise = page.waitForResponse((response) => {
    try { return new URL(response.url()).pathname === "/v1/auth/teacher/magic-link/consume"; }
    catch { return false; }
  });
  try {
    await page.goto(link, { waitUntil: "domcontentloaded" });
    return (await responsePromise).status();
  } catch {
    fail("PILOT_MAGIC_LINK_NAVIGATION_FAILED");
  }
}

test("real teacher and four-student classroom journey remains server-authoritative and fail-closed", async ({ browser }) => {
  test.setTimeout(600_000);
  const contexts = new Set<BrowserContext>();
  const openContext = async () => {
    const context = await browser.newContext({
      baseURL: PILOT_PUBLIC_ORIGIN,
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
    });
    contexts.add(context);
    return context;
  };
  const closeContext = async (context: BrowserContext) => {
    contexts.delete(context);
    await context.close();
  };

  try {
    const teacherAddress = pilotTeacherAddress();
    await test.step("provision teacher and request non-enumerating Magic Link", async () => {
      await provisionPilotTeacher(teacherAddress);
    });

    const anonymousContext = await openContext();
    const anonymousPage = await anonymousContext.newPage();
    await anonymousPage.goto("/login?role=teacher");
    await expect(anonymousPage.getByRole("heading", { name: "教師登入" })).toBeVisible();
    await anonymousPage.getByLabel("教師電郵").fill("not-provisioned@example.invalid");
    await anonymousPage.getByRole("button", { name: "傳送登入連結" }).click();
    await expect(anonymousPage.getByRole("status")).toHaveText(TEACHER_ACCEPTED_COPY);
    await anonymousPage.goto("/teacher");
    await expect(anonymousPage).toHaveURL(/\/login\?role=teacher$/u);
    await anonymousPage.getByLabel("教師電郵").fill(teacherAddress);
    await anonymousPage.getByRole("button", { name: "傳送登入連結" }).click();
    await expect(anonymousPage.getByRole("status")).toHaveText(TEACHER_ACCEPTED_COPY);
    await assertNoBrowserCredentialArtifacts(anonymousPage, { forbiddenValues: [teacherAddress] });

    let firstMagicLink: string | undefined = await readSingleMagicLink(teacherAddress);
    await closeContext(anonymousContext);

    const bootstrapTeacherContext = await openContext();
    const bootstrapTeacherPage = await bootstrapTeacherContext.newPage();
    if (!firstMagicLink) fail("PILOT_MAGIC_LINK_MISSING");
    const firstConsumeStatus = await consumeStatus(bootstrapTeacherPage, firstMagicLink);
    if (firstConsumeStatus !== 303) fail("PILOT_MAGIC_LINK_CONSUME_STATUS_INVALID");
    await expect(bootstrapTeacherPage).toHaveURL(/\/teacher$/u);
    await expect(bootstrapTeacherPage.getByRole("heading", { name: "教師工作台" })).toBeVisible();
    await assertTeacherSession(bootstrapTeacherPage);
    await assertSecureSessionCookie(bootstrapTeacherContext);
    await assertNoBrowserCredentialArtifacts(bootstrapTeacherPage, { forbiddenValues: [teacherAddress] });
    await bootstrapTeacherPage.getByRole("button", { name: "登出" }).click();
    await expect(bootstrapTeacherPage).toHaveURL(/\/login\?role=teacher$/u);
    await assertSessionMissing(bootstrapTeacherPage);
    await assertNoSessionCookie(bootstrapTeacherContext);
    await closeContext(bootstrapTeacherContext);

    const reuseContext = await openContext();
    const reusePage = await reuseContext.newPage();
    const reusedStatus = await consumeStatus(reusePage, firstMagicLink);
    await reusePage.goto("/login?role=teacher");
    if (reusedStatus !== 400) fail("PILOT_MAGIC_LINK_REUSE_NOT_REJECTED");
    await assertSessionMissing(reusePage);
    await closeContext(reuseContext);
    firstMagicLink = undefined;
    await clearPilotRecipientMail(teacherAddress);

    const journeyLoginContext = await openContext();
    const journeyLoginPage = await journeyLoginContext.newPage();
    await journeyLoginPage.goto("/login?role=teacher");
    await journeyLoginPage.getByLabel("教師電郵").fill(teacherAddress);
    await journeyLoginPage.getByRole("button", { name: "傳送登入連結" }).click();
    await expect(journeyLoginPage.getByRole("status")).toHaveText(TEACHER_ACCEPTED_COPY);
    let journeyMagicLink: string | undefined = await readSingleMagicLink(teacherAddress);
    await closeContext(journeyLoginContext);

    const teacherContext = await openContext();
    const teacherPage = await teacherContext.newPage();
    const socketObservations: RoomSocketObservation[] = [observeRoomWebSockets(teacherPage)];
    if (!journeyMagicLink) fail("PILOT_MAGIC_LINK_MISSING");
    const journeyConsumeStatus = await consumeStatus(teacherPage, journeyMagicLink);
    if (journeyConsumeStatus !== 303) fail("PILOT_MAGIC_LINK_CONSUME_STATUS_INVALID");
    journeyMagicLink = undefined;
    await expect(teacherPage).toHaveURL(/\/teacher$/u);
    await expect(teacherPage.getByRole("heading", { name: "教師工作台" })).toBeVisible();
    await assertTeacherSession(teacherPage);
    await assertSecureSessionCookie(teacherContext);
    await assertNoBrowserCredentialArtifacts(teacherPage, { forbiddenValues: [teacherAddress] });
    await assertProtectedSurfaceQuality(teacherPage, "TEACHER_WORKSPACE");

    let roomCode = "";
    let roomId = "";
    let invites: Invite[] = [];
    await test.step("create room and consume the one-time invite display", async () => {
      await teacherPage.getByRole("button", { name: "建立新課堂" }).click();
      const roomCodeLocator = teacherPage.locator(".room-code-row strong");
      await expect(roomCodeLocator).toBeVisible();
      roomCode = (await roomCodeLocator.textContent())?.trim() ?? "";
      assertRoomCode(roomCode);
      const rawInvites = await teacherPage.locator(".seat-code-list li").evaluateAll((rows) => rows.map((row) => ({
        pseudonym: row.querySelector("span")?.textContent?.trim() ?? "",
        code: row.querySelector("strong")?.textContent?.trim() ?? "",
      })));
      if (rawInvites.length !== 4 || new Set(rawInvites.map(({ code }) => code)).size !== 4) {
        fail("PILOT_SEAT_INVITES_INVALID");
      }
      invites = rawInvites.map(({ pseudonym, code }, index) => {
        if (pseudonym !== PSEUDONYMS[index]) fail("PILOT_STUDENT_PSEUDONYM_ORDER_INVALID");
        assertSeatCode(code);
        return { pseudonym, code } as Invite;
      });
      await assertProtectedSurfaceQuality(teacherPage, "ONE_TIME_INVITES");
      await teacherPage.getByRole("button", { name: "我已安全保存代碼" }).click();
      await expect(teacherPage.locator(".invite-card, .room-code-row, .seat-code-list")).toHaveCount(0);
      const inviteLeaked = await teacherPage.evaluate((codes) => codes.some((code) => document.body.innerText.includes(code)), [roomCode, ...invites.map(({ code }) => code)]);
      if (inviteLeaked) fail("PILOT_INVITE_CODE_REDISPLAYED");
      const href = await teacherPage.getByRole("link", { name: "開啟新課堂" }).getAttribute("href");
      const match = /^\/session\/([0-9a-f-]{36})\/teacher$/iu.exec(href ?? "");
      roomId = match?.[1] ?? "";
      assertRoomId(roomId);
    });

    await teacherPage.goto(`/session/${roomId}`);
    await teacherPage.waitForURL((url) => url.pathname === `/session/${roomId}/teacher`);
    await expect(teacherPage.getByRole("heading", { name: TOPIC })).toBeVisible();
    await expect(teacherPage.getByText("教師房間控制台")).toBeVisible();
    await teacherPage.reload();
    await expect(teacherPage.getByRole("heading", { name: TOPIC })).toBeVisible();
    await assertNoBrowserCredentialArtifacts(teacherPage, {
      allowedUuids: [roomId],
      forbiddenValues: [teacherAddress, roomCode, ...invites.map(({ code }) => code)],
    });

    const students: StudentBrowser[] = [];
    await test.step("join four students and confirm server-assigned anonymous identities", async () => {
      for (const invite of invites) {
        const context = await openContext();
        const page = await context.newPage();
        socketObservations.push(observeRoomWebSockets(page));
        await page.goto("/login");
        await page.getByLabel("房間代碼").fill(roomCode);
        await page.getByLabel("座位代碼").fill(invite.code);
        await page.getByRole("button", { name: "加入課堂" }).click();
        await page.waitForURL((url) => url.pathname === `/session/${roomId}`);
        await expect(page.getByRole("heading", { name: TOPIC })).toBeVisible();
        await expect(page.locator(".room-gate-heading .login-eyebrow")).toHaveText(invite.pseudonym);
        await assertStudentSession(page, roomId, invite.pseudonym);
        await assertSecureSessionCookie(context);
        await assertNoBrowserCredentialArtifacts(page, {
          allowedUuids: [roomId],
          forbiddenValues: [roomCode, invite.code],
        });
        students.push({ context, page, pseudonym: invite.pseudonym });
      }
      await Promise.all(students.map(async ({ page, pseudonym }) => {
        await page.reload();
        await expect(page.getByRole("heading", { name: TOPIC })).toBeVisible();
        await assertStudentSession(page, roomId, pseudonym);
        await assertNoBrowserCredentialArtifacts(page, {
          allowedUuids: [roomId],
          forbiddenValues: [roomCode, ...invites.map(({ code }) => code)],
        });
      }));
      await assertProtectedSurfaceQuality(teacherPage, "TEACHER_ROOM");
      await assertProtectedSurfaceQuality(students[0]!.page, "STUDENT_ROOM");
    });

    const anonymousRoomContext = await openContext();
    const anonymousRoomPage = await anonymousRoomContext.newPage();
    await anonymousRoomPage.goto(`/session/${roomId}/teacher`);
    await expect(anonymousRoomPage).toHaveURL(/\/login\?role=teacher$/u);
    await anonymousRoomPage.goto(`/session/${roomId}`);
    await expect(anonymousRoomPage).toHaveURL(/\/login$/u);
    await closeContext(anonymousRoomContext);

    const hostileOrigin = await teacherPage.request.get(`${PILOT_PUBLIC_ORIGIN}/v1/auth/session`, {
      headers: { origin: "https://attacker.invalid" },
    });
    if (hostileOrigin.status() !== 403
      || (await hostileOrigin.json() as { code?: unknown }).code !== "ORIGIN_FORBIDDEN") {
      fail("PILOT_WRONG_ORIGIN_NOT_REJECTED");
    }

    await students[0]!.page.goto("/teacher");
    await expect(students[0]!.page.getByRole("heading", { name: "這個頁面只供教師使用" })).toBeVisible();
    await students[0]!.page.getByRole("link", { name: "返回我的課堂" }).click();
    await expect(students[0]!.page.getByRole("heading", { name: TOPIC })).toBeVisible();
    await students[1]!.page.goto(`/session/${roomId}/teacher`);
    await expect(students[1]!.page.getByRole("heading", { name: "無法開啟這個課堂" })).toBeVisible();
    await students[1]!.page.goto(`/session/${roomId}`);
    await expect(students[1]!.page.getByRole("heading", { name: TOPIC })).toBeVisible();

    await test.step("drive lifecycle and real WSS RoomEvent chat", async () => {
      const firstMessage = "池塘中的太陽讓生產者獲得能量。";
      const revisedMessage = "池塘中的太陽讓生產者獲得能量，也支持食物鏈。";
      const replyMessage = "我同意，并想追问能量如何传到消费者。";
      await test.step("open room and enable composers", async () => {
        await test.step("teacher WSS ready", async () => {
          await expect(teacherPage.getByText("WebSocket 已連線").first()).toBeVisible({ timeout: 30_000 });
        });
        await test.step("credential-free classroom sockets ready", async () => {
          try {
            await expect.poll(() => socketObservations.every(({ count, invalid, ready }) => (
              count >= 1 && ready && !invalid
            )), {
              message: "every classroom client must complete a credential-free same-origin WSS handshake",
              timeout: 30_000,
            }).toBe(true);
          } catch {
            const pages = [teacherPage, ...students.map(({ page }) => page)];
            const uiReady = await Promise.all(pages.map((page) => (
              page.getByText("WebSocket 已連線").first().isVisible().catch(() => false)
            )));
            const bounded = (value: number) => Math.min(9, Math.max(0, value));
            const observations = socketObservations.map((socket, index) => (
              `${index === 0 ? "T" : `S${index}`}`
              + `G${bounded(socket.generation)}N${bounded(socket.count)}`
              + `W${bounded(socket.welcome)}R${bounded(socket.resumeComplete)}`
              + `E${bounded(socket.durableEvents)}A${bounded(socket.acks)}D${bounded(socket.rejects)}`
              + `C${bounded(socket.closed)}X${bounded(socket.socketErrors)}`
              + `Y${socket.ready ? 1 : 0}I${socket.invalid ? 1 : 0}U${uiReady[index] ? 1 : 0}`
            )).join("_");
            fail(`PILOT_SOCKET_HANDSHAKE_NOT_READY_${observations}`);
          }
        });
        await test.step("send room open command", async () => {
          const openButton = teacherPage.getByRole("button", { name: "開始課堂" });
          await expect(openButton).toBeEnabled({ timeout: 30_000 });
          await openButton.click();
        });
        await test.step("teacher receives room open event", async () => {
          await expect(teacherPage.getByText("伺服器 RoomEvent 已確認新的課堂狀態。")).toBeVisible({ timeout: 30_000 });
        });
        await test.step("students receive room open event", async () => {
          await Promise.all(students.map(({ page }, index) => (
            assertStudentComposerState(page, index, true, socketObservations[index + 1]!)
          )));
        });
      });

      await test.step("pause and resume room", async () => {
        await test.step("send pause command", async () => {
          const pauseButton = teacherPage.getByRole("button", { name: "暫停課堂" });
          try {
            await expect(pauseButton).toBeEnabled({ timeout: 30_000 });
            await pauseButton.click({ timeout: 30_000 });
          } catch {
            const boundary = await readTeacherBoundaryState(teacherPage, roomId);
            fail(`PILOT_PAUSE_COMMAND_UNAVAILABLE_K${boundary.closeCodes.join("-") || "none"}_H${boundary.surface}`
              + `Q${boundary.sessionStatus}O${boundary.roomStatus}_${socketDiagnosticCode(socketObservations[0]!)}`);
          }
        });
        await test.step("students receive pause event", async () => {
          await Promise.all(students.map(({ page }, index) => (
            assertStudentComposerState(page, index, false, socketObservations[index + 1]!)
          )));
        });
        await test.step("send resume command", async () => {
          const resumeButton = teacherPage.getByRole("button", { name: "繼續課堂" });
          try {
            await expect(resumeButton).toBeEnabled({ timeout: 30_000 });
            await resumeButton.click({ timeout: 30_000 });
          } catch {
            const boundary = await readTeacherBoundaryState(teacherPage, roomId);
            fail(`PILOT_RESUME_COMMAND_UNAVAILABLE_K${boundary.closeCodes.join("-") || "none"}_H${boundary.surface}`
              + `Q${boundary.sessionStatus}O${boundary.roomStatus}_${socketDiagnosticCode(socketObservations[0]!)}`);
          }
        });
        await test.step("students receive resume event", async () => {
          await Promise.all(students.map(({ page }, index) => (
            assertStudentComposerState(page, index, true, socketObservations[index + 1]!)
          )));
        });
      });

      await test.step("broadcast first message", async () => {
        await students[0]!.page.getByLabel("輸入訊息").fill(firstMessage);
        await students[0]!.page.getByRole("button", { name: "發送訊息" }).click();
        const pages = [teacherPage, ...students.map(({ page }) => page)];
        try {
          await Promise.all(pages.map((page) => (
            expect(page.getByRole("region", { name: "共學對話" }).getByText(firstMessage, { exact: true })).toBeVisible({ timeout: 30_000 })
          )));
        } catch {
          const visible = await Promise.all(pages.map((page) => (
            page.getByRole("region", { name: "共學對話" }).getByText(firstMessage, { exact: true })
              .isVisible().catch(() => false)
          )));
          const teacherBoundary = await readTeacherBoundaryState(teacherPage, roomId);
          const observations = socketObservations.map((socket, index) => (
            `${index === 0 ? "T" : `S${index}`}`
            + `V${visible[index] ? 1 : 0}${socketDiagnosticCode(socket)}`
          )).join("_");
          fail(`PILOT_FIRST_MESSAGE_NOT_VISIBLE_K${teacherBoundary.closeCodes.join("-") || "none"}_H${teacherBoundary.surface}`
            + `Q${teacherBoundary.sessionStatus}O${teacherBoundary.roomStatus}_${observations}`);
        }
      });

      await test.step("reply to message", async () => {
        await students[1]!.page.getByRole("button", { name: /^回覆訊息 \d+$/u }).click();
        await students[1]!.page.getByLabel("輸入訊息").fill(replyMessage);
        await students[1]!.page.getByRole("button", { name: "發送訊息" }).click();
        try {
          await expect(teacherPage.getByRole("region", { name: "共學對話" }).getByText(replyMessage, { exact: true })).toBeVisible({ timeout: 30_000 });
        } catch {
          // The teacher page is the one this spec reloads, so a reply it never
          // sees is a question about the socket that came back, not about the
          // message: the ledger and outbox are checked server-side elsewhere.
          const boundary = await readTeacherBoundaryState(teacherPage, roomId);
          fail(`PILOT_REPLY_NOT_VISIBLE_K${boundary.closeCodes.join("-") || "none"}`
            + `_H${boundary.surface}Q${boundary.sessionStatus}O${boundary.roomStatus}`
            + `_${socketDiagnosticCode(socketObservations[0]!)}`);
        }
      });

      await test.step("revise message", async () => {
        await students[0]!.page.getByRole("button", { name: /^修訂訊息 \d+$/u }).click();
        await students[0]!.page.getByLabel("修訂內容").fill(revisedMessage);
        await students[0]!.page.getByRole("button", { name: "送出修訂" }).click();
        await Promise.all([teacherPage, ...students.map(({ page }) => page)].map((page) => (
          expect(page.getByRole("region", { name: "共學對話" }).getByText(revisedMessage, { exact: true })).toBeVisible({ timeout: 30_000 })
        )));
      });

      await test.step("reject chat XSS execution", async () => {
        const hostileMessage = `<img src=x onerror="globalThis.__learningOrbitXss=1"> 太陽與食物鏈仍要由證據解釋。`;
        await students[2]!.page.getByLabel("輸入訊息").fill(hostileMessage);
        await students[2]!.page.getByRole("button", { name: "發送訊息" }).click();
        await expect(teacherPage.getByRole("region", { name: "共學對話" }).getByText(hostileMessage, { exact: true }))
          .toBeVisible({ timeout: 30_000 });
        const xssResult = await teacherPage.evaluate(() => ({
          injectedElementCount: document.querySelectorAll('img[src="x"]').length,
          handlerRan: Reflect.get(globalThis, "__learningOrbitXss") === 1,
        }));
        if (xssResult.injectedElementCount !== 0 || xssResult.handlerRan) fail("PILOT_CHAT_XSS_BOUNDARY_FAILED");
      });
    });

    await test.step("verify Provider and role-scoped analytics boundaries", async () => {
      const studentPage = students[0]!.page;
      // These steps exercise the desktop analytics controls. Below 768px the
      // workspace deliberately shows one surface at a time, so the analysis
      // column is `display: none` and its regions leave the accessibility
      // tree — the panel is rendered and correct, and the assertions still
      // fail.
      //
      // `setViewportSize` does not fix it: measured here, the page reports
      // `innerWidth` 320 immediately after being told 1440. A CDP
      // `Emulation.setDeviceMetricsOverride` outranks the viewport API, and
      // `assertProtectedSurfaceQuality` leaves one in force, so every later
      // viewport call on that page is silently ignored. Whatever restores the
      // width has to go through CDP too.
      const teacherTrace = teacherPage.getByRole("region", { name: "互動網絡" });
      const teacherEcho = teacherPage.getByRole("region", { name: "概念與論證" });
      await test.step("verify fail-closed Provider surfaces", async () => {
        await expect(studentPage.getByRole("region", { name: "訊息媒體" }))
          .toContainText("媒體 Provider 目前不可用", { timeout: 30_000 });
        await expect(studentPage.getByRole("region", { name: "Nova Agent 狀態" }))
          .toContainText("目前沒有可用的真實 Agent Executor", { timeout: 30_000 });
        await expect(studentPage.getByRole("region", { name: "共學對話" }).locator(".message.agent")).toHaveCount(0);
      });
      await test.step("verify role-scoped Projection availability", async () => {
        await expect(studentPage.getByRole("region", { name: "概念與論證" }).getByText("not_available_by_policy", { exact: true }))
          .toBeVisible({ timeout: 30_000 });
        await expect(studentPage.getByRole("region", { name: "互動網絡" }).getByText("not_available_by_policy", { exact: true }))
          .toBeVisible({ timeout: 30_000 });
        await expect(teacherPage.locator(".server-analysis-panel .analysis-version")).toHaveCount(2, { timeout: 60_000 });
        await expect(teacherPage.getByText("not_available_by_policy", { exact: true })).toHaveCount(0);
        const currentRoomSeq = await readRoomThroughSeq(teacherPage, roomId);
        await expect.poll(async () => (
          await readTeacherEchoAuthority(teacherPage, roomId)
        ).completeThroughRoomSeq, { timeout: 60_000 }).toBe(currentRoomSeq);
        await expect.poll(async () => (
          await readTeacherTraceAuthority(teacherPage, roomId)
        ).completeThroughRoomSeq, { timeout: 60_000 }).toBe(currentRoomSeq);
      });
      await test.step("switch TRACE windows and views", async () => {
        for (const windowName of ["最近 10 分鐘", "全課 45 分鐘"]) {
          const button = teacherTrace.getByRole("button", { name: windowName });
          try {
            await expect(button).toBeVisible({ timeout: 30_000 });
          } catch {
            // The panel replaces its controls with one of a small set of state
            // messages. Which one it is names the slot's availability, and
            // that copy is static UI text rather than anything from the room.
            // Section headings and the workspace surface, which together say
            // whether the panel is absent, hidden, or present but stateful.
            // All of it is static UI copy.
            const shape = await teacherPage.evaluate(() => {
              const headings = [...document.querySelectorAll("h2")].map((item) => item.textContent?.trim() ?? "");
              const workspace = document.querySelector(".room-workspace");
              const column = document.querySelector(".analysis-column");
              const visible = column ? getComputedStyle(column).display : "absent";
              return `${headings.join(",")}|surface=${workspace?.getAttribute("data-surface") ?? "none"}|col=${visible}|w=${innerWidth}`;
            });
            fail(`PILOT_TRACE_CONTROLS_MISSING_${shape.replace(/[^\p{L}\p{N}_|=,]/gu, "")}`);
          }
          await button.click({ timeout: 30_000 });
          await expect(button).toHaveAttribute("aria-pressed", "true");
        }
        for (const viewName of ["觀察網絡", "僅人類", "承接關係"]) {
          const button = teacherTrace.getByRole("button", { name: viewName });
          await expect(button).toBeVisible({ timeout: 30_000 });
          await button.click({ timeout: 30_000 });
          await expect(button).toHaveAttribute("aria-pressed", "true");
        }
      });
      await test.step("operate TRACE keyboard Inspector", async () => {
        const traceListItem = teacherTrace.getByRole("list", { name: "互動網絡等價列表" })
          .getByRole("button").first();
        await expect(traceListItem).toBeVisible({ timeout: 30_000 });
        await traceListItem.focus({ timeout: 30_000 });
        await teacherPage.keyboard.press("Enter");
        await expect(traceListItem).toHaveAttribute("aria-pressed", "true");
        await expect(teacherTrace.getByRole("region", { name: "TRACE Inspector" }))
          .not.toContainText("從等價列表選擇節點或方向以查看說明。");
        await expect(teacherTrace.locator("svg.analysis-svg")).toHaveAttribute("aria-hidden", "true");
      });
      await test.step("operate ECHO keyboard Inspector and Timeline", async () => {
        const echoListItem = teacherEcho.getByRole("list", { name: "概念關係等價列表" })
          .getByRole("button").first();
        await expect(echoListItem).toBeVisible({ timeout: 30_000 });
        await echoListItem.focus({ timeout: 30_000 });
        await teacherPage.keyboard.press("Enter");
        await expect(echoListItem).toHaveAttribute("aria-pressed", "true");
        await expect(teacherEcho.getByRole("region", { name: "ECHO Inspector" }))
          .not.toContainText("從等價列表選擇一個概念或關係以查看伺服器狀態。");
        await expect(teacherEcho.locator("svg.analysis-svg")).toHaveAttribute("aria-hidden", "true");
        const timelineButton = teacherEcho.getByRole("button", { name: "查看版本時間線" });
        await expect(timelineButton).toBeVisible({ timeout: 30_000 });
        await timelineButton.click({ timeout: 30_000 });
        try {
          await expect(teacherEcho.getByRole("region", { name: "ECHO Timeline" })).toBeVisible({ timeout: 30_000 });
        } catch {
          const alerts = await teacherEcho.getByRole("alert").allTextContents();
          const code = /錯誤代碼：([A-Z0-9_]{1,80})/u.exec(alerts.join(" "))?.[1]
            ?? "UNKNOWN";
          fail(`PILOT_ECHO_TIMELINE_${code}`);
        }
      });
      await test.step("verify Correction branch quality and identifier privacy", async () => {
        const correctionBranch = teacherPage.getByLabel("修正分支");
        await expect(correctionBranch).toBeVisible({ timeout: 30_000 });
        await correctionBranch.selectOption("split_alias", { timeout: 30_000 });
        await assertProtectedSurfaceQuality(teacherPage, "TEACHER_CORRECTION_FORM");
        await correctionBranch.selectOption("replace_text", { timeout: 30_000 });
        await assertNoUuidInVisibleText(teacherPage);
        await assertNoUuidInVisibleText(studentPage);
      });
    });

    await test.step("submit real teacher Review and Correction through Worker replay", async () => {
      const teacherTrace = teacherPage.getByRole("region", { name: "互動網絡" });
      const beforeReviewTrace = await readTeacherTraceAuthority(teacherPage, roomId);
      const pausedTraceVersion = await teacherTrace.locator(".analysis-version").innerText();
      const pausedTraceTimeRange = await teacherTrace.locator(".analysis-time-range").innerText();
      await teacherTrace.getByRole("button", { name: "暫停圖譜呈現" }).click();
      await expect(teacherTrace.getByRole("button", { name: "顯示最新已驗證版本" })).toBeVisible();

      const firstArtifact = teacherPage.locator(".artifact-review-list button").first();
      await expect(firstArtifact).toBeVisible({ timeout: 60_000 });
      await firstArtifact.click();
      await expect(firstArtifact).toHaveAttribute("aria-pressed", "true");
      const beforeReviewRoomSeq = await readRoomThroughSeq(teacherPage, roomId);
      await expect.poll(async () => (
        await readTeacherEchoAuthority(teacherPage, roomId)
      ).completeThroughRoomSeq, { timeout: 60_000 }).toBe(beforeReviewRoomSeq);
      const beforeReview = await readTeacherEchoAuthority(teacherPage, roomId);
      await teacherPage.getByLabel("審閱理由").fill("原始文字與目前概念關係一致。");
      await submitTeacherAnalyticsFact(teacherPage, roomId, "提交審閱");
      await expect.poll(async () => (
        await readTeacherEchoAuthority(teacherPage, roomId)
      ).completeThroughRoomSeq, { timeout: 60_000 }).toBeGreaterThan(beforeReview.completeThroughRoomSeq);
      await expect.poll(async () => (
        await readTeacherEchoAuthority(teacherPage, roomId)
      ).analysisEpoch, { timeout: 60_000 }).not.toBe(beforeReview.analysisEpoch);

      const afterReview = await readTeacherEchoAuthority(teacherPage, roomId);
      if (`${afterReview.analysisEpoch}:${afterReview.projectionVersion}`
        === `${beforeReview.analysisEpoch}:${beforeReview.projectionVersion}`) {
        fail("PILOT_REVIEW_PROJECTION_AUTHORITY_UNCHANGED");
      }
      await expect.poll(async () => (
        await readTeacherTraceAuthority(teacherPage, roomId)
      ).analysisEpoch, { timeout: 60_000 }).not.toBe(beforeReviewTrace.analysisEpoch);
      const afterReviewTrace = await readTeacherTraceAuthority(teacherPage, roomId);
      if (afterReviewTrace.completeThroughRoomSeq <= beforeReviewTrace.completeThroughRoomSeq) {
        fail("PILOT_REVIEW_TRACE_CURSOR_UNCHANGED");
      }
      if (`${afterReviewTrace.analysisEpoch}:${afterReviewTrace.projectionVersion}`
        === `${beforeReviewTrace.analysisEpoch}:${beforeReviewTrace.projectionVersion}`) {
        fail("PILOT_REVIEW_TRACE_AUTHORITY_UNCHANGED");
      }

      await expect(teacherTrace.getByRole("button", { name: "顯示最新已驗證版本" })).toBeVisible();
      await expect(teacherTrace.getByText(/背景已驗證 1 個較新版本/u)).toBeVisible({ timeout: 60_000 });
      await expect(teacherTrace.locator(".analysis-version")).toHaveText(pausedTraceVersion);
      await expect(teacherTrace.locator(".analysis-time-range")).toHaveText(pausedTraceTimeRange);
      await teacherTrace.getByRole("button", { name: "顯示最新已驗證版本" }).click();
      await expect(teacherTrace.getByRole("button", { name: "暫停圖譜呈現" })).toBeVisible();
      await expect(teacherTrace.getByText(/背景已驗證 \d+ 個較新版本/u)).toHaveCount(0);
      await expect(teacherTrace.locator(".analysis-version")).toHaveText(`v${afterReviewTrace.projectionVersion}`);
      await expect(teacherTrace.locator(".analysis-time-range")).not.toHaveText(pausedTraceTimeRange);

      const correctionArtifact = teacherPage.locator(".artifact-review-list button").first();
      await expect(correctionArtifact).toBeVisible({ timeout: 60_000 });
      await correctionArtifact.click();
      await expect(correctionArtifact).toHaveAttribute("aria-pressed", "true");
      await teacherPage.getByLabel("修正分支").selectOption("replace_text");
      await teacherPage.getByLabel("替換文字").fill("修正後：太陽能由生產者轉換，並沿食物鏈傳遞。");
      await teacherPage.getByLabel("修正理由").fill("補充能量轉換與傳遞的完整表述。");
      await expect(teacherPage.getByRole("button", { name: "提交修正" })).toBeEnabled();
      await submitTeacherAnalyticsFact(teacherPage, roomId, "提交修正");
      await expect.poll(async () => (
        await readTeacherEchoAuthority(teacherPage, roomId)
      ).completeThroughRoomSeq, { timeout: 60_000 }).toBeGreaterThan(afterReview.completeThroughRoomSeq);
      await expect.poll(async () => (
        await readTeacherEchoAuthority(teacherPage, roomId)
      ).analysisEpoch, { timeout: 60_000 }).not.toBe(afterReview.analysisEpoch);
      const afterCorrection = await readTeacherEchoAuthority(teacherPage, roomId);
      if (`${afterCorrection.analysisEpoch}:${afterCorrection.projectionVersion}`
        === `${afterReview.analysisEpoch}:${afterReview.projectionVersion}`) {
        fail("PILOT_CORRECTION_PROJECTION_AUTHORITY_UNCHANGED");
      }

      await assertNoUuidInVisibleText(teacherPage);
    });

    const allCodes = [roomCode, ...invites.map(({ code }) => code)];
    await test.step("download real JSON and CSV exports", async () => {
      const jsonDownloadPromise = teacherPage.waitForEvent("download");
      await teacherPage.getByRole("button", { name: "下載 JSON" }).click();
      const jsonDownload = await jsonDownloadPromise;
      assertSafeDownloadName(jsonDownload.suggestedFilename(), "json");
      const jsonText = await readDownloadText(jsonDownload);
      assertTeacherJsonExport(jsonText, roomId, allCodes);
      await expect(teacherPage.locator(".teacher-action-status")).toContainText("JSON 匯出內容已通過驗證");

      const csvDownloadPromise = teacherPage.waitForEvent("download");
      await teacherPage.getByRole("button", { name: "下載 CSV" }).click();
      const csvDownload = await csvDownloadPromise;
      assertSafeDownloadName(csvDownload.suggestedFilename(), "csv");
      const csvText = await readDownloadText(csvDownload);
      if (!csvText.startsWith("recordType,json\nmanifest,")
        || allCodes.some((code) => csvText.includes(code))
        || /(?:token|cookie|secret|password|api[-_]?key)/iu.test(csvText)) {
        fail("PILOT_CSV_EXPORT_INVALID");
      }
      await expect(teacherPage.locator(".teacher-action-status")).toContainText("CSV 匯出內容已通過驗證");
    });

    await teacherPage.getByRole("button", { name: "結束課堂" }).click();
    await Promise.all(students.map(({ page }, index) => (
      assertStudentComposerState(page, index, false, socketObservations[index + 1]!)
    )));
    await expect(teacherPage.getByRole("group", { name: "記錄審閱" })).toHaveAttribute("disabled", "");
    await expect(teacherPage.getByRole("group", { name: "記錄 Correction" })).toHaveAttribute("disabled", "");
    await expect(teacherPage.locator(".agent-policy-control button")).toBeDisabled();
    await expect(teacherPage.getByRole("button", { name: "下載 JSON" })).toBeEnabled();

    const loggedOutStudent = students.pop();
    if (!loggedOutStudent) fail("PILOT_STUDENT_CONTEXT_MISSING");
    await loggedOutStudent.page.getByRole("button", { name: "登出" }).click();
    await expect(loggedOutStudent.page).toHaveURL(/\/login$/u);
    await assertSessionMissing(loggedOutStudent.page);
    await assertNoSessionCookie(loggedOutStudent.context);
    await closeContext(loggedOutStudent.context);

    await test.step("delete the database-only room and recover the receipt after refresh", async () => {
      await teacherPage.getByLabel("確認文字").fill("刪除課堂");
      await teacherPage.getByRole("button", { name: "要求刪除" }).click();
      await expect(teacherPage.getByRole("heading", { name: "課堂刪除狀態" })).toBeVisible({ timeout: 30_000 });
      await teacherPage.reload();
      await expect(teacherPage.getByRole("heading", { name: "課堂刪除狀態" })).toBeVisible({ timeout: 30_000 });
      await assertNoBrowserCredentialArtifacts(teacherPage, {
        allowedUuids: [roomId],
        forbiddenValues: [teacherAddress, roomCode, ...invites.map(({ code }) => code)],
      });
      await expect(teacherPage.getByRole("heading", { name: "伺服器已完成線上刪除驗證" })).toBeVisible({ timeout: 120_000 });
      const surfaces = teacherPage.locator(".deletion-receipt li");
      await expect(surfaces).toHaveCount(8);
      for (const surface of ["events", "media", "derivatives", "artifacts", "projections", "agent_runs", "caches", "provider_copies"]) {
        await expect(surfaces.filter({ hasText: surface })).toHaveCount(1);
      }
      await assertProtectedSurfaceQuality(teacherPage, "DELETION_RECEIPT");
      await assertNoUuidInVisibleText(teacherPage);
    });

    await Promise.all(students.map(async ({ page }) => {
      await expect(page.getByRole("heading", { name: "目前的 Session 無法再開啟這個課堂" })).toBeVisible({ timeout: 30_000 });
      await page.reload();
      await expect(page).toHaveURL(/\/login$/u);
      await assertSessionMissing(page);
    }));

    await teacherPage.getByRole("link", { name: "返回教師工作台" }).click();
    await expect(teacherPage.getByRole("heading", { name: "教師工作台" })).toBeVisible();
    await expect(teacherPage.getByText("尚未建立課堂")).toBeVisible();
    await teacherPage.getByRole("button", { name: "登出" }).click();
    await expect(teacherPage).toHaveURL(/\/login\?role=teacher$/u);
    await assertSessionMissing(teacherPage);
    await assertNoSessionCookie(teacherContext);
  } finally {
    await Promise.allSettled([...contexts].reverse().map((context) => context.close()));
  }
});
