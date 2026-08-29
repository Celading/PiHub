import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { eventsUrl } from '../api/controlToken.js';
import { useI18n } from '../i18n/I18nProvider.js';
import './DshWebSection.css';

interface DshWebSessionRow {
  sessionId: string;
  updatedAt?: number;
  running?: boolean;
  cwd?: string;
  [key: string]: unknown;
}

interface LiveFrame {
  frameType: string;
  sessionId?: string;
  rpcId?: string;
  approvalId?: string;
  text: string;
  timestamp: number;
}

interface DshDescribe {
  version?: string;
  cwd?: string;
  provider?: string;
  model?: string;
  attachedSessions?: number;
}

const MAX_FRAMES = 15;
const URL_STORAGE_KEY = 'pi-panel:dsh-web-url';

/**
 * dsh Web (real-time sessions) — connects the panel to a running
 * `dsh web` instance: real sessions, drive (prompt/cancel) and a
 * live event feed (the same stream the browser UI uses, re-broadcast over
 * the panel's SSE hub).
 */
export function DshWebSection(): React.JSX.Element | null {
  const { t } = useI18n();
  const [url, setUrl] = useState<string>(() => localStorage.getItem(URL_STORAGE_KEY) ?? 'http://127.0.0.1:3080');
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<'connected' | 'connecting' | 'reconnecting' | 'disconnected'>('disconnected');
  const [describe, setDescribe] = useState<DshDescribe | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [sessions, setSessions] = useState<DshWebSessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [frames, setFrames] = useState<LiveFrame[]>([]);
  const [promptText, setPromptText] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);
  const framesRef = useRef<LiveFrame[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const status = await api.dshWebStatus();
      setConnected(status.connected);
      setConnectionState(status.state);
      setDescribe(status.describe !== null && typeof status.describe === 'object' ? status.describe : null);
      if (!status.connected && status.lastError !== null) {
        setError(status.lastError);
      }
      if (status.connected) {
        const [sessionRes, approvalRes] = await Promise.all([
          api.dshWebSessions(),
          api.dshWebApprovals(),
        ]);
        const items = (sessionRes.sessions as { items?: DshWebSessionRow[] }).items ?? [];
        setSessions(items);
        const pending = Array.isArray(approvalRes.approvals)
          ? approvalRes.approvals as Array<{
            rpcId?: string;
            sessionId?: string;
            approvalId?: string;
            summary?: string;
            timestamp?: number;
          }>
          : [];
        const approvalFrames: LiveFrame[] = pending.flatMap((item) => {
          if (item.rpcId === undefined || item.sessionId === undefined || item.approvalId === undefined) {
            return [];
          }
          return [{
            frameType: 'approval/requested',
            rpcId: item.rpcId,
            sessionId: item.sessionId,
            approvalId: item.approvalId,
            text: item.summary ?? 'DSH 请求执行受保护操作',
            timestamp: item.timestamp ?? Date.now(),
          }];
        });
        const otherFrames = framesRef.current.filter((item) => item.frameType !== 'approval/requested');
        framesRef.current = [...approvalFrames, ...otherFrames].slice(0, MAX_FRAMES);
        setFrames([...framesRef.current]);
      } else {
        setSessions([]);
      }
    } catch {
      // 503 (demo mode) or unreachable — hide the section entirely.
      setEnabled(false);
    }
  }, []);

  const connect = useCallback(async (): Promise<void> => {
    setConnecting(true);
    setError(null);
    try {
      localStorage.setItem(URL_STORAGE_KEY, url.trim());
      await api.dshWebConnect(url.trim());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }, [url, refresh]);

  const frameText = (payload: Record<string, unknown>): string => {
    const event = payload['event'] as { type?: string; data?: Record<string, unknown> } | undefined;
    if (payload['frameType'] === 'session/event' && event !== undefined) {
      const data = event.data;
      if (data !== undefined && typeof data === 'object') {
        const text = data['text'];
        if (typeof text === 'string') {
          return text.slice(0, 100);
        }
      }
      return event.type ?? '';
    }
    const message = payload['message'];
    return typeof message === 'string' ? message.slice(0, 100) : '';
  };

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
      if (payload['type'] !== 'dsh_web_event') {
        return;
      }
      const str = (value: unknown): string => (typeof value === 'string' ? value : '');
      const dshEvent = payload['event'];
      const eventRecord = dshEvent !== null && typeof dshEvent === 'object'
        ? dshEvent as Record<string, unknown>
        : null;
      const eventData = eventRecord?.['data'];
      const dataRecord = eventData !== null && typeof eventData === 'object'
        ? eventData as Record<string, unknown>
        : null;
      const frame: LiveFrame = {
        frameType: str(payload['frameType']),
        sessionId: str(payload['sessionId']),
        rpcId: str(payload['rpcId']),
        approvalId: str(payload['approvalId']) || str(dataRecord?.['approvalId']),
        text: frameText(payload),
        timestamp: typeof payload['timestamp'] === 'number' ? payload['timestamp'] : Date.now(),
      };
      framesRef.current = [frame, ...framesRef.current].slice(0, MAX_FRAMES);
      setFrames([...framesRef.current]);
    };
    return () => {
      window.clearInterval(timer);
      source.close();
    };
  }, [refresh]);

  const sendPrompt = useCallback(
    async (sessionId: string): Promise<void> => {
      const text = (promptText[sessionId] ?? '').trim();
      if (text.length === 0) {
        return;
      }
      setSending(sessionId);
      setError(null);
      try {
        await api.dshWebPrompt(sessionId, text);
        setPromptText((prev) => ({ ...prev, [sessionId]: '' }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(null);
      }
    },
    [promptText],
  );

  const cancel = useCallback(async (sessionId: string): Promise<void> => {
    try {
      await api.dshWebCancel(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const createSession = useCallback(async (): Promise<void> => {
    setSending('new');
    setError(null);
    try {
      await api.dshWebCreateSession();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(null);
    }
  }, [refresh]);

  const answerApproval = useCallback(async (
    frame: LiveFrame,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<void> => {
    if (frame.rpcId === undefined || frame.sessionId === undefined || frame.approvalId === undefined) {
      return;
    }
    setSending(frame.rpcId);
    setError(null);
    try {
      await api.dshWebApprove(frame.rpcId, frame.sessionId, frame.approvalId, outcome);
      framesRef.current = framesRef.current.filter((item) => item.rpcId !== frame.rpcId);
      setFrames([...framesRef.current]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(null);
    }
  }, []);

  const shortId = (sessionId: string): string =>
    sessionId.length > 14 ? `${sessionId.slice(0, 14)}…` : sessionId;

  if (!enabled) {
    return null;
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section-title mono">{t('settings.dshWeb.title')}</h2>
      <div className="setting-row">
        <span className="setting-label mono">{t('settings.dshWeb.url')}</span>
        <div className="setting-row-value">
          <input
            type="text"
            className="setting-input mono"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
            }}
          />
          <button type="button" className="btn-primary" disabled={connecting} onClick={() => void connect()}>
            {connecting ? t('settings.dshWeb.connecting') : connected ? t('settings.dshWeb.reconnect') : t('settings.dshWeb.connect')}
          </button>
        </div>
      </div>
      <div className="setting-row">
        <span className="setting-label mono">{t('settings.dshWeb.status')}</span>
        <div className="setting-row-value">
          <span className="setting-value mono" data-status={connected ? 'ok' : 'warn'}>
            {connected
              ? t('settings.dshWeb.connected')
              : connectionState === 'connecting' || connectionState === 'reconnecting'
                ? t('settings.dshWeb.connecting')
                : t('settings.dshWeb.disconnected')}
          </span>
          {describe !== null ? (
            <span className="dsh-web-runtime-meta mono">
              {describe.version ?? 'dsh'}
              {describe.provider !== undefined ? ` · ${describe.provider}` : ''}
              {describe.model !== undefined ? ` / ${describe.model}` : ''}
              {typeof describe.attachedSessions === 'number' ? ` · ${String(describe.attachedSessions)} sessions` : ''}
            </span>
          ) : null}
        </div>
      </div>
      {error !== null ? (
        <p className="new-session-error mono" role="alert">
          {error}
        </p>
      ) : null}
      {connected ? (
        <div className="dsh-web-toolbar">
          <button type="button" className="btn-secondary mono" disabled={sending === 'new'} onClick={() => void createSession()}>
            {sending === 'new' ? '…' : t('settings.dshWeb.newSession')}
          </button>
        </div>
      ) : null}
      {sessions.length > 0 ? (
        <ul className="dsh-web-sessions">
          {sessions.map((session) => (
            <li key={session.sessionId} className="dsh-web-session">
              <div className="dsh-web-session-head">
                <span className="dsh-web-session-id mono" title={session.sessionId}>
                  {shortId(session.sessionId)}
                </span>
                <span className="dsh-web-session-meta mono">
                  {session.running === true ? t('settings.dshWeb.running') : ''}
                  {typeof session.cwd === 'string' && session.cwd.length > 0 ? ` · ${session.cwd}` : ''}
                </span>
              </div>
              <div className="dsh-web-session-actions">
                <input
                  type="text"
                  className="setting-input mono"
                  placeholder={t('settings.dshWeb.promptPlaceholder')}
                  value={promptText[session.sessionId] ?? ''}
                  onChange={(event) => {
                    setPromptText((prev) => ({ ...prev, [session.sessionId]: event.target.value }));
                  }}
                />
                <button
                  type="button"
                  className="btn-secondary mono"
                  disabled={sending === session.sessionId}
                  onClick={() => void sendPrompt(session.sessionId)}
                >
                  {sending === session.sessionId ? '…' : t('settings.dshWeb.prompt')}
                </button>
                <button type="button" className="btn-secondary mono" onClick={() => void cancel(session.sessionId)}>
                  {t('settings.dshWeb.cancel')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-hint">{t('settings.dshWeb.noSessions')}</p>
      )}
      {frames.length > 0 ? (
        <div className="dsh-web-frames">
          <div className="dsh-web-frames-label mono">{t('settings.dshWeb.live')}</div>
          <ul className="dsh-web-frames-list">
            {frames.map((frame, index) => (
              <li key={`${String(frame.timestamp)}-${String(index)}`} className="dsh-web-frame mono">
                <div className="dsh-web-frame-main">
                  <span className="dsh-web-frame-type">{frame.frameType}</span>
                  <span className="dsh-web-frame-text">{frame.text || (frame.sessionId !== undefined && frame.sessionId.length > 0 ? shortId(frame.sessionId) : '')}</span>
                </div>
                {frame.frameType === 'approval/requested' && frame.rpcId !== undefined && frame.approvalId !== undefined ? (
                  <div className="dsh-web-approval-actions">
                    <button type="button" className="btn-secondary mono" disabled={sending === frame.rpcId} onClick={() => void answerApproval(frame, 'rejected')}>
                      {t('settings.dshWeb.reject')}
                    </button>
                    <button type="button" className="btn-primary mono" disabled={sending === frame.rpcId} onClick={() => void answerApproval(frame, 'allowed-once')}>
                      {t('settings.dshWeb.allowOnce')}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="settings-hint">{t('settings.dshWeb.hint')}</p>
    </section>
  );
}
