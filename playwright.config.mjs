import { defineConfig, devices } from "@playwright/test";

const externalBaseUrl = process.env.TEST_URL
  ? `${process.env.TEST_URL.replace(/\/+$/, "")}/`
  : "";
const baseURL = externalBaseUrl || "http://127.0.0.1:4173/";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  outputDir: "test-results",
  use: {
    baseURL,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: externalBaseUrl
    ? undefined
    : {
        command: "node scripts/test_server.mjs",
        url: new URL("__health", baseURL).href,
        timeout: 20_000,
        reuseExistingServer: false,
      },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
});
