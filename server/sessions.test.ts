import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionStore, emptyTotals } from './sessions.js';

const SAMPLE_JSONL = [
  '{"type":"session","version":3,"id":"sess-001","timestamp":"2026-08-05T06:20:34.232Z","cwd":"/work/proj-a"}',
  '{"type":"thinking_level_change","id":"e1","parentId":null,"timestamp":"2026-08-05T06:20:34.293Z","thinkingLevel":"off"}',
  '{"type":"model_change","id":"e2","parentId":"e1","timestamp":"2026-08-05T06:24:33.958Z","provider":"deepseek","modelId":"deepseek-v4-pro"}',
  '{"type":"message","id":"m1","parentId":"e2","timestamp":"2026-08-05T06:25:31.922Z","message":{"role":"user","content":[{"type":"text","text":"first prompt"}],"timestamp":1785911131918}}',
  '{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-08-05T06:25:35.221Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"think..."},{"type":"text","text":"hi"}],"provider":"deepseek","model":"deepseek-v4-pro","usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"totalTokens":150,"cost":{"input":0.001,"output":0.0005,"cacheRead":0,"cacheWrite":0,"total":0.0015}},"timestamp":1785911135221}}',
  '{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-08-05T06:25:40.000Z","message":{"role":"toolResult","toolCallId":"call_1","toolName":"bash","content":[{"type":"text","text":"ok"}],"isError":false,"timestamp":1785911140000}}',
  '{"type":"message","id":"m4","parentId":"m3","timestamp":"2026-08-05T06:26:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"provider":"deepseek","model":"deepseek-v4-pro","usage":{"input":50,"output":10,"cacheRead":0,"cacheWrite":0,"totalTokens":60,"cost":{"input":0.0005,"output":0.0001,"cacheRead":0,"cacheWrite":0,"total":0.0006}},"timestamp":1785911160000}}',
  '{"type":"garbage line that is not json',
  '',
  '{"type":"message","id":"m5","parentId":"m4","timestamp":"2026-08-05T06:27:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"trailing"}],"model":"other-model","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"timestamp":1785911220000}}',
].join('\n');

let tempDir: string | undefined;

async function writeFixture(dirName: string): Promise<string> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-test-'));
  const sub = path.join(tempDir, dirName);
  await writeFile(path.join(tempDir, 'nested.jsonl'), SAMPLE_JSONL, 'utf8');
  await writeFile(path.join(tempDir, 'ignored.txt'), 'not a session', 'utf8');
  await writeFile(path.join(tempDir, '.hidden.jsonl'), SAMPLE_JSONL, 'utf8');
  void sub;
  return tempDir;
}

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('session store', () => {
  it('lists sessions with aggregated summaries', async () => {
    const dir = await writeFixture('x');
    const store = createSessionStore(dir);
    const list = await store.list();
    expect(list).toHaveLength(1);
    const summary = list[0];
    if (summary === undefined) {
      throw new Error('expected one session');
    }
    expect(summary.cwd).toBe('/work/proj-a');
    expect(summary.userMessages).toBe(1);
    expect(summary.assistantMessages).toBe(3);
    expect(summary.toolResults).toBe(1);
    expect(summary.models).toContain('deepseek-v4-pro');
    expect(summary.cost).toBeCloseTo(0.0021, 6);
    expect(summary.tokens.total).toBe(212);
  });

  it('gets a session detail with a message tree', async () => {
    const dir = await writeFixture('x');
    const store = createSessionStore(dir);
    const detail = await store.get('sess-001');
    expect(detail).not.toBeNull();
    if (detail === null) {
      return;
    }
    expect(detail.entries).toHaveLength(7);
    expect(detail.leafId).toBe('m5');
    // Roots: e1 is the only orphan root (parentId null) besides header.
    const roots = detail.tree;
    expect(roots.length).toBeGreaterThanOrEqual(1);
    // m1 -> m2 -> m3 -> m4 -> m5 chain must exist somewhere in the tree.
    const chain = detail.entries.map((entry) => entry.id).join(',');
    expect(chain).toContain('m1,m2,m3,m4,m5');
  });

  it('returns stats aggregated across sessions', async () => {
    const dir = await writeFixture('x');
    const store = createSessionStore(dir);
    const stats = await store.stats();
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalAssistantMessages).toBe(3);
    expect(stats.totalCost).toBeCloseTo(0.0021, 6);
    expect(stats.byModel[0]?.model).toBe('deepseek-v4-pro');
    expect(stats.byDirectory[0]?.cwd).toBe('/work/proj-a');
  });

  it('returns empty state when no session files exist', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-empty-'));
    try {
      const store = createSessionStore(dir);
      const list = await store.list();
      expect(list).toEqual([]);
      const stats = await store.stats();
      expect(stats.totalSessions).toBe(0);
      expect(stats.totals).toEqual(emptyTotals());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
