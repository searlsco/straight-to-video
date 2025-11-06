import { defineConfig, devices } from '@playwright/test'

// Default to headed (WebCodecs availability). Set HEADLESS=1 to run headless.
const headless = process.env.HEADLESS === '1'

export default defineConfig({
  testDir: 'test/playwright',
  testMatch: '**/*-test.mjs',
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    headless,
    baseURL: 'http://localhost:8080'
  },
  webServer: {
    command: 'node test/pages/server.js',
    url: 'http://localhost:8080',
    reuseExistingServer: true,
    stdout: 'pipe',
    stderr: 'pipe'
  },
  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], headless }
    },
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome', headless }
    }
  ]
})
