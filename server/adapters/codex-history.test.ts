import { mkdtemp, writeFile, mkdir, utimes, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listCodexSessions,
  listCodexSessionsFast,
  parseRolloutFile,
  readCodexHistory,
} from './codex-history.js';

const SAMPLE_ROLLOUT = [
  '{"timestamp":"2026-08-05T04:30:55.759Z","type":"session_meta","payload":{"session_id":"sess-001","cwd":"/work/proj","forked_from_id":"sess-000","model_provider":"minemo","source":"vscode","cli_version":"0.146.0-alpha.9.2","timestamp":"2026-08-05T04:30:54.918Z"}}',
  '{"timestamp":"2026-08-05T04:30:56.000Z","type":"event_msg","payload":{"role":"user","content":[{"type":"input_text","text":"refactor this"}]}}',
  '{"timestamp":"2026-08-05T04:30:57.000Z","type":"event_msg","payload":{"role":"assistant","content":[{"type":"output_text","text":"lets do it"}]}}',
  '{"timestamp":"2026-08-05T04:31:00.000Z","type":"response_item","payload":{"type":"custom_tool_call","custom_tool_call":{"name":"bash","arguments":{}},"id":"t1"}}',
  '{"timestamp":"2026-08-05T04:31:01.000Z","type":"response_item","payload":{"type":"custom_tool_call_output","custom_tool_call_output":{"output":"ok"},"id":"t1"}}',
  '{"timestamp":"2026-08-05T04:31:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}',
  '{"timestamp":"2026-08-05T04:31:03.000Z","type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"thinking..."}]}}',
  '{"timestamp":"2026-08-05T04:31:04.000Z","type":"response_item","payload":{"type":"token_count","usage":{"input_tokens":100,"output_tokens":20,"reasoning_tokens":10}}}',
].join('\n');

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('codex history (P2-01 B)', () => {
  it('parses a rollout file into a session record with metadata', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-codex-test-'));
    const file = path.join(tempDir, 'rollout-2026-08-05T04-30-54-019fd030-test.jsonl');
    await writeFile(file, SAMPLE_ROLLOUT, 'utf8');
    const detail = await parseRolloutFile(file);
    expect(detail).not.toBeNull();
    if (detail === null) {
      return;
    }
    expect(detail.sessionId).toBe('sess-001');
    expect(detail.cwd).toBe('/work/proj');
    expect(detail.forkedFromId).toBe('sess-000');
    expect(detail.modelProvider).toBe('minemo');
    expect(detail.source).toBe('vscode');
    expect(detail.messageCount).toBe(3); // 2 event_msg + 1 response_item message
    expect(detail.toolCalls).toBe(1); // custom_tool_call
    expect(detail.tokens).toBe(130); // 100 + 20 + 10
    expect(detail.lastActivityAt).toBe('2026-08-05T04:31:04.000Z');
  });

  it('keeps unknown frames without losing them', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-codex-test-'));
    const file = path.join(tempDir, 'rollout-unknown.jsonl');
    await writeFile(
      file,
      [
        '{"timestamp":"2026-08-05T04:30:55Z","type":"session_meta","payload":{"session_id":"sess-x","cwd":"/x","timestamp":"2026-08-05T04:30:54Z"}}',
        '{"timestamp":"2026-08-05T04:31:00Z","type":"future_event","payload":{"whatever":true}}',
      ].join('\n'),
      'utf8',
    );
    const detail = await parseRolloutFile(file);
    expect(detail).not.toBeNull();
    expect(detail?.entries.some((entry) => entry.type === 'future_event')).toBe(true);
  });

  it('reads the history.jsonl index', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-codex-test-'));
    const original = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = tempDir;
    try {
      await writeFile(
        path.join(tempDir, 'history.jsonl'),
        '{"session_id":"sess-1","ts":1773034291,"text":"hello"}\n{"session_id":"sess-2","ts":1773034292,"text":"world"}\n',
        'utf8',
      );
      const history = await readCodexHistory();
      expect(history).toHaveLength(2);
      expect(history[0]?.sessionId).toBe('sess-1');
      expect(history[1]?.text).toBe('world');
    } finally {
      if (original === undefined) {
        delete process.env['CODEX_HOME'];
      } else {
        process.env['CODEX_HOME'] = original;
      }
    }
  });

  it('parses legacy session_meta frames that use payload.id (old codex CLI)', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-codex-test-'));
    const store = path.join(tempDir, 'sessions', '2026', '03', '09');
    await mkdir(store, { recursive: true });
    const original = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = tempDir;
    const LEGACY_ID = '019cd0fb-8cb4-7890-afa3-8147f0a62613';
    try {
      const file = path.join(store, `rollout-2026-03-09T13-04-32-${LEGACY_ID}.jsonl`);
      await writeFile(
        file,
        [
          `{"timestamp":"2026-03-09T05:25:11.332Z","type":"session_meta","payload":{"id":"${LEGACY_ID}","timestamp":"2026-03-09T05:04:32.438Z","cwd":"/work","originator":"Codex Desktop","cli_version":"0.108.0"}}`,
          '{"timestamp":"2026-03-09T05:25:11.334Z","type":"event_msg","payload":{"role":"user","content":[{"type":"input_text","text":"old"}]}}',
        ].join('\n'),
        'utf8',
      );
      const detail = await parseRolloutFile(file);
      expect(detail).not.toBeNull();
      expect(detail?.sessionId).toBe(LEGACY_ID);
      // the legacy thread also survives the deduped listings
      const sessions = await listCodexSessionsFast(20);
      expect(sessions.some((session) => session.sessionId === LEGACY_ID)).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env['CODEX_HOME'];
      } else {
        process.env['CODEX_HOME'] = original;
      }
    }
  });

  it('dedupes resumed threads in both listings (audit P2: duplicate sidebar keys)', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-codex-test-'));
    const store = path.join(tempDir, 'sessions', '2026', '08', '05');
    await mkdir(store, { recursive: true });
    const original = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = tempDir;
    const THREAD = '019d0000-aaaa-0000-0000-0000000000aa';
    const content = [
      `{"timestamp":"2026-08-05T04:30:55Z","type":"session_meta","payload":{"session_id":"${THREAD}","cwd":"/w","timestamp":"2026-08-05T04:30:54Z"}}`,
      '{"timestamp":"2026-08-05T04:30:56Z","type":"event_msg","payload":{"role":"user","content":[{"type":"input_text","text":"hello"}]}}',
    ].join('\n');
    try {
      const oldFile = path.join(store, `rollout-2026-08-05T04-00-00-${THREAD}.jsonl`);
      const newFile = path.join(store, `rollout-2026-08-05T05-00-00-${THREAD}.jsonl`);
      await writeFile(oldFile, content, 'utf8');
      await writeFile(newFile, content, 'utf8');
      const oldMtime = new Date(Date.now() - 3_600_000);
      await utimes(oldFile, oldMtime, oldMtime);

      const fast = await listCodexSessionsFast(20);
      const fastRows = fast.filter((session) => session.sessionId === THREAD);
      expect(fastRows).toHaveLength(1);
      expect(fastRows[0]?.fileName).toBe(newFile);

      const full = await listCodexSessions();
      const fullRows = full.filter((session) => session.sessionId === THREAD);
      expect(fullRows).toHaveLength(1);
      expect(fullRows[0]?.fileName).toBe(newFile);
    } finally {
      if (original === undefined) {
        delete process.env['CODEX_HOME'];
      } else {
        process.env['CODEX_HOME'] = original;
      }
    }
  });

  it('dedupes copied/forked rollouts whose FILE NAME differs from the embedded session id (audit P2)', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-codex-test-'));
    const store = path.join(tempDir, 'sessions', '2026', '07', '14');
    await mkdir(store, { recursive: true });
    const original = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = tempDir;
    // Both files carry the same authoritative session_id in session_meta but
    // DIFFERENT file-name ids (copied rollouts observed in the wild).
    const AUTHORITATIVE = '019f1b6e-3c82-7650-adaa-b8f70a29a754';
    const content = [
      `{"timestamp":"2026-08-04T20:17:37Z","type":"session_meta","payload":{"session_id":"${AUTHORITATIVE}","cwd":"/w","timestamp":"2026-08-04T20:17:36Z"}}`,
      '{"timestamp":"2026-08-04T20:17:38Z","type":"event_msg","payload":{"role":"user","content":[{"type":"input_text","text":"hi"}]}}',
    ].join('\n');
    try {
      const copyA = path.join(store, 'rollout-2026-07-14T00-42-09-019f5c5b-83c5-73e0-b84b-d0195da09cc8.jsonl');
      const copyB = path.join(store, 'rollout-2026-07-14T00-42-09-019f5c5b-8384-7ce3-a70e-104961b0bf17.jsonl');
      await writeFile(copyA, content, 'utf8');
      await writeFile(copyB, content, 'utf8');
      const oldMtime = new Date(Date.now() - 3_600_000);
      await utimes(copyA, oldMtime, oldMtime);

      const sessions = await listCodexSessionsFast(20);
      const rows = sessions.filter((session) => session.sessionId === AUTHORITATIVE);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.fileName).toBe(copyB);
    } finally {
      if (original === undefined) {
        delete process.env['CODEX_HOME'];
      } else {
        process.env['CODEX_HOME'] = original;
      }
    }
  });
});
