#!/usr/bin/env node
/**
 * SPRINT-1: interactive showcase recorder (pi-panel).
 *
 * Drives the REAL demo-mode panel in headless Chrome and renders an mp4 of an
 * interactive walkthrough — clicks land at absolute viewport coordinates and
 * leave a ripple wave at the exact click point, so the video reads as a real
 * interaction without screen-recording.
 *
 *  - Requires: system Google Chrome (or $CHROME_PATH), ffmpeg in PATH.
 *  - Runs ONLY against the demo backend (PIHUB_MODE=demo): fictional data,
 *    write routes 503 — never touches real ~/.pi or auth.json.
 *  - Timeline is a declarative steps DSL (remotion-style "code is the
 *    timeline"; we record the real DOM instead of a synthetic canvas).
 *
 * Usage:
 *   PIHUB_DEMO_PORT=3003 node scripts/record-showcase.mjs [--shotlist]
 *   (starts demo backend + vite frontend itself; see DEMO_* constants)
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_PORT = Number(process.env.PIHUB_DEMO_PORT ?? 3003);
const WEB_PORT = Number(process.env.PIHUB_WEB_PORT ?? 5199);
const FRAMERATE = 30;
const OUT_DIR = path.join(ROOT, 'out');
const SHOT_DIR = path.join(os.tmpdir(), 'pihub-showcase-frames');
// 16:9 1080p — suitable for Bilibili / Douyin horizontal uploads.
const WIDTH = 1920;
const HEIGHT = 1080;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Ripple overlay: an absolutely-positioned wave at the click point.    */
/* ------------------------------------------------------------------ */
const RIPPLE_HTML = (x, y) => `
<style>
.pihub-ripple { position: fixed; z-index: 99999; pointer-events: none; }
.pihub-ripple .ring {
  position: absolute; left: ${x - 28}px; top: ${y - 28}px;
  width: 56px; height: 56px; border-radius: 50%;
  border: 3px solid #005fb8;
  animation: pihub-wave 0.45s ease-out forwards;
}
.pihub-ripple .dot {
  position: absolute; left: ${x - 6}px; top: ${y - 6}px;
  width: 12px; height: 12px; border-radius: 50%;
  background: #005fb8;
  animation: pihub-dot 0.45s ease-out forwards;
}
@keyframes pihub-wave {
  from { transform: scale(0.2); opacity: 0.9; }
  to   { transform: scale(2.6); opacity: 0; }
}
@keyframes pihub-dot {
  from { transform: scale(1); opacity: 1; }
  to   { transform: scale(0.4); opacity: 0; }
}
</style>
<div class="pihub-ripple"><div class="ring"></div><div class="dot"></div></div>`;

/* ------------------------------------------------------------------ */
/* Timeline DSL: steps are declarative "code is the timeline".         */
/* ------------------------------------------------------------------ */
/**
 * @typedef {object} Step
 * @property {'click'|'type'|'press'|'wait'|'shot'} action
 * @property {number} [x] absolute viewport x for click
 * @property {number} [y] absolute viewport y for click
 * @property {string} [text] text to type
 * @property {string} [key] key to press
 * @property {number} [ms] wait duration
 * @property {string} [label] shot label (for the editor)
 * @property {number} [hold] extra frames to hold after the action (ms)
 */

async function findChrome() {
  if (process.env.CHROME_PATH !== undefined && process.env.CHROME_PATH.length > 0) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/360Chrome.app/Contents/MacOS/360Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const candidate of candidates) {
    const exists = spawnSync('test', ['-x', candidate]).status === 0;
    if (exists) {
      return candidate;
    }
  }
  throw new Error('Google Chrome not found — set CHROME_PATH');
}

async function startDemoStack() {
  const children = [];
  const start = (name, cmd, args, env) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => {
      const line = String(d).trim();
      if (line.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[${name}] ${line}`);
      }
    });
    child.stderr?.on('data', () => {
      // keep stderr quiet unless it is a hard failure
    });
    child.on('exit', (code) => {
      // eslint-disable-next-line no-console
      console.log(`[${name}] exited ${String(code)}`);
    });
    children.push(child);
  };

  start(
    'demo-backend',
    process.execPath,
    ['--import', 'tsx', 'server/index.ts'],
    {
      PIHUB_MODE: 'demo',
      PORT: String(DEMO_PORT),
      // SPRINT-2 regression fix: the control token gate would 401 the demo
      // frontend (vite page carries no injected token) and break every
      // sensitive read + SSE. Demo is synthetic-only with 503 write guards,
      // so the token is disabled for the recording stack.
      PIHUB_DEV_NO_TOKEN: '1',
    },
  );
  start(
    'demo-web',
    process.execPath,
    ['node_modules/vite/bin/vite.js'],
    { VITE_PORT: String(WEB_PORT), VITE_PROXY_TARGET: `http://127.0.0.1:${String(DEMO_PORT)}` },
  );

  const ok = async (url) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          return true;
        }
      } catch {
        // not up yet
      }
      await sleep(500);
    }
    return false;
  };

  const backendUp = await ok(`http://127.0.0.1:${String(DEMO_PORT)}/api/mode`);
  if (!backendUp) {
    throw new Error('demo backend failed to start');
  }
  const webUp = await ok(`http://localhost:${String(WEB_PORT)}/`);
  if (!webUp) {
    throw new Error('demo frontend failed to start');
  }
  return {
    close: () => {
      for (const child of children) {
        try {
          child.kill('SIGTERM');
        } catch {
          // already gone
        }
      }
    },
  };
}

