import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RpcBridge } from './rpc-bridge.js';

/**
 * Fake pi process (P1-01): emits extension_ui_request frames on startup,
 * then records every extension_ui_response received on stdin into a log
 * file so the test can assert the exact wire payload.
 */
const FAKE_PI = `#!/usr/bin/env node
import fs from 'node:fs';
const LOG = process.env.FAKE_PI_LOG;
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n');
}
emit({ type: 'extension_ui_request', id: 'sel-1', method: 'select', title: 'Pick', options: ['a', 'b'], timeout: 5000 });
emit({ type: 'extension_ui_request', id: 'ntf-1', method: 'notify', message: 'hi', notifyType: 'warning' });
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    fs.appendFileSync(LOG, line + '\\n');
  }
});
`;

function makeBridge(): { bridge: RpcBridge; logFile: string; stop: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'pihub-extui-'));
  const piFile = path.join(dir, 'fake-pi.mjs');
  const logFile = path.join(dir, 'responses.log');
  writeFileSync(piFile, FAKE_PI);
  chmodSync(piFile, 0o755);
  process.env.FAKE_PI_LOG = logFile;
  const bridge = new RpcBridge(piFile, dir);
  bridge.start();
  return {
    bridge,
    logFile,
    stop: () => {
      bridge.stop();
    },
  };
}

function waitFor<T>(probe: () => T | undefined, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const value = probe();
      if (value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(tick, 40);
    };
    tick();
  });
}

describe('extension UI protocol bridge (P1-01)', () => {
  let ctx: ReturnType<typeof makeBridge> | null = null;
  afterEach(() => {
    ctx?.stop();
    ctx = null;
  });

  it('emits ui-request events for select and notify frames', async () => {
    ctx = makeBridge();
    const bridge = ctx.bridge;
    const seen: Array<{ id: string; method: string }> = [];
    bridge.on('ui-request', (request) => {
      seen.push({ id: request.id, method: request.method });
    });
    await waitFor(() => (seen.length >= 2 ? seen : undefined));
    expect(seen).toContainEqual({ id: 'sel-1', method: 'select' });
    expect(seen).toContainEqual({ id: 'ntf-1', method: 'notify' });
  });

  it('holds select dialogs pending and answers back on stdin', async () => {
    ctx = makeBridge();
    const bridge = ctx.bridge;
    const logFile = ctx.logFile;
    await waitFor(() =>
      bridge.getPendingUiRequests().length > 0 ? bridge.getPendingUiRequests() : undefined,
    );
    const pending = bridge.getPendingUiRequests();
    expect(pending.map((r) => r.method)).toContain('select');
    expect(pending.find((r) => r.method === 'notify')).toBeUndefined();

    // Answer the select dialog with a value.
    const ok = bridge.sendUiResponse({ id: 'sel-1', value: 'b' });
    expect(ok).toBe(true);
    await waitFor(() => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : undefined));
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('"type":"extension_ui_response"');
    expect(log).toContain('"id":"sel-1"');
    expect(log).toContain('"value":"b"');
    expect(bridge.getPendingUiRequests()).toHaveLength(0);
  });

  it('rejects responses for unknown ids and supports cancelled', async () => {
    ctx = makeBridge();
    const bridge = ctx.bridge;
    const logFile = ctx.logFile;
    await waitFor(() => (bridge.getPendingUiRequests().length > 0 ? true : undefined));
    expect(bridge.sendUiResponse({ id: 'nope', value: 'x' })).toBe(false);
    const ok = bridge.sendUiResponse({ id: 'sel-1', cancelled: true });
    expect(ok).toBe(true);
    await waitFor(() => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : undefined));
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('"cancelled":true');
  });
});
