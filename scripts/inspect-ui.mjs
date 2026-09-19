import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

await mkdir('test-results', { recursive: true })
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge' })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.on('pageerror', error => console.error('Browser error:', error.message))
  await page.goto('http://127.0.0.1:5173')
  await page.getByRole('heading', { name: 'Обзор расходов.' }).waitFor()
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true })
  console.log('Mobile overflow:', await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('main *')].map(el => ({ tag: el.tagName, class: el.className, right: Math.round(el.getBoundingClientRect().right), width: Math.round(el.getBoundingClientRect().width) })).filter(e => e.right > innerWidth && e.width > 0).slice(0, 25) })))
} finally {
  await browser.close()
}