/**
 * Component fingerprint: reads every `[data-shot]` anchor's dynamic state —
 * visibility, absolute rect, and leading text. Two steps with identical
 * fingerprints show the same UI; a changed fingerprint is exactly what
 * warrants a new key frame. This replaces naive 30fps sampling: frames are
 * only captured when a tracked component actually moved or changed.
 */
async function captureFingerprint(page) {
  return page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('[data-shot]')) {
      const id = el.getAttribute('data-shot');
      if (id === null || id.length === 0) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      out[id] = visible
        ? {
            visible: true,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
            // Total content length: catches streaming growth (typewriter,
            // appended messages) even when the leading 60 chars are stable.
            len: (el.textContent ?? '').length,
          }
        : { visible: false };
    }
    // UI-state signals that text content cannot express (visual-only folds,
    // fade-ins): the settled collapse and the final summary line.
    out['__ui'] = {
      collapsedUnits: document.querySelectorAll('.chat-unit[data-collapsed="true"]').length,
      summaryLines: document.querySelectorAll('.chat-unit-final-summary').length,
    };
    return out;
  });
}

/** Renders a ripple at (x, y) and keeps it during the following frames. */
async function rippleAt(page, x, y) {
  await page.evaluate((html) => {
    const node = document.createElement('div');
    node.id = 'pihub-ripple';
    node.innerHTML = html;
    document.body.appendChild(node);
  }, RIPPLE_HTML(x, y));
}

async function clearRipple(page) {
  await page.evaluate(() => {
    const node = document.getElementById('pihub-ripple');
    node?.remove();
  });
}

/**
 * Records `ms` of hold time. A key frame is captured only when the component
 * fingerprint changed since the last key frame; unchanged holds just extend
 * the previous key frame's duration (no redundant screenshots, no redundant
 * encode work). Returns true when a new key frame was captured.
 */
async function recordHold(page, keyframes, fingerprint, ms, label) {
  const next = await captureFingerprint(page);
  const changed = JSON.stringify(next) !== JSON.stringify(fingerprint);
  if (changed) {
    const shot = await page.screenshot({ type: 'jpeg', quality: 88 });
    keyframes.push({ shot, label, holdMs: ms, fingerprint: next });
    Object.assign(fingerprint, next);
    return true;
  }
  if (keyframes.length > 0) {
    // Extend the latest key frame instead of duplicating identical pixels.
    keyframes[keyframes.length - 1].holdMs += ms;
  }
  return false;
}

