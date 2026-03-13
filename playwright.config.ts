import { defineConfig } from "@playwright/test";
import { config } from "dotenv";

// Load .env.local for test credentials
config({ path: ".env.local" });

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://localhost:3001",
    headless: true,
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { browserName: "chromium" },
    },
    {
      name: "chromium",
      use: { browserName: "chromium" },
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.ts/,
    },
  ],
});
