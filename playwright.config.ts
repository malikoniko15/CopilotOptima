import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.ts', fullyParallel: true, workers: 1, retries: 0, timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) } }],
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI },
})
