import { chromium } from 'playwright'
import path from 'path'
import { fileURLToPath } from 'url'

const OUT = path.join(fileURLToPath(import.meta.url), '..', 'screenshots')
const BASE = 'http://localhost:3000'

// Generic names for anonymisation
const ROOM_NAMES = ['Living Room', 'Office', 'Garden', 'Bedroom', 'Hallway', 'Kitchen', 'Bathroom']
const ZONE_NAMES = ['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4']
const LIGHT_NAMES = ['Ceiling light', 'Floor lamp', 'Table lamp', 'Desk lamp', 'Wall light', 'Spot 1', 'Spot 2', 'Spot 3']

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()

// Intercept /api/groups and replace room/light names with generic ones
await page.route('**/api/groups', async route => {
  const response = await route.fetch()
  const groups = await response.json()
  const counters = { Room: 0, Zone: 0 }
  const sanitized = groups.map(g => {
    const isRoom = g.type === 'Room'
    const idx = counters[isRoom ? 'Room' : 'Zone']++
    const name = isRoom ? (ROOM_NAMES[idx] ?? `Room ${idx + 1}`) : (ZONE_NAMES[idx] ?? `Zone ${idx + 1}`)
    return {
      ...g,
      name,
      lightDetails: (g.lightDetails ?? []).map((l, i) => ({
        ...l,
        name: LIGHT_NAMES[i] ?? `Light ${i + 1}`
      }))
    }
  })
  await route.fulfill({ json: sanitized })
})

// ── 1. Main rooms view ──────────────────────────────────────────────────────
await page.goto(BASE)
await page.waitForSelector('.group-card', { timeout: 10000 })
await page.waitForTimeout(800)
await page.screenshot({ path: `${OUT}/rooms.png` })
console.log('rooms.png')

// ── 2. Room card with lights expanded ──────────────────────────────────────
await page.click('.lights-section__toggle')
await page.waitForTimeout(200)
await page.screenshot({ path: `${OUT}/lights-expanded.png` })
console.log('lights-expanded.png')
await page.click('.lights-section__toggle')

// ── 3. Schedule modal ───────────────────────────────────────────────────────
// Pick the first card with a schedule button (active schedule preferred)
const activeScheduleBtn = page.locator('.schedule-btn--active').first()
const anyScheduleBtn = page.locator('.schedule-btn').first()
const btn = (await activeScheduleBtn.count()) > 0 ? activeScheduleBtn : anyScheduleBtn
await btn.click()
await page.waitForSelector('.modal', { timeout: 3000 })
await page.waitForTimeout(200)
await page.screenshot({ path: `${OUT}/schedule-modal.png` })
console.log('schedule-modal.png')

await browser.close()
console.log('done')
