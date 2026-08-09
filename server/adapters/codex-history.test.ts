import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRolloutFile, readCodexHistory } from './codex-history.js';

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
});
