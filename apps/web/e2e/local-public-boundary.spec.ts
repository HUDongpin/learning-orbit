import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
] as const;

function cssDurationMilliseconds(value: string): number {
  if (value.endsWith("ms")) return Number(value.slice(0, -2));
  if (value.endsWith("s")) return Number(value.slice(0, -1)) * 1_000;
  return Number.NaN;
}

async function assertPublicLayout(page: Page, label: string): Promise<void> {
  await expect.poll(async () => page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
    && document.body.scrollWidth <= document.body.clientWidth
  )), `${label} horizontal overflow`).toBe(true);
  const undersized = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(
    "button, a[href], input:not([type='hidden']), textarea, select",
  )].filter((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden"
      && rect.width > 0 && rect.height > 0
      && (rect.width < 43.5 || rect.height < 43.5);
  }).length);
  expect(undersized, `${label} undersized target count`).toBe(0);
}

async function assertZoomEquivalentReflow(page: Page, label: string): Promise<void> {
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
    expect(metrics, `${label} zoom-equivalent metrics`).toEqual({
      width: 640,
      height: 450,
      devicePixelRatio: 2,
    });
    await assertPublicLayout(page, `${label} at 200% zoom-equivalent reflow`);
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.detach();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("anonymous public boundary is responsive, keyboard accessible, reduced-motion safe, and keeps internal routes closed", async ({ page }) => {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    const response = await page.goto("/login", { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "加入學習軌道" })).toBeVisible();

    await assertPublicLayout(page, `student login at ${viewport.width}x${viewport.height}`);
  }

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "跳至登入表格" });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#login-form")).toBeFocused();

  const studentTab = page.getByRole("tab", { name: "學生加入" });
  await studentTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "教師登入" })).toBeFocused();
  await expect(page.getByRole("heading", { name: "教師登入" })).toBeVisible();
  await page.keyboard.press("Home");
  await expect(studentTab).toBeFocused();

  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
  await assertZoomEquivalentReflow(page, "student login");

  await page.getByRole("tab", { name: "教師登入" }).click();
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await assertPublicLayout(page, `teacher login at ${viewport.width}x${viewport.height}`);
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await assertZoomEquivalentReflow(page, "teacher login");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedMotion = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "message-actions";
    document.body.append(probe);
    const transitionDuration = getComputedStyle(probe).transitionDuration;
    probe.remove();
    return {
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      transitionDuration,
    };
  });
  expect(reducedMotion.scrollBehavior).toBe("auto");
  expect(cssDurationMilliseconds(reducedMotion.transitionDuration)).toBeLessThanOrEqual(0.01);

  const internalStatus = await page.evaluate(async () => {
    const response = await fetch("/internal/health", {
      credentials: "include",
      redirect: "manual",
    });
    return response.status;
  });
  expect(internalStatus).toBe(404);
});
