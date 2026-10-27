import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: "tests/.browser-results/runner",
  use: {
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
});
