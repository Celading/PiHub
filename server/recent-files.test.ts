import { describe, expect, it } from 'vitest';
import type { SessionDetail } from '../shared/types.js';
import { recentFileActions } from './recent-files.js';

function assistantWithTool(name: string, args: Record<string, unknown>, text = 'ok'): {
  message: { role: 'assistant'; content: Array<Record<string, unknown>> };
} {
  return {
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }, { type: 'toolCall', id: 't1', name, arguments: args }],
    },
  };
}

function detailOf(entries: unknown[]): SessionDetail {
  return { entries } as SessionDetail;
}

describe('P1-08b recent file actions', () => {
  it('collects read/write/edit/patch paths newest first', () => {
    const out = recentFileActions(
      detailOf([
        assistantWithTool('read', { path: '/a/old.ts' }),
        assistantWithTool('bash', { command: 'ls' }),
        assistantWithTool('write', { path: '/b/new.ts' }),
        assistantWithTool('edit', { path: '/a/old.ts' }),
        assistantWithTool('patch', { file: '/c/p.patch' }),
      ]),
    );
    expect(out.map((item) => item.path)).toEqual(['/c/p.patch', '/a/old.ts', '/b/new.ts']);
    // newest duplicate wins the action label
    expect(out.find((item) => item.path === '/a/old.ts')?.action).toBe('edit');
  });

  it('handles filePath and file argument keys and caps at 12', () => {
    const entries = [];
    for (let i = 0; i < 20; i += 1) {
      entries.push(assistantWithTool('read', { filePath: `/f${String(i)}.ts` }));
    }
    const out = recentFileActions(detailOf(entries));
    expect(out.length).toBe(12);
    expect(out[0]?.path).toBe('/f19.ts');
  });

  it('ignores non-assistant entries and null details', () => {
    expect(recentFileActions(null)).toEqual([]);
    const out = recentFileActions(
      detailOf([
        { message: { role: 'user', content: 'x', timestamp: 0 } },
        { message: { role: 'toolResult', toolCallId: 't', toolName: 'read', content: [], timestamp: 0 } },
      ]),
    );
    expect(out).toEqual([]);
  });
});
