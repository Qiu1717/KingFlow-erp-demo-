import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:5173',
    channel: process.env.PLAYWRIGHT_CHANNEL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @kingflow/api exec tsx scripts/e2e-server.ts',
      url: 'http://127.0.0.1:3001/api/v1/health',
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'pnpm --filter @kingflow/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
});
