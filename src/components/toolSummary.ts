import type { MessageKey } from '../i18n/I18nProvider.js';

/**
 * Tool-call summary (P1-12 C): derive a human-readable one-liner from the
 * tool name + arguments alone — no framework metadata required. Examples:
 *   read_file(path)        → 读取了 /x/y.py
 *   write_file(path)       → 改动了 /x/y.py
 *   bash(command)          → 执行了 npm test
 */
export interface ToolSummary {
  key: MessageKey;
  params: Record<string, string>;
}

const TARGET_KEYS = [
  'path',
  'filePath',
  'file',
  'filename',
  'command',
  'cmd',
  'url',
  'uri',
  'query',
  'keyword',
  'name',
  'dir',
  'directory',
  'location',
  'target',
];

function pickTarget(args: unknown): string {
  if (typeof args !== 'object' || args === null) {
    return '';
  }
  const record = args as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return '';
}

export function summarizeToolCall(name: string, args: unknown): ToolSummary {
  const lower = name.toLowerCase();
  const target = pickTarget(args) || name;
  const params = { target };
  if (lower.includes('read')) {
    return { key: 'tool.summary.read', params };
  }
  if (
    lower.includes('write') ||
    lower.includes('edit') ||
    lower.includes('patch') ||
    lower.includes('update') ||
    lower.includes('rename') ||
    lower.includes('delete') ||
    lower.includes('mkdir') ||
    lower.includes('rm') ||
    lower.includes('copy') ||
    lower.includes('move')
  ) {
    return { key: 'tool.summary.write', params };
  }
  if (
    lower.includes('bash') ||
    lower.includes('exec') ||
    lower.includes('shell') ||
    lower.includes('run') ||
    lower.includes('command')
  ) {
    return { key: 'tool.summary.exec', params };
  }
  if (lower.includes('search') || lower.includes('grep') || lower.includes('find')) {
    return { key: 'tool.summary.search', params };
  }
  if (
    lower.includes('fetch') ||
    lower.includes('http') ||
    lower.includes('curl') ||
    lower.includes('web') ||
    lower.includes('request')
  ) {
    return { key: 'tool.summary.fetch', params };
  }
  return { key: 'tool.summary.call', params: { name, target } };
}
