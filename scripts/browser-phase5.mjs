/* global console, process, URL */
/* eslint-disable no-restricted-globals -- a Node script, not client code */
/**
 * Phase 5 browser check: the real client against the real server, in headless Chromium.
 *
 * Start these first (two terminals):
 *   DATA_PROVIDER=synthetic WORKSPACE_FILE=/tmp/ws.json npx tsx server/index.ts
 *   VITE_USE_MOCKS=false npx vite --host 127.0.0.1      # without this, the dev server uses MSW mocks
 * Create a second layout:
 *   curl -X POST -H 'content-type: application/json' -d '{"name":"Second","symbol":"NVDA","timeframe":"1h"}' http://127.0.0.1:8787/api/layouts
 * Then:
 *   node scripts/browser-phase5.mjs <screenshot-dir>
 *
 * Needs Playwright with Chromium. PLAYWRIGHT_MODULE can point to a global install.
 * The locale is set to en-US: a container without LANG reports "en-US@posix", which
 * Intl refuses, and the chart library then logs RangeErrors.
 */
import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_MODULE ?? import.meta.url);
const { chromium } = require('playwright');
const OUT = process.argv[2] ?? '.';
const results = [];
const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + detail}`); };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
const errors = []; const apiCalls = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', async (r) => { const u = new URL(r.url()); if (u.pathname === '/api/layouts' && r.request().method() === 'GET') apiCalls.push('LAYOUTS ' + (await r.text()).slice(0, 60)); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api')) apiCalls.push(`${r.method()} ${u.pathname}`); else if (u.host !== '127.0.0.1:5173') apiCalls.push('EXTERNAL ' + r.url()); });
await page.goto('http://127.0.0.1:5173/');
await page.getByTestId('crosshair-legend').waitFor({ timeout: 15000 });
check('chart renders (legend + canvas)', (await page.locator('canvas').count()) > 0);
const wl = page.getByTestId('watchlist-panel');
await wl.getByText('MSFT', { exact: true }).first().waitFor({ timeout: 15000 });
await page.waitForTimeout(1500);
const rowsText = await wl.locator('tbody tr').allInnerTexts();
check('watchlist shows 5 rows with prices', rowsText.length === 5 && rowsText.every((t) => /\d+\.\d\d/.test(t)), JSON.stringify(rowsText));
const scroll = await wl.evaluate((el) => { const s = el.querySelector('.wl-scroll') ?? el; return { sw: s.scrollWidth, cw: s.clientWidth, w: el.getBoundingClientRect().width }; });
check('watchlist table fits the sidebar (no horizontal scroll)', scroll.sw <= scroll.cw + 1, JSON.stringify(scroll));
await page.screenshot({ path: `${OUT}/1-start.png` });
// Click the price cell, not the symbol button: a click anywhere on the row selects it.
await wl.locator('tbody tr', { hasText: 'MSFT' }).first().locator('td').first().click();
await page.waitForTimeout(1500);
const legend1 = await page.locator('main').innerText();
check('row click changes the chart to MSFT', legend1.includes('MSFT · 1D'), legend1.slice(0, 120));
await page.getByTestId('layout-switcher').locator('button').first().click();
await page.getByRole('button', { name: /^Second/ }).first().click();
await page.waitForTimeout(2000);
const legend2 = await page.locator('main').innerText();
check('layout switch changes the chart to NVDA 1h', legend2.includes('NVDA · 1h'), legend2.slice(0, 120));
await page.screenshot({ path: `${OUT}/2-layout.png` });
// back to Main (MSFT 1D after the row click), open Financials
await page.getByTestId('layout-switcher').locator('button').first().click();
await page.getByRole('button', { name: /^Main/ }).first().click();
await page.waitForTimeout(1500);
await page.getByRole('button', { name: 'Financials' }).click();
const drawer = page.getByTestId('fundamentals-drawer');
await drawer.waitFor({ timeout: 10000 });
await page.waitForTimeout(2000);
const dt = await drawer.innerText();
check('Financials drawer opens and shows data', /Piotroski|P\/E|Market cap/i.test(dt) && !/not available/i.test(dt.slice(0, 200)), dt.slice(0, 300));
await page.screenshot({ path: `${OUT}/3-financials.png` });
for (const tab of ['Statements', 'Trends', 'Earnings']) {
  await drawer.getByRole('tab', { name: tab }).click().catch(async () => drawer.getByRole('button', { name: tab }).click());
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/4-${tab}.png` });
}
check('earnings fetched for the daily chart', apiCalls.some((c) => c.includes('/api/fundamentals/earnings')));
check('no external requests from the browser', !apiCalls.some((c) => c.startsWith('EXTERNAL')), apiCalls.filter((c) => c.startsWith('EXTERNAL')).join(','));
check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
console.log(results.join('\n'));
await browser.close();
