import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/browser', timeout: 60_000, workers: 1, use: { baseURL: 'http://localhost:8788', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' }, webServer: { command: 'node scripts/browser-test-server.ts', url: 'http://localhost:8788/api/health', reuseExistingServer: false, timeout: 60_000 } });
