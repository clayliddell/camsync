const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.cjs',
  timeout: 30000,
  fullyParallel: true,
  use: { baseURL: 'http://localhost:4173', viewport: { width: 390, height: 844 }, serviceWorkers: 'block' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: { args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'] } } },
    { name: 'webkit', testIgnore: '**/recording.spec.cjs', use: { browserName: 'webkit' } },
  ],
  webServer: { command: 'node scripts/serve.cjs', url: 'http://localhost:4173', reuseExistingServer: !process.env.CI },
});
