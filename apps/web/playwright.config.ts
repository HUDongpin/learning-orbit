import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../test-results/playwright",
  reporter: "line",
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  use: {
    baseURL: "https://127.0.0.1:3000",
    ignoreHTTPSErrors: true,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
