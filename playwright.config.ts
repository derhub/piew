import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = 5910;
const E2E_STATE_DIR =
  process.env.PIEW_E2E_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "piew-e2e-"));
process.env.PIEW_E2E_DIR = E2E_STATE_DIR;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.e2e\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /.*phone\.e2e\.ts/ },
    // Chromium with the phone's viewport and touch: WebKit would mean another
    // browser download for a layout question neither engine answers differently.
    {
      name: "phone",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
      testMatch: /.*phone\.e2e\.ts/,
    },
  ],
  webServer: {
    // The client is served from dist, so the bundle under test has to be built.
    command: "bun run build && bun tests/e2e/server.ts",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    stdout: "pipe",
    env: { PIEW_DIR: E2E_STATE_DIR },
  },
});
