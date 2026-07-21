import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "electron-runtime.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: "line",
  timeout: 45_000,
});
