import "dotenv/config";
import { defineConfig } from "@playwright/test";

if (
  process.env.DEV_AUTH_ENABLED !== "true" ||
  !process.env.DEV_AUTH_TOKEN ||
  !process.env.DATABASE_URL ||
  process.env.VITE_APP_MODE === "demo"
) {
  throw new Error(
    "E2E requires the local development API proxy, DEV_AUTH_TOKEN, PostgreSQL, and VITE_APP_MODE=api.",
  );
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5174",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run dev:api",
      url: "http://127.0.0.1:3000/health/ready",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { AGENT_PROVIDER: "disabled" },
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 5174 --strictPort",
      url: "http://127.0.0.1:5174/",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { AGENT_PROVIDER: "disabled" },
    },
  ],
});