export async function recordShowcase(steps) {
  const chromePath = await findChrome();
  const demo = await startDemoStack();
  await mkdir(SHOT_DIR, { recursive: true });
  await rm(SHOT_DIR, { recursive: true, force: true });
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      `--window-size=${String(WIDTH)},${String(HEIGHT)}`,
    ],
    defaultViewport: { width: WIDTH, height: HEIGHT },
  });

  const keyframes = [];
  let fingerprint = {};
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${String(WEB_PORT)}/`, { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    fingerprint = await captureFingerprint(page);

    for (const step of steps) {
      switch (step.action) {
        case 'click':
        case 'clickSel': {
          let x = step.x ?? 0;
          let y = step.y ?? 0;
          if (step.action === 'clickSel' && step.selector !== undefined) {
            // Resolve the element's center to absolute viewport coordinates,
            // then wave at exactly that point (locator stays stable across
            // layout changes; the click still uses absolute positioning).
            const box = await page.evaluate((selector) => {
              const el = document.querySelector(selector);
              if (el === null) {
                return null;
              }
              const rect = el.getBoundingClientRect();
              return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            }, step.selector);
            if (box === null) {
              throw new Error(`clickSel: selector not found: ${step.selector}`);
            }
            x = box.x;
            y = box.y;
          }
          // Click first, then wave: injecting the ripple overlay BEFORE the
          // click makes headless Chrome swallow the mouse event (verified by
          // probe — the overlay's DOM mutation breaks the following click).
          // Click-then-wave is visually equivalent: the wave expands right
          // after the touch lands at the exact absolute coordinate.
          await page.mouse.click(x, y);
          await rippleAt(page, x, y);
          await recordHold(page, keyframes, fingerprint, step.hold ?? 700, step.label);
          await clearRipple(page);
          // Verification trace: what is on screen after this step.
          const trace = await page.evaluate(() => {
            const h1 = document.querySelector('main h1, main h2');
            return {
              heading: h1?.textContent?.slice(0, 40) ?? null,
              url: location.pathname,
              mainStart: document.querySelector('main')?.textContent?.slice(0, 60) ?? '',
            };
          });
          // eslint-disable-next-line no-console
          console.log(`[trace] ${String(step.label)} -> ${JSON.stringify(trace)}`);
          break;
        }
        case 'type': {
          await page.keyboard.type(step.text ?? '');
          await recordHold(page, keyframes, fingerprint, step.hold ?? 400, step.label);
          break;
        }
        case 'press': {
          await page.keyboard.press(step.key ?? 'Enter');
          await recordHold(page, keyframes, fingerprint, step.hold ?? 700, step.label);
          break;
        }
        case 'pressChord': {
          // Modifier chord (e.g. Alt+1): down modifiers, press the key, up.
          for (const key of step.keys ?? []) {
            await page.keyboard.down(key);
          }
          await page.keyboard.press(step.key ?? '');
          for (const key of [...(step.keys ?? [])].reverse()) {
            await page.keyboard.up(key);
          }
          await recordHold(page, keyframes, fingerprint, step.hold ?? 700, step.label);
          break;
        }
        case 'wait': {
          await recordHold(page, keyframes, fingerprint, step.ms ?? 800, step.label);
          if (step.real === true) {
            // Movie mode: streamed content (typewriter, tool results, the
            // settle) only advances in real wall-clock time — the hold is a
            // virtual video duration, but the page must actually wait.
            await sleep(step.ms ?? 800);
          }
          break;
        }
        case 'waitFor': {
          // Wait for a selector (optionally matching `text`) with per-tick
          // fingerprint sampling, so the movie captures the streaming state
          // (typewriter etc.) at the recorder's resolution instead of a gap.
          const deadline = Date.now() + (step.timeout ?? 8000);
          let found = false;
          while (Date.now() < deadline) {
            found = await page.evaluate(
              (selector, text) => {
                const el = document.querySelector(selector ?? '');
                if (el === null) {
                  return false;
                }
                return text === undefined || (el.textContent ?? '').includes(text);
              },
              step.selector ?? '',
              step.text,
            );
            if (found) {
              break;
            }
            await recordHold(page, keyframes, fingerprint, 250, `${String(step.label)} (waiting)`);
          }
          if (!found) {
            throw new Error(`waitFor: selector not found: ${String(step.selector)}`);
          }
          await recordHold(page, keyframes, fingerprint, step.hold ?? 800, step.label);
          break;
        }
        case 'shot': {
          // Explicit key frame regardless of fingerprint changes.
          const shot = await page.screenshot({ type: 'jpeg', quality: 88 });
          keyframes.push({ shot, label: step.label, holdMs: 400, fingerprint: { ...fingerprint } });
          break;
        }
        default: {
          throw new Error(`unknown step action: ${String(step.action)}`);
        }
      }
    }

    await clearRipple(page);
  } finally {
    await browser.close();
    demo.close();
  }
  return renderVideo(keyframes, 'showcase');
}

/**
 * Writes the key frames once, then expands them to FRAMERATE via a concat
 * list with per-frame durations. Interactive mode only encodes changed
 * frames (holds extend); movie mode feeds a uniform continuous sample.
 */
async function renderVideo(keyframes, name) {
  let index = 0;
  for (const frame of keyframes) {
    const file = path.join(SHOT_DIR, `frame-${String(index).padStart(5, '0')}.jpg`);
    await (await import('node:fs/promises')).writeFile(file, frame.shot);
    index += 1;
  }
  if (keyframes.length === 0) {
    throw new Error('no key frames captured');
  }

  const listPath = path.join(SHOT_DIR, 'concat.txt');
  const listLines = [];
  for (let i = 0; i < keyframes.length; i += 1) {
    listLines.push(`file 'frame-${String(i).padStart(5, '0')}.jpg'`);
    listLines.push(`duration ${String(Math.max(keyframes[i].holdMs, 40) / 1000)}`);
  }
  // The last entry needs an extra duplicate for ffmpeg concat to honor its
  // duration.
  listLines.push(`file 'frame-${String(keyframes.length - 1).padStart(5, '0')}.jpg'`);
  await (await import('node:fs/promises')).writeFile(listPath, listLines.join('\n'));

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const output = path.join(OUT_DIR, `${name}-${timestamp}.mp4`);
  const result = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-vf', `fps=${String(FRAMERATE)}`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      '-crf', '20',
      '-movflags', '+faststart',
      output,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${String(result.stderr)}`);
  }
  const totalHoldMs = keyframes.reduce((sum, frame) => sum + frame.holdMs, 0);
  return {
    output,
    keyframes: keyframes.length,
    durationSec: totalHoldMs / 1000,
    // Movie-mode frames carry no fingerprint (uniform sampling) — the CLI
    // anchor report then degrades gracefully to an empty list.
    fingerprints: keyframes.map((frame) => frame.fingerprint ?? {}),
  };
}

