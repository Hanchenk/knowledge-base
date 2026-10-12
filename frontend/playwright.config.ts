import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45000,
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:5173",
    channel: process.env.PW_CHANNEL || "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 1000 },
  },
  reporter: [["list"]],
});
