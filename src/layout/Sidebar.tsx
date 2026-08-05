import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../../shared/types.js';
import type { View } from '../types/app.js';
import { api } from '../api/client.js';
import './Sidebar.css';

const USER_ID_STORAGE_KEY = 'pi-panel:userId';
const MAX_SESSIONS = 8;

interface SidebarProps {
  view: View;
  onViewChange: (view: View) => void;
  onSessionChanged: () => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter((part) => part.length > 0);
  if (parts.length <= 2) {
    return cwd;
  }
  return `${parts[0] ?? ''}/…/${parts[parts.length - 1] ?? ''}`;
}

export function Sidebar({ view, onViewChange, onSessionChanged }: SidebarProps): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [query, setQuery] = useState('');
  const [userId, setUserId] = useState<string>(() => {
    return localStorage.getItem(USER_ID_STORAGE_KEY) ?? 'guest';
  });
  const [editingUser, setEditingUser] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await api.sessions();
        if (!cancelled) {
          setSessions(response.sessions.slice(0, MAX_SESSIONS));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      return sessions;
    }
    return sessions.filter((session) => {
      return (
        session.cwd.toLowerCase().includes(needle) ||
        session.models.some((model) => model.toLowerCase().includes(needle))
      );
    });
  }, [sessions, query]);

  const handleNewSession = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const response = await api.newSession();
      if (!response.success) {
        setError(response.error ?? 'failed to start new session');
        return;
      }
      onSessionChanged();
      onViewChange('chat');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onSessionChanged, onViewChange]);

  const handleResume = useCallback(
    async (session: SessionSummary): Promise<void> => {
      setError(null);
      try {
        const response = await api.switchSession(session.fileName);
        if (!response.success) {
          setError(response.error ?? 'failed to open session');
          return;
        }
        onSessionChanged();
        onViewChange('chat');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [onSessionChanged, onViewChange],
  );

  const saveUserId = (value: string): void => {
    const trimmed = value.trim();
    const next = trimmed.length === 0 ? 'guest' : trimmed;
    setUserId(next);
    localStorage.setItem(USER_ID_STORAGE_KEY, next);
    setEditingUser(false);
  };

  return (
    <nav className="sidebar" aria-label="Primary">
      <div className="sidebar-top">
        <button type="button" className="sidebar-new" onClick={() => { void handleNewSession(); }}>
          <span aria-hidden="true">＋</span>
          <span>新建会话/任务</span>
        </button>
        <input
          className="sidebar-search"
          type="search"
          placeholder="搜索会话/内容"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          aria-label="搜索会话/内容"
        />
        <button
          type="button"
          className="sidebar-feature"
          title="自动化 / 技能 / 工程流（二期）"
          aria-disabled="true"
        >
          <span className="sidebar-feature-icon" aria-hidden="true">
            ⚙
          </span>
          <span>自动化 / 技能 / 工程流</span>
          <span className="sidebar-feature-tag mono">phase 2</span>
        </button>
        {error !== null ? <div className="sidebar-error mono">{error}</div> : null}
      </div>

      <hr className="swiss-rule" />

      <div className="sidebar-sessions scroll-area">
        <div className="sidebar-section-label swiss-section-label">sessions</div>
        {filtered.length === 0 ? (
          <p className="sidebar-empty mono">
            {query.length > 0 ? 'no match' : 'no sessions yet'}
          </p>
        ) : (
          <ul className="sidebar-session-list">
            {filtered.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className="sidebar-session-item"
                  onClick={() => { void handleResume(session); }}
                  title={session.cwd}
                >
                  <span className="sidebar-session-cwd mono">{shortCwd(session.cwd)}</span>
                  <span className="sidebar-session-meta mono">
                    {String(session.messageCount)} msgs · {formatTime(session.lastActivityAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-footer-actions">
          <button
            type="button"
            className="sidebar-footer-link mono"
            title="帮助（二期）"
            aria-disabled="true"
          >
            帮助
          </button>
          <button
            type="button"
            className="sidebar-footer-link mono"
            data-active={view === 'sessions'}
            onClick={() => { onViewChange('sessions'); }}
          >
            历史
          </button>
          <button
            type="button"
            className="sidebar-footer-link mono"
            data-active={view === 'stats'}
            onClick={() => { onViewChange('stats'); }}
          >
            统计
          </button>
        </div>
        <div className="sidebar-user">
          {editingUser ? (
            <input
              className="sidebar-user-input mono"
              defaultValue={userId}
              autoFocus
              aria-label="自定义用户 ID"
              onBlur={(event) => {
                saveUserId(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  saveUserId((event.target as HTMLInputElement).value);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="sidebar-user-id mono"
              onClick={() => { setEditingUser(true); }}
              title="点击自定义用户 ID"
            >
              <span className="sidebar-user-avatar" aria-hidden="true">
                {userId.slice(0, 1).toUpperCase()}
              </span>
              {userId}
            </button>
          )}
          <button
            type="button"
            className="sidebar-footer-link mono"
            data-active={view === 'settings'}
            onClick={() => { onViewChange('settings'); }}
          >
            设置
          </button>
        </div>
      </div>
    </nav>
  );
}
