import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright. En T0 hay un unico smoke test: la app arranca y responde.
 *
 * El viewport por defecto es 375x667 a proposito. La spec fija esa medida como
 * la de un movil real y toda la UI se prueba ahi, no en un escritorio.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "mobile-375x667",
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: {
    command: "pnpm start",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
