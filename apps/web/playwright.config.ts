import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../test-results/playwright",
  reporter: "line",
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  use: {
    // The pilot harness serves on 3000; a developer whose 3000 is taken can
    // point a run elsewhere without editing this file.
    baseURL: process.env.LO_E2E_BASE_URL ?? "https://127.0.0.1:3000",
    ignoreHTTPSErrors: true,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
