import type { SessionEntry, SessionTreeNode } from '../../shared/types.js';

/** P1-05/P1-08b: shared session-tree helpers (detail page + right workbench). */

export interface FlattenedNode {
  entry: SessionEntry;
  depth: number;
}

/** Depth-first flatten of the tree DAG (used for the full view). */
export function flattenTree(nodes: SessionTreeNode[], depth = 0, out: FlattenedNode[] = []): FlattenedNode[] {
  for (const node of nodes) {
    out.push({ entry: node.entry, depth });
    flattenTree(node.children, depth + 1, out);
  }
  return out;
}

/** Ids on the leaf mainline (leafId → parent chain). */
export function mainlineIdsOf(entries: SessionEntry[], leafId: string | null): Set<string> {
  const ids = new Set<string>();
  let current: string | null = leafId;
  while (current !== null) {
    ids.add(current);
    const entry = entries.find((item) => item.id === current);
    current = entry?.parentId ?? null;
  }
  return ids;
}

/** Short human label of an entry (tree row). */
export function summaryOf(entry: SessionEntry): string {
  const message = entry.message;
  if (message === undefined) {
    if (entry.type === 'model_change') {
      return `model → ${entry.provider ?? '?'}/${entry.modelId ?? ''}`;
    }
    if (entry.type === 'thinking_level_change') {
      return `thinking → ${entry.thinkingLevel ?? '?'}`;
    }
    return entry.type;
  }
  switch (message.role) {
    case 'user': {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      return text.length > 48 ? `${text.slice(0, 48)}…` : text;
    }
    case 'assistant':
      return message.model !== undefined && message.model.length > 0 ? message.model : 'assistant';
    case 'toolResult':
      return message.toolName.length > 0 ? message.toolName : 'tool';
    case 'bashExecution':
      return 'bash';
  }
}

/** One-letter role glyph of an entry. */
export function roleIconOf(entry: SessionEntry): string {
  const message = entry.message;
  if (message !== undefined) {
    switch (message.role) {
      case 'user':
        return 'U';
      case 'assistant':
        return 'A';
      case 'toolResult':
        return 'T';
      case 'bashExecution':
        return 'B';
    }
  }
  if (entry.type === 'model_change') {
    return 'M';
  }
  if (entry.type === 'thinking_level_change') {
    return 'L';
  }
  return 'E';
}
