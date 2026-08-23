import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ExternalSessionEntry } from '../api/client.js';
import { eventsUrl } from '../api/controlToken.js';
import { useI18n } from '../i18n/I18nProvider.js';
import './ExternalSessionsPanel.css';

interface LiveEvent {
  agent: 'pi' | 'codex' | 'dsh';
  sessionId: string;
  role: string;
  text: string;
  timestamp: number;
}

const MAX_LIVE_EVENTS = 30;

/**
 * Shared-session stream panel: terminal-side pi/codex/dsh runs appear here in
 * near-real time (the watcher tails the agents' own session files). PiHub's
 * own runs write the same files, so they show up here too — the panel and the
 * terminal see one activity stream.
 */
export function ExternalSessionsPanel(): React.JSX.Element {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<ExternalSessionEntry[]>([]);
  const [live, setLive] = useState<LiveEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const liveRef = useRef<LiveEvent[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await api.externalSessions();
      setSessions(response.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 5000);
    const source = new EventSource(eventsUrl());
    source.onmessage = (event) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }
      if (payload['type'] !== 'external_event') {
        return;
      }
      const str = (value: unknown): string => (typeof value === 'string' ? value : '');
      const rawAgent = str(payload['agent']);
      const liveEvent: LiveEvent = {
        agent: rawAgent === 'pi' || rawAgent === 'codex' ? rawAgent : 'dsh',
        sessionId: str(payload['sessionId']),
        role: str(payload['role']) || 'meta',
        text: str(payload['text']),
        timestamp: typeof payload['timestamp'] === 'number' ? payload['timestamp'] : Date.now(),
      };
      if (liveEvent.text.length === 0) {
        return;
      }
      liveRef.current = [liveEvent, ...liveRef.current].slice(0, MAX_LIVE_EVENTS);
      setLive([...liveRef.current]);
    };
    return () => {
      window.clearInterval(timer);
      source.close();
    };
  }, [refresh]);

  const agentLabel = (agent: string): string =>
    agent === 'dsh' ? t('sessions.external.dsh') : agent === 'codex' ? 'Codex' : 'pi';

  const shortId = (sessionId: string): string =>
    sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId;

  return (
    <section className="external-sessions">
      <div className="external-sessions-head">
        <h2 className="external-sessions-title mono">{t('sessions.external.title')}</h2>
        <span className="external-sessions-count mono">{sessions.length}</span>
      </div>
      <p className="external-sessions-hint">{t('sessions.external.hint')}</p>
      {error !== null ? <p className="external-sessions-error mono">{error}</p> : null}
      {sessions.length === 0 && live.length === 0 ? (
        <p className="external-sessions-empty mono">{t('sessions.external.empty')}</p>
      ) : null}
      <ul className="external-sessions-list">
        {sessions.map((session) => (
          <li key={`${session.agent}:${session.sessionId}`} className="external-session">
            <span className="external-session-agent mono" data-agent={session.agent}>
              {agentLabel(session.agent)}
            </span>
            <span className="external-session-id mono" title={session.sessionId}>
              {shortId(session.sessionId)}
            </span>
            <span className="external-session-workspace mono" title={session.workspace}>
              {session.workspace || '—'}
            </span>
            <span className="external-session-text mono">{session.lastText}</span>
            <span className="external-session-time mono">
              {new Date(session.lastActivity).toLocaleTimeString()}
            </span>
          </li>
        ))}
      </ul>
      {live.length > 0 ? (
        <div className="external-sessions-live">
          <div className="external-sessions-live-label mono">{t('sessions.external.live')}</div>
          <ul className="external-sessions-live-list">
            {live.map((event, index) => (
              <li key={`${String(event.timestamp)}-${String(index)}`} className="external-live-line mono">
                <span className="external-live-agent" data-agent={event.agent}>
                  {agentLabel(event.agent)}
                </span>
                <span className="external-live-role" data-role={event.role}>
                  {event.role}
                </span>
                <span className="external-live-text">{event.text.slice(0, 120)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
