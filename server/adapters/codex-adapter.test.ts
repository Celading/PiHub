import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadRolloutMessages, noticeClassifiers } from './codex-adapter.js';

/**
 * Deep adaptation (ISSUE-20260812-PI-PANEL-CODEX-DEEP-ADAPT-ROUTING-SYSPROMPT):
 * `<turn_aborted>` and HTTP status/service errors (429/503/401...) must land
 * as `notice` divider messages — never as prompts or tool results.
 *
 * sessionsDir() resolves CODEX_HOME at call time, so the store is staged in
 * a temp dir and the adapter finds the rollout there.
 */

const ROLLOUT = [
  '{"timestamp":"2026-08-05T04:30:55.000Z","type":"session_meta","payload":{"session_id":"sess-n","cwd":"/w","timestamp":"2026-08-05T04:30:54Z"}}',
  '{"timestamp":"2026-08-05T04:30:56.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}',
  '{"timestamp":"2026-08-05T04:30:57.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}',
  '{"timestamp":"2026-08-05T04:30:58.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<turn_aborted>\\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be in the background.\\n</turn_aborted>"}]}}',
  '{"timestamp":"2026-08-05T04:30:59.000Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t1","reason":"interrupted"}}',
  '{"timestamp":"2026-08-05T04:31:00.000Z","type":"event_msg","payload":{"type":"error","message":"unexpected status 503 Service Unavailable: system memory overloaded (current: 91.4%, threshold: 90%)","codex_error_info":"other"}}',
  '{"timestamp":"2026-08-05T04:31:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\\nthe project\\n</environment_context>"}]}}',
  '{"timestamp":"2026-08-05T04:31:02.000Z","type":"response_item","payload":{"type":"error","text":"codex: HTTP 429 Rate limit exceeded"}}',
  '{"timestamp":"2026-08-05T04:31:03.000Z","type":"response_item","payload":{"type":"error","text":"no rollout found"}}',
].join('\n');

let storeDir: string | undefined;

beforeAll(async () => {
  storeDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-codex-msg-'));
  await mkdir(path.join(storeDir, 'sessions', '2026', '08', '05'), { recursive: true });
  vi.stubEnv('CODEX_HOME', storeDir);
});

afterEach(async () => {
  // The adapter keeps an mtime-keyed parse cache — each test stages its own
  // thread id, so no cache invalidation is needed between cases.
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (storeDir !== undefined) {
    await rm(storeDir, { recursive: true, force: true });
    storeDir = undefined;
  }
});

async function stageRollout(threadId: string, content: string): Promise<void> {
  if (storeDir === undefined) {
    throw new Error('test store not staged');
  }
  const file = path.join(storeDir, 'sessions', '2026', '08', '05', `rollout-2026-08-05T04-30-54-${threadId}.jsonl`);
  await writeFile(file, content, 'utf8');
}

describe('codex rollout → notice deep adaptation', () => {
  it('renders turn aborts and HTTP status errors as notices, not conversation', async () => {
    await stageRollout('019d0000-aaaa-0000-0000-000000000000', ROLLOUT);
    const messages = await loadRolloutMessages('019d0000-aaaa-0000-0000-000000000000');
    expect(messages).not.toBeNull();
    if (messages === null) {
      return;
    }
    expect(messages).toHaveLength(5);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'hello' });
    expect(messages[1]).toMatchObject({ role: 'assistant' });
    // <turn_aborted> wrapper stripped, body kept
    expect(messages[2]).toMatchObject({
      role: 'notice',
      content: 'The user interrupted the previous turn on purpose. Any running unified exec processes may still be in the background.',
    });
    // event_msg turn_aborted skipped (no duplicate), event_msg 503 → notice
    expect(messages[3]).toMatchObject({
      role: 'notice',
      content: expect.stringContaining('503 Service Unavailable') as string,
    });
    // response_item error 429 → notice; environment_context + "no rollout
    // found" stay out of the conversation
    expect(messages[4]).toMatchObject({
      role: 'notice',
      content: expect.stringContaining('429') as string,
    });
  });
});

describe('notice classifiers (live + rollout share these)', () => {
  it('detects turn-aborted text and strips its wrapper', () => {
    const wrapped = '<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>';
    expect(noticeClassifiers.isTurnAbortedText(wrapped)).toBe(true);
    expect(noticeClassifiers.isTurnAbortedText('a normal prompt')).toBe(false);
    expect(noticeClassifiers.stripTurnAbortedTags(wrapped)).toBe('The user interrupted the previous turn.');
  });

  it('classifies HTTP status / service errors as notices', () => {
    for (const sample of [
      'unexpected status 503 Service Unavailable: system memory overloaded',
      'codex: HTTP 429 Rate limit exceeded',
      'HTTP 401 Unauthorized: invalid API key',
      'we are experiencing high demand',
      'rate limit reached for the model',
      'upstream temporarily unavailable',
    ]) {
      expect(noticeClassifiers.isHttpErrorText(sample)).toBe(true);
    }
    for (const sample of ['no rollout found', 'tool execution failed', 'file not found: x']) {
      expect(noticeClassifiers.isHttpErrorText(sample)).toBe(false);
    }
  });
});
