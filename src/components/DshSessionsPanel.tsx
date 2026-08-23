import { useEffect, useState } from 'react';
import { api, type DshSessionRow } from '../api/client.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { AdapterSessionsSection, type AdapterSessionLine } from './AdapterSessionsSection.js';

/**
 * DeepSeek Harness session history — rendered through the shared
 * AdapterSessionsSection like every other adapter (codex / atomcode /
 * zcode / claude): same head, rows, 查看 expand. With a connected dsh web
 * instance the detail is the real session transcript; without one it
 * honestly states that headless runs only persist session headers (no
 * message content on disk). The section hides when the backend 503s
 * (demo mode).
 */
export function DshSessionsPanel(): React.JSX.Element | null {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<DshSessionRow[] | null>(null);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .dshSessions()
      .then((response) => {
        if (!cancelled) {
          setSessions(response.sessions);
        }
      })
      .catch(() => {
        if (!cancelled) {
          // 503 (demo mode) or unreachable — hide the section.
          setEnabled(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!enabled) {
    return null;
  }

  const rows: AdapterSessionLine[] = (sessions ?? []).map((session) => ({
    key: session.sessionId,
    title: session.cwd.length > 0 ? session.cwd : session.sessionId,
    meta: [
      new Date(session.updatedAt).toLocaleString(),
      session.running ? t('sessions.dsh.running') : '',
      session.agentPreset ?? '',
    ]
      .filter(Boolean)
      .join(' · '),
    color: '#7c3aed',
    detail: async () => {
      try {
        const response = await api.dshWebHistory(session.sessionId);
        const history = Array.isArray(response.history) ? response.history : [];
        const lines: Array<{ role: string; text: string }> = [];
        for (const item of history) {
          if (item === null || typeof item !== 'object') {
            continue;
          }
          const record = item as Record<string, unknown>;
          const role = typeof record['role'] === 'string' ? record['role'] : 'assistant';
          const text = (record as { text?: unknown })['text'];
          if (typeof text === 'string' && text.length > 0) {
            lines.push({ role, text });
          }
        }
        return lines;
      } catch {
        // Honest boundary: without a connected dsh web there is no
        // transcript to show (headless persists session headers only).
        throw new Error(t('sessions.dsh.detailUnavailable'));
      }
    },
  }));

  return (
    <AdapterSessionsSection
      icon="/icons/agents/dsh.svg"
      label="DeepSeek Harness"
      hint="~/.dsh/sessions"
      rows={rows}
      emptyText={t('sessions.dsh.empty')}
    />
  );
}
