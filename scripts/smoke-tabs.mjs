/**
 * P1-06 smoke: multi-tab workspace on the dev panel (headless Chrome).
 * Drives: default draft tab -> open session tab -> second session tab ->
 * tab switching -> close tabs -> fallback draft tab. Prints PASS/FAIL lines.
 * Usage: node scripts/smoke-tabs.mjs
 */
import puppeteer from 'puppeteer-core';

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  if (candidates.length > 0) return candidates[0];
  throw new Error('Google Chrome not found — set CHROME_PATH');
}

function assert(condition, label) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${label}`);
  }
}

const URL = process.env.PANEL_URL ?? 'http://localhost:18384/';

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: true,
});
try {
  // The backend gates writes with a per-process control token injected into
  // the served index.html. The dev panel (vite) has no injected token, so
  // fetch the same process's token from the backend page and pre-inject it
  // into every document of the dev panel.
  const tokenPage = await browser.newPage();
  await tokenPage.goto('http://localhost:3001/', { waitUntil: 'domcontentloaded' });
  const token = await tokenPage.evaluate(() => window.__PIHUB_TOKEN__);
  await tokenPage.close();

  const page = await browser.newPage();
  await page.evaluateOnNewDocument((tok) => {
    window.__PIHUB_TOKEN__ = tok;
  }, token);
  await page.setViewport({ width: 1440, height: 900 });
  // SSE keeps a connection open, so domcontentloaded (not networkidle).
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for the tab strip (P1-06) and one draft tab.
  await page.waitForSelector('.tabbar', { timeout: 15000 });
  const tabCount = async () =>
    (await page.$$('.tabbar-tab')).length;
  assert((await tabCount()) === 1, 'starts with a single draft tab');

  // Session list loads asynchronously — wait for rows to render.
  await page.waitForSelector('.sidebar-session-item', { timeout: 15000 });
  const sessions = await page.$$('.sidebar-session-item');
  assert(sessions.length >= 2, `sidebar lists >= 2 sessions (got ${sessions.length})`);

  // Open the first session in a tab.
  await sessions[0].click();
  await page.waitForFunction(() => document.querySelectorAll('.tabbar-tab').length === 2, {
    timeout: 10000,
  });
  assert(true, 'clicking a session opens a second tab');
  const activeLabel1 = await page.$eval(
    '.tabbar-tab[data-active="true"] .tabbar-label',
    (el) => el.textContent ?? '',
  );
  assert(activeLabel1.length > 0, `active tab has a label ("${activeLabel1}")`);

  // Open the second session: a third tab appears and becomes active.
  await page.$$eval('.sidebar-session-item', (rows) => rows[1].click());
  await page.waitForFunction(() => document.querySelectorAll('.tabbar-tab').length === 3, {
    timeout: 10000,
  });
  assert(true, 'clicking a second session opens a third tab');

  // Switch back to the first session tab.
  await page.$$eval('.tabbar-tab', (tabs) => tabs[0].click());
  await page.waitForFunction(
    () => document.querySelectorAll('.tabbar-tab')[0]?.getAttribute('data-active') === 'true',
    { timeout: 10000 },
  );
  assert(true, 'clicking a tab switches back to it');

  // Closing the active tab activates its neighbor.
  await page.$$eval('.tabbar-tab', (tabs) => tabs[0].querySelector('.tabbar-close')?.click());
  await page.waitForFunction(() => document.querySelectorAll('.tabbar-tab').length === 2, {
    timeout: 10000,
  });
  assert(true, 'closing a tab removes it');
  const activeAfterClose = await page.$eval(
    '.tabbar-tab[data-active="true"] .tabbar-label',
    (el) => el.textContent ?? '',
  );
  assert(activeAfterClose.length > 0, `a neighbor tab became active ("${activeAfterClose}")`);

  // Close every tab: 2 → 1 (normal close) then 1 → fresh draft tab.
  for (let i = 0; i < 2; i += 1) {
    await page.$$eval('.tabbar-tab', (tabs) => tabs[0].querySelector('.tabbar-close')?.click());
    await page.waitForFunction(
      () => document.querySelectorAll('.tabbar-tab').length === 1,
      { timeout: 10000 },
    );
  }
  assert(true, 'closing every tab keeps exactly one tab');
  const draftLabel = await page.$eval('.tabbar-tab .tabbar-label', (el) => el.textContent ?? '');
  assert(
    draftLabel === '新会话' || draftLabel === 'New chat',
    `the remaining tab is a fresh draft ("${draftLabel}")`,
  );
} finally {
  await browser.close();
}
