import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExternalSessionWatcher, type ExternalEvent } from './external-sessions.js';

function tempSessions(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pihub-ext-${prefix}-`));
  return dir;
}

describe('ExternalSessionWatcher', () => {
  it('tails pi jsonl appends and emits user/assistant events', () => {
    const root = tempSessions('pi');
    const sessionDir = path.join(root, '--work-a--');
    fs.mkdirSync(sessionDir, { recursive: true });
    const file = path.join(sessionDir, '2026-08-14T00-00-00-000Z_019fd186-1473-7e6d-968c-aef6cc575f2d.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({ timestamp: '2026-08-14T00:00:01.000Z', type: 'session_meta', payload: { id: '019fd186-1473-7e6d-968c-aef6cc575f2d', cwd: '/work-a' } })}\n`,
      'utf8',
    );

    const emitted: ExternalEvent[] = [];
    const watcher = new ExternalSessionWatcher({
      piDir: root,
      codexDir: path.join(root, 'disabled-codex'),
      dshDir: path.join(root, 'disabled-dsh'),
      pollMs: 1000,
      onEvent: (event) => emitted.push(event),
    });
    watcher.start();
    // Initial scan must NOT emit (existing history is not activity).
    expect(emitted.length).toBe(0);

    fs.appendFileSync(
      file,
      `${JSON.stringify({ timestamp: '2026-08-14T00:00:02.000Z', type: 'user', text: 'hello from terminal pi' })}\n`,
      'utf8',
    );
    // Manual scan (avoid waiting on the timer).
    (watcher as unknown as { scanAll: (emit: boolean) => void }).scanAll(true);

    expect(emitted.length).toBe(1);
    expect(emitted[0]?.agent).toBe('pi');
    expect(emitted[0]?.role).toBe('user');
    expect(emitted[0]?.text).toContain('hello from terminal pi');
    expect(emitted[0]?.sessionId).toBe('019fd186-1473-7e6d-968c-aef6cc575f2d');

    const listed = watcher.list();
    expect(listed.length).toBe(1);
    expect(listed[0]?.agent).toBe('pi');
    expect(listed[0]?.lastText).toContain('hello');

    watcher.stop();
  });

  it('parses codex rollout records and dedups already-seen lines', () => {
    const root = tempSessions('codex');
    const dayDir = path.join(root, '2026', '08', '14');
    fs.mkdirSync(dayDir, { recursive: true });
    const file = path.join(dayDir, 'rollout-2026-08-14T00-00-00-000Z-019d00af-e762-7263-8cbc-e6a54d3969a8.jsonl');
    fs.writeFileSync(file, '', 'utf8');

    const emitted: ExternalEvent[] = [];
    const watcher = new ExternalSessionWatcher({
      piDir: path.join(root, 'disabled-pi'),
      codexDir: root,
      dshDir: path.join(root, 'disabled-dsh'),
      pollMs: 1000,
      onEvent: (event) => emitted.push(event),
    });
    watcher.start();
    expect(emitted.length).toBe(0);

    const record = {
      timestamp: '2026-08-14T00:00:03.000Z',
      type: 'agent_message',
      payload: { message: { role: 'assistant', content: 'codex says hi' } },
    };
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    (watcher as unknown as { scanAll: (emit: boolean) => void }).scanAll(true);

    expect(emitted.length).toBe(1);
    expect(emitted[0]?.agent).toBe('codex');
    expect(emitted[0]?.role).toBe('assistant');
    expect(emitted[0]?.text).toContain('codex says hi');

    // Re-scan without new bytes → no duplicate emission.
    (watcher as unknown as { scanAll: (emit: boolean) => void }).scanAll(true);
    expect(emitted.length).toBe(1);

    watcher.stop();
  });

  it('handles a missing session dir without throwing', () => {
    const watcher = new ExternalSessionWatcher({
      piDir: '/nonexistent/pi/sessions',
      codexDir: '/nonexistent/codex/sessions',
      dshDir: '/nonexistent/dsh/sessions',
      pollMs: 1000,
      onEvent: () => {
        throw new Error('must not emit');
      },
    });
    watcher.start();
    (watcher as unknown as { scanAll: (emit: boolean) => void }).scanAll(true);
    expect(watcher.list().length).toBe(0);
    watcher.stop();
  });
});
