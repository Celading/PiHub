import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '../../shared/types.js';
import { flattenTree, mainlineIdsOf, roleIconOf, summaryOf } from './sessionTree.js';

function entry(id: string, parentId: string | null, patch?: Partial<SessionEntry>): SessionEntry {
  return {
    id,
    parentId,
    type: 'message',
    timestamp: '',
    message: { role: 'user', content: 'hi', timestamp: 0 },
    ...patch,
  };
}

describe('P1-08b session tree helpers', () => {
  it('flattens the DAG depth-first', () => {
    const root = entry('a', null);
    const b = entry('b', 'a');
    const c = entry('c', 'a');
    const d = entry('d', 'b');
    const nodes = [
      { entry: root, children: [{ entry: b, children: [{ entry: d, children: [] }] }, { entry: c, children: [] }] },
    ];
    expect(flattenTree(nodes).map((item) => item.entry.id)).toEqual(['a', 'b', 'd', 'c']);
    expect(flattenTree(nodes).map((item) => item.depth)).toEqual([0, 1, 2, 1]);
  });

  it('computes mainline ids from the leaf chain', () => {
    const entries = [entry('a', null), entry('b', 'a'), entry('c', 'b'), entry('x', 'a')];
    const ids = mainlineIdsOf(entries, 'c');
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(true);
    expect(ids.has('c')).toBe(true);
    expect(ids.has('x')).toBe(false);
  });

  it('summarizes and glyphs entries', () => {
    expect(
      summaryOf({
        ...entry('a', null),
        message: { role: 'toolResult', toolName: 'bash', content: [], timestamp: 0 },
      } as unknown as SessionEntry),
    ).toBe('bash');
    expect(roleIconOf(entry('a', null))).toBe('U');
    expect(
      roleIconOf({
        ...entry('a', null),
        message: undefined,
        type: 'model_change',
        provider: 'x',
        modelId: 'y',
      } as unknown as SessionEntry),
    ).toBe('M');
  });
});