/** Runs the built-in showcase walkthrough and prints the result. */
export async function runDefaultShowcase() {
  const steps = [
    { action: 'wait', ms: 1200, label: 'open demo chat' },
    // Composer model/thinking bar: open the picker, then close it with Esc
    // (the open picker overlays the viewport and would swallow later clicks).
    { action: 'clickSel', selector: '.composer-model-fields', hold: 900, label: 'open model picker' },
    { action: 'wait', ms: 600, label: 'picker open' },
    { action: 'press', key: 'Escape', hold: 700, label: 'close picker' },
    // Fold the first assistant process (process toggle above the message).
    { action: 'clickSel', selector: '.assistant-process-toggle', hold: 900, label: 'fold assistant process' },
    { action: 'wait', ms: 800, label: 'process folded' },
    { action: 'clickSel', selector: '.assistant-process-toggle', hold: 900, label: 'expand assistant process' },
    { action: 'wait', ms: 900, label: 'process expanded' },
    // Sidebar: stats view (icon buttons carry aria-labels).
    { action: 'clickSel', selector: 'button[aria-label="统计"]', hold: 900, label: 'open stats view' },
    { action: 'wait', ms: 1500, label: 'stats charts' },
    // Sidebar: automation center (skills/automation/pipelines tabs).
    { action: 'clickSel', selector: '.sidebar-feature', hold: 900, label: 'open automation center' },
    { action: 'wait', ms: 1500, label: 'automation tabs' },
    // Sidebar: sessions history.
    { action: 'clickSel', selector: 'button[aria-label="历史"]', hold: 900, label: 'open session history' },
    { action: 'wait', ms: 1400, label: 'session list' },
    // Settings last: the settings view swaps the sidebar to its section
    // navigation tree, hiding the footer buttons.
    { action: 'clickSel', selector: 'button[aria-label="设置"]', hold: 900, label: 'open settings' },
    { action: 'wait', ms: 1400, label: 'settings page' },
  ];
  return recordShowcase(steps);
}

/**
 * Showcase movie (director script, docs/showcase-director-script.md): the
 * demo panel auto-plays the scripted conversation on mount, so the recorder
 * only has to follow the timeline — pretend-send, thinking, tool chain,
 * typewriter reveal, settle collapse + final summary, expand, then the
 * feature-matrix views.
 *
 * Unlike the interactive mode (change-driven key frames), the movie samples
 * at a UNIFORM tick (~15 fps) for its whole duration: every frame carries
 * the same hold, so the rendered video is a continuous stream — no
 * 3s/2s/1s jumps between static slides. Headless screenshots run ~35ms, so
 * tick + shot lands around 15fps, which reads as fluid motion at 30fps out.
 */
const MOVIE_TICK_MS = 66;

async function movieCapture(page, keyframes, label) {
  const shot = await page.screenshot({ type: 'jpeg', quality: 85 });
  keyframes.push({ shot, label, holdMs: MOVIE_TICK_MS });
}

/** Uniform sampling for `ms` of wall-clock time. */
async function sampleHold(page, keyframes, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await movieCapture(page, keyframes, label);
    // Screenshot takes ~35ms; keep the frame cadence near MOVIE_TICK_MS.
    await sleep(Math.max(10, MOVIE_TICK_MS - 40));
  }
}

/** Absolute-coordinate click + ripple, then keep sampling. */
async function movieClick(page, keyframes, selector, label) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) {
      return null;
    }
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, selector);
  if (box === null) {
    throw new Error(`movieClick: selector not found: ${selector}`);
  }
  await page.mouse.click(box.x, box.y);
  await rippleAt(page, box.x, box.y);
  await sampleHold(page, keyframes, 800, label);
  await clearRipple(page);
}

