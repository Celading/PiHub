import { useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../../shared/types.js';
import { api } from '../api/client.js';
import { SessionDetailView } from './SessionDetailView.js';
import './SessionsPage.css';

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
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

function SessionRow({
  session,
  onOpen,
}: {
  session: SessionSummary;
  onOpen: (id: string) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="session-row"
      onClick={() => {
        onOpen(session.id);
      }}    >
      <span className="session-row-cwd mono">{shortCwd(session.cwd)}</span>
      <span className="session-row-stats mono">
        {String(session.messageCount)} msgs · {String(session.toolCalls)} tools
      </span>
      <span className="session-row-cost mono">${session.cost.toFixed(3)}</span>
      <span className="session-row-time mono">{formatDate(session.lastActivityAt)}</span>
    </button>
  );
}

export function SessionsPage(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await api.sessions();
        if (!cancelled) {
          setSessions(response.sessions);
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
  }, [reloadKey]);

  const grouped = useMemo(() => {
    if (sessions === null) {
      return null;
    }
    const groups = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      const dir = session.cwd || '(unknown)';
      const group = groups.get(dir);
      if (group === undefined) {
        groups.set(dir, [session]);
      } else {
        group.push(session);
      }
    }
    return [...groups.entries()];
  }, [sessions]);

  if (selectedId !== null) {
    return (
      <SessionDetailView
        id={selectedId}
        onBack={() => {
          setSelectedId(null);
        }}
      />
    );
  }

  return (
    <section className="sessions-page">
      <div className="sessions-head">
        <h1 className="panel-title">Sessions</h1>
        <div className="sessions-head-actions">
          <p className="sessions-head-hint mono">
            {sessions === null ? 'loading…' : `${String(sessions.length)} sessions`}
          </p>
          <button
            type="button"
            className="sessions-refresh"
            onClick={() => {
              setReloadKey(reloadKey + 1);
            }}
          >
            refresh
          </button>
        </div>
      </div>

      {error !== null ? <div className="sessions-error mono">{error}</div> : null}

      {grouped === null ? (
        <p className="sessions-hint">loading…</p>
      ) : grouped.length === 0 ? (
        <p className="sessions-hint">No sessions found under ~/.pi/agent/sessions.</p>
      ) : (
        <div className="sessions-groups">
          {grouped.map(([dir, list]) => (
            <div key={dir} className="sessions-group">
              <div className="sessions-group-label mono">{dir}</div>
              <div className="sessions-group-list">
                {list.map((session) => (
                  <SessionRow key={session.id} session={session} onOpen={setSelectedId} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
