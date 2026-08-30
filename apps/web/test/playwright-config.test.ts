import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import playwrightConfig from "../playwright.config.js";

type PlaywrightConfigContract = {
  testDir?: string;
  outputDir?: string;
  reporter?: unknown;
  workers?: number;
  fullyParallel?: boolean;
  forbidOnly?: boolean;
  use?: {
    baseURL?: string;
    ignoreHTTPSErrors?: boolean;
    trace?: unknown;
    video?: unknown;
    screenshot?: unknown;
  };
};

async function loadPlaywrightConfig(): Promise<PlaywrightConfigContract> {
  return playwrightConfig as PlaywrightConfigContract;
}

describe("web Playwright safety configuration", () => {
  it("owns only the web e2e directory and the local HTTPS origin", async () => {
    const config = await loadPlaywrightConfig();

    expect(config.testDir).toBe("./e2e");
    expect(config.use).toMatchObject({
      baseURL: "https://127.0.0.1:3000",
      ignoreHTTPSErrors: true,
    });
  });

  it("runs deterministically and fails closed on focused tests", async () => {
    const config = await loadPlaywrightConfig();

    expect(config).toMatchObject({
      workers: 1,
      fullyParallel: false,
      forbidOnly: true,
    });
  });

  it("keeps output ignored and disables secret-bearing recordings by default", async () => {
    const config = await loadPlaywrightConfig();
    const webRoot = process.cwd();
    const repositoryRoot = path.resolve(webRoot, "../..");
    const ignoreRules = readFileSync(path.join(repositoryRoot, ".gitignore"), "utf8")
      .split(/\r?\n/u);

    expect(config.outputDir).toBe("../../test-results/playwright");
    expect(path.resolve(webRoot, config.outputDir ?? "")).toBe(
      path.join(repositoryRoot, "test-results/playwright"),
    );
    expect(ignoreRules).toContain("test-results/");
    expect(config.reporter).toBe("line");
    expect(config.use).toMatchObject({
      trace: "off",
      video: "off",
      screenshot: "off",
    });
  });
});