export async function runShowcaseMovie() {
  const chromePath = await findChrome();
  const demo = await startDemoStack();
  await mkdir(SHOT_DIR, { recursive: true });
  await rm(SHOT_DIR, { recursive: true, force: true });
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      `--window-size=${String(WIDTH)},${String(HEIGHT)}`,
    ],
    defaultViewport: { width: WIDTH, height: HEIGHT },
  });

  const keyframes = [];
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${String(WEB_PORT)}/`, { waitUntil: 'domcontentloaded' });

    // Phase A — boot, then wait for the scripted user message (continuous
    // sampling from the first frame; the seeded dataset can never match the
    // scripted prompt text).
    const userDeadline = Date.now() + 12000;
    let userSeen = false;
    while (Date.now() < userDeadline) {
      userSeen = await page.evaluate(() => {
        const el = document.querySelector('.message-user');
        return el !== null && (el.textContent ?? '').includes('看看 PiHub 能为我做什么');
      });
      await movieCapture(page, keyframes, 'boot');
      if (userSeen) {
        break;
      }
      await sleep(MOVIE_TICK_MS);
    }
    if (!userSeen) {
      throw new Error('movie: scripted user message never appeared');
    }

    // Phase B — sample the whole run (thinking → tool chain → typewriter →
    // settle) until the unit auto-collapses and the final summary fades in.
    const settleDeadline = Date.now() + 15000;
    let collapsed = false;
    while (Date.now() < settleDeadline) {
      collapsed = await page.evaluate(
        () => document.querySelector('.chat-unit[data-collapsed="true"]') !== null,
      );
      await movieCapture(page, keyframes, 'movie');
      if (collapsed) {
        break;
      }
      await sleep(MOVIE_TICK_MS);
    }
    if (!collapsed) {
      throw new Error('movie: settle collapse never appeared');
    }
    await sampleHold(page, keyframes, 1600, 'final summary');

    // Phase C — one click re-expands the block (nothing was trimmed).
    await movieClick(page, keyframes, '.chat-unit-summary-line', 'expand block');
    await sampleHold(page, keyframes, 1400, 'expanded');

    // Phase D/E — feature matrix: cost insights, automation center. (No
    // "back to chat": re-entering the chat view restarts the demo player.)
    await movieClick(page, keyframes, 'button[aria-label="统计"]', 'stats view');
    await sampleHold(page, keyframes, 2200, 'stats charts');
    await movieClick(page, keyframes, '.sidebar-feature', 'automation center');
    await sampleHold(page, keyframes, 2200, 'automation tabs');
  } finally {
    await browser.close();
    demo.close();
  }
  return renderVideo(keyframes, 'showcase-movie');
}

/* ---- CLI entry ---------------------------------------------------- */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // --movie runs the director-script showcase movie (demo auto-play +
  // typewriter + settle collapse + feature matrix); default keeps the
  // classic interactive walkthrough.
  const runner = process.argv.includes('--movie') ? runShowcaseMovie() : runDefaultShowcase();
  runner
    .then(({ output, keyframes, durationSec, fingerprints }) => {
      // eslint-disable-next-line no-console
      console.log(
        `OK keyframes=${String(keyframes)} duration=${durationSec.toFixed(1)}s output=${output}`,
      );
      // Component-state verification: print each key frame's tracked anchors
      // (which data-shot components are visible, where, and at what size),
      // plus a diff against the previous key frame so every UI change that
      // warranted a new key frame is visible without decoding the video.
      const rows = fingerprints.map((fp, index) => {
        const entries = Object.entries(fp)
          .filter(([, state]) => state.visible)
          .map(([id, state]) => `${id}@${state.x},${state.y} ${state.w}x${state.h}`)
          .join(' ');
        let delta = '';
        if (index > 0) {
          const prev = fingerprints[index - 1];
          const changedIds = [];
          for (const [id, state] of Object.entries(fp)) {
            const prevState = prev[id];
            if (JSON.stringify(prevState) !== JSON.stringify(state)) {
              changedIds.push(
                state.visible
                  ? `${id}="${String(state.text).slice(0, 24)}"@${state.x},${state.y}`
                  : `${id}=hidden`,
              );
            }
          }
          delta = changedIds.length > 0 ? ` changed: ${changedIds.join(' | ')}` : ' (no change)';
        }
        return `  keyframe ${index}: ${entries}${delta}`;
      });
      // eslint-disable-next-line no-console
      console.log(`[anchors]\n${rows.join('\n')}`);
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
