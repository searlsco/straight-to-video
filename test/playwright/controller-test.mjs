import { test, expect } from '@playwright/test'

test('basic demo loads and can run fixture', async ({ page }) => {
  await page.goto('/test/pages/controller.html')
  await expect(page.getByRole('heading', { name: /straight-to-video/i })).toBeVisible()
  await page.getByRole('button', { name: /Run with fixture/i }).click()
  const pre = page.locator('pre#out')
  await expect(pre).not.toHaveText(/^$/, { timeout: 30_000 })
})

test('controller processes file input on change', async ({ page }) => {
  await page.goto('/test/pages/controller.html')
  const input = page.getByLabel(/Video file/i)
  await input.setInputFiles('test/fixtures/4k_16_9.mp4')
  await expect(input).toHaveAttribute('data-processed', '1')
})

test('controller emits progress and done events quickly', async ({ page }) => {
  await page.goto('/test/pages/controller.html')
  await page.evaluate(() => {
    const pre = document.getElementById('out')
    const input = document.getElementById('file')
    const log = (m) => { pre.textContent = (pre.textContent || '') + `\n${m}` }
    input.addEventListener('straight-to-video:progress', (e) => log(`progress:${e.detail.progress}`))
    input.addEventListener('straight-to-video:done', (e) => log(`done:${e.detail.changed}`))
  })
  const input = page.getByLabel(/Video file/i)
  await input.setInputFiles('test/fixtures/4k_16_9.mp4')
  const pre = page.locator('pre#out')
  await expect(pre).toContainText('progress:', { timeout: 30_000 })
  await expect(pre).toContainText('done:', { timeout: 30_000 })
})
