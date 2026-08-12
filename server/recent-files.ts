import type { SessionDetail } from '../shared/types.js';

/** File actions aggregated from an assistant's tool calls. */
const RECENT_FILE_ACTIONS = new Set(['read', 'write', 'edit', 'patch']);

/**
 * P1-08b: recent file operations of a session detail — unique
 * read/write/edit/patch tool-call paths, newest first, capped at 12.
 */
export function recentFileActions(detail: SessionDetail | null): Array<{ path: string; action: string }> {
  if (detail === null) {
    return [];
  }
  const out: Array<{ path: string; action: string }> = [];
  const seen = new Set<string>();
  for (let index = detail.entries.length - 1; index >= 0 && out.length < 12; index -= 1) {
    const entry = detail.entries[index];
    const message = entry?.message;
    if (message === undefined || message.role !== 'assistant') {
      continue;
    }
    for (const block of message.content) {
      if (block.type !== 'toolCall') {
        continue;
      }
      const name = typeof block.name === 'string' ? block.name : '';
      if (!RECENT_FILE_ACTIONS.has(name)) {
        continue;
      }
      const args =
        typeof block.arguments === 'object' && block.arguments !== null
          ? (block.arguments as Record<string, unknown>)
          : {};
      const rawPath =
        typeof args['path'] === 'string'
          ? args['path']
          : typeof args['filePath'] === 'string'
            ? args['filePath']
            : typeof args['file'] === 'string'
              ? args['file']
              : null;
      if (rawPath === null || rawPath.length === 0 || seen.has(rawPath)) {
        continue;
      }
      seen.add(rawPath);
      out.push({ path: rawPath, action: name });
    }
  }
  return out;
}
