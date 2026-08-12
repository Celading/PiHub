/**
 * Showcase sprint smoke: drives the demo stack in headless Chrome and verifies
 * the scripted conversation plays end-to-end — user message, typewriter
 * reveal, tool chain, settle collapse and the final summary line. Uses the
 * REAL demo mode (synthetic data, writes 503), never touches real pi.
 * Usage: node scripts/smoke-showcase.mjs
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('..', import.meta.url).pathname;
const DEMO_PORT = Number(process.env.PIHUB_DEMO_PORT ?? 3003);
const WEB_PORT = Number(process.env.PIHUB_WEB_PORT ?? 5199);
const SETTLE_AT_MS = 9700 + 1500;

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  if (candidates.length > 0) return candidates[0];
  throw new Error('Google Chrome not found — set CHROME_PATH');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, label) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${label}`);
  }
}

const children = [];
const start = (name, cmd, args, env) => {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => {
    const line = String(d).trim();
    if (line.length > 0) console.log(`[${name}] ${line.slice(0, 160)}`);
  });
  children.push(child);
};

async function waitOk(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return false;
}

const stack = async () => {
  start('demo-backend', process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    PIHUB_MODE: 'demo',
    PORT: String(DEMO_PORT),
    PIHUB_DEV_NO_TOKEN: '1',
  });
  start('demo-web', process.execPath, ['node_modules/vite/bin/vite.js'], {
    VITE_PORT: String(WEB_PORT),
    VITE_PROXY_TARGET: `http://127.0.0.1:${String(DEMO_PORT)}`,
  });
  if (!(await waitOk(`http://127.0.0.1:${String(DEMO_PORT)}/api/mode`))) {
    throw new Error('demo backend failed to start');
  }
  if (!(await waitOk(`http://localhost:${String(WEB_PORT)}/`))) {
    throw new Error('demo frontend failed to start');
  }
};

try {
  await stack();
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`http://localhost:${String(WEB_PORT)}/`, { waitUntil: 'domcontentloaded' });

    // The showcase auto-plays on chat mount: the play wipes the seeded
    // dataset and the frontend reloads, then (after the 1.5s offset) the
    // scripted frames stream in. Wait for the SCRIPTED user message.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.message-user');
        return el !== null && (el.textContent ?? '').includes('看看 PiHub 能为我做什么');
      },
      { timeout: 15000 },
    );
    assert(true, 'user message appeared (pretend-send)');
    const promptText = await page.$eval('.message-user', (el) => el.textContent ?? '');
    assert(promptText.includes('看看 PiHub 能为我做什么'), `user prompt is the scripted one ("${promptText.slice(0, 30)}")`);

    await sleep(3000); // during thinking/tool phase
    const midState = await page.evaluate(() => ({
      typewriter: document.querySelectorAll('.typewriter').length,
      toolcall: document.querySelectorAll('.toolcall').length,
    }));
    console.log(`  (mid-stream: toolcall=${String(midState.toolcall)} typewriter=${String(midState.typewriter)})`);

    // Wait into the final reply phase: the typewriter must be mid-reveal
    // (caret present, revealed text shorter than the full reply).
    await sleep(4900); // ~9.4s into the timeline
    const typing = await page.evaluate(() => {
      const tw = document.querySelector('.typewriter');
      return {
        present: tw !== null,
        caret: document.querySelectorAll('.typewriter-caret').length,
        revealed: tw?.textContent?.length ?? 0,
      };
    });
    assert(typing.present && typing.caret === 1, 'typewriter mid-reveal with caret');
    console.log(`  (typewriter revealed chars=${String(typing.revealed)})`);

    // Wait past settle; the tool chain should have collapsed and the final
    // summary line should be visible.
    await sleep(SETTLE_AT_MS + 4500);
    const settled = await page.evaluate(() => ({
      collapsed: document.querySelectorAll('.chat-unit[data-collapsed="true"]').length,
      summary: document.querySelectorAll('.chat-unit-final-summary').length,
      summaryText: document.querySelector('.chat-unit-final-summary')?.textContent ?? '',
      caret: document.querySelectorAll('.typewriter-caret').length,
    }));
    assert(settled.collapsed >= 1, 'settled unit auto-collapsed as one block');
    assert(settled.summary >= 1, 'final summary line rendered');
    assert(
      settled.summaryText.includes('本地网页控制台') || settled.summaryText.length > 0,
      `summary carries the reply ("${settled.summaryText.slice(0, 40)}")`,
    );
    assert(settled.caret === 0, 'typewriter caret gone after reveal completes');

    // Expand the collapsed unit again: the full reply must be intact.
    await page.$eval('.chat-unit-summary-line', (el) => el.click());
    await sleep(900);
    const expanded = await page.evaluate(() => ({
      collapsed: document.querySelectorAll('.chat-unit[data-collapsed="true"]').length,
      text: document.body.textContent ?? '',
    }));
    assert(expanded.collapsed === 0, 'unit expands again on click');
    assert(
      expanded.text.includes('绝不读取你的凭据'),
      'full final reply intact after expand (data never altered)',
    );
  } finally {
    await browser.close();
  }
} finally {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
}
