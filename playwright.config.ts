import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the real production build in dist/, served as
 * static files by a tiny zero-dependency Node server (scripts/serve.js).
 * `npm run test:e2e` builds dist/ first, then runs these specs.
 */
export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: [['list']],
    timeout: 30_000,
    use: {
        baseURL: 'http://127.0.0.1:8199',
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    webServer: {
        command: 'node scripts/serve.js dist 8199',
        url: 'http://127.0.0.1:8199/',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});
