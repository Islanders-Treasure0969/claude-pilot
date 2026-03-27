import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3458",
    headless: true,
  },
  webServer: {
    command: "node cli.js server --port 3458",
    port: 3458,
    reuseExistingServer: true,
    timeout: 10000,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
});
