import { useEffect, useMemo, useState } from 'react';
import type { PiCommand, RpcState, RpcStreamEvent } from '../../shared/types.js';
import { api } from '../api/client.js';
import { eventsUrl } from '../api/controlToken.js';
import { useI18n, type MessageKey } from '../i18n/I18nProvider.js';
import { LoadingHint } from '../components/LoadingHint.js';
import { PipelinesTab } from '../pipelines/PipelinesTab.js';
import './AutomationPage.css';

type AutomationTab = 'skills' | 'automation' | 'pipelines';

const SOURCE_LABEL: Record<PiCommand['source'], MessageKey> = {
  skill: 'automation.source.skill',
  prompt: 'automation.source.prompt',
  extension: 'automation.source.extension',
};

/* P1-02 S2: live event feed (recent activity of the pi session). */
const EVENT_LABELS: Record<string, MessageKey> = {
  agent_start: 'automation.event.agent_start',
  agent_end: 'automation.event.agent_end',
  agent_settled: 'automation.event.agent_settled',
  auto_retry_start: 'automation.event.auto_retry_start',
  auto_retry_end: 'automation.event.auto_retry_end',
  compaction_start: 'automation.event.compaction_start',
  compaction_end: 'automation.event.compaction_end',
  session_compact: 'automation.event.session_compact',
  thinking_level_changed: 'automation.event.thinking_level_changed',
  model_select: 'automation.event.model_select',
};
const WATCHED_EVENTS = new Set(Object.keys(EVENT_LABELS));
const MAX_EVENTS = 8;

interface AutomationEventEntry {
  key: number;
  time: number;
  type: string;
}

const MODES_KEY = 'pi-panel:modes';

function loadLocalModes(): { steering: string; followUp: string } {
  try {
    const raw = localStorage.getItem(MODES_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        return {
          steering: typeof record['steering'] === 'string' ? record['steering'] : 'one-at-a-time',
          followUp: typeof record['followUp'] === 'string' ? record['followUp'] : 'sequential',
        };
      }
    }
  } catch {
    // fall through
  }
  return { steering: 'one-at-a-time', followUp: 'sequential' };
}

function formatEventTime(epochMs: number, intlTag: string): string {
  return new Intl.DateTimeFormat(intlTag, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(epochMs));
}

/**
 * Automation · Skills · Pipelines center (P1-02). Skills and automation
 * surface pi-native capabilities; the pipelines tab is the PiHub-exclusive
 * orchestration surface (engine lands in P1-02 C1). P1-02 S2: the
 * automation tab aggregates the run-mode switches (auto compaction / auto
 * retry / steering / follow-up) and shows a live status + event feed.
 */
export function AutomationPage({ onRunCommand }: { onRunCommand: (name: string) => void }): React.JSX.Element {
  const { t, intlTag } = useI18n();
  const [tab, setTab] = useState<AutomationTab>('skills');
  const [commands, setCommands] = useState<PiCommand[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  // P1-02 S2: run-mode switches + live status/events.
  const [rpcState, setRpcState] = useState<RpcState | null>(null);
  const [autoRetry, setAutoRetry] = useState<boolean>(true);
  const [retrying, setRetrying] = useState(false);
  const [modes, setModes] = useState<{ steering: string; followUp: string }>(loadLocalModes);
  const [events, setEvents] = useState<AutomationEventEntry[]>([]);
  const [modeError, setModeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const list = await api.commands();
        if (!cancelled) {
          setCommands(list);
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

  // Live state + event feed (P1-02 S2).
  useEffect(() => {
    let cancelled = false;
    let nextKey = 0;
    const refreshState = async (): Promise<void> => {
      try {
        const state = await api.rpcState();
        if (!cancelled) {
          setRpcState(state);
          if (typeof state.steeringMode === 'string' && state.steeringMode.length > 0) {
            setModes((prev) => ({ ...prev, steering: state.steeringMode ?? prev.steering }));
          }
          if (typeof state.followUpMode === 'string' && state.followUpMode.length > 0) {
            setModes((prev) => ({ ...prev, followUp: state.followUpMode ?? prev.followUp }));
          }
        }
      } catch {
        // backend offline — keep previous state
      }
    };
    void refreshState();

    const source = new EventSource(eventsUrl());
    const onPiEvent = (event: MessageEvent<string>): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return;
      }
      const record = parsed as RpcStreamEvent;
      if (typeof record.type !== 'string' || !WATCHED_EVENTS.has(record.type)) {
        return;
      }
      nextKey += 1;
      setEvents((prev) => [...prev.slice(-(MAX_EVENTS - 1)), { key: nextKey, time: Date.now(), type: record.type }]);
      if (record.type === 'auto_retry_start') {
        setRetrying(true);
      } else if (record.type === 'auto_retry_end' || record.type === 'agent_settled') {
        setRetrying(false);
      }
      if (record.type === 'agent_end' || record.type === 'agent_settled' || record.type === 'model_select' || record.type === 'thinking_level_changed') {
        void refreshState();
      }
    };
    source.addEventListener('pi', onPiEvent);
    return () => {
      cancelled = true;
      source.close();
    };
  }, []);

  const compactionEnabled = rpcState?.autoCompactionEnabled === true;
  const queueCount = rpcState?.pendingMessageCount ?? 0;

  const setCompaction = (next: boolean): void => {
    setModeError(null);
    void api
      .setAutoCompaction(next)
      .then(() => api.rpcState())
      .then((state) => {
        setRpcState(state);
      })
      .catch((err: unknown) => {
        setModeError(err instanceof Error ? err.message : String(err));
      });
  };

  const setRetry = (next: boolean): void => {
    setModeError(null);
    setAutoRetry(next);
    void api.setAutoRetry(next).catch((err: unknown) => {
      setAutoRetry(!next);
      setModeError(err instanceof Error ? err.message : String(err));
    });
  };

  const setMode = (key: 'steering' | 'followUp', value: string): void => {
    setModeError(null);
    const next = { ...modes, [key]: value };
    setModes(next);
    try {
      localStorage.setItem(MODES_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable
    }
    void (key === 'steering' ? api.setSteeringMode(value) : api.setFollowUpMode(value)).catch(
      (err: unknown) => {
        setModeError(err instanceof Error ? err.message : String(err));
      },
    );
  };

  const groups = useMemo(() => {
    const map = new Map<PiCommand['source'], PiCommand[]>();
    if (commands !== null) {
      const q = query.trim().toLowerCase();
      const filtered = q.length === 0 ? commands : commands.filter((c) => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q));
      for (const command of filtered) {
        const list = map.get(command.source);
        if (list !== undefined) {
          list.push(command);
        } else {
          map.set(command.source, [command]);
        }
      }
    }
    return map;
  }, [commands, query]);

  return (
    <section className="automation-page" data-shot="automation">
      <div className="automation-head">
        <h1 className="panel-title">{t('automation.title')}</h1>
        <div className="automation-tabs mono" role="tablist" aria-label={t('automation.title')}>
          {(['skills', 'automation', 'pipelines'] as AutomationTab[]).map((entry) => (
            <button
              key={entry}
              type="button"
              className="automation-tab"
              data-active={tab === entry}
              role="tab"
              aria-selected={tab === entry}
              onClick={() => {
                setTab(entry);
              }}
            >
              {t(`automation.tab.${entry}`)}
            </button>
          ))}
        </div>
      </div>

      {error !== null ? (
        <div className="automation-error mono" role="alert">
          {error}
        </div>
      ) : null}
      {modeError !== null ? (
        <div className="automation-error mono" role="alert">
          {modeError}
        </div>
      ) : null}

      {tab === 'skills' ? (
        <div className="automation-section">
          <input
            className="automation-search mono"
            type="search"
            value={query}
            placeholder={t('automation.search')}
            aria-label={t('automation.search')}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
          {commands === null ? (
            <p className="automation-hint">
              <LoadingHint>{t('settings.loading')}</LoadingHint>
            </p>
          ) : (
            <div className="automation-groups">
              {(['skill', 'prompt', 'extension'] as PiCommand['source'][]).map((source) => {
                const list = groups.get(source);
                if (list === undefined || list.length === 0) {
                  return null;
                }
                return (
                  <div key={source} className="automation-group">
                    <div className="automation-group-label mono">{t(SOURCE_LABEL[source])}</div>
                    <div className="automation-group-list">
                      {list.map((command) => (
                        <div key={command.name} className="automation-command">
                          <div className="automation-command-main">
                            <span className="automation-command-name mono">/{command.name}</span>
                            <span className="automation-command-desc">
                              {command.description ?? ''}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="automation-command-run mono"
                            onClick={() => {
                              onRunCommand(command.name);
                            }}
                          >
                            {t('automation.run')}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              {groups.size === 0 ? (
                <p className="automation-hint">{t('automation.skills.empty')}</p>
              ) : null}
            </div>
          )}
          <p className="automation-note mono">
            {t('automation.skills.note')}
          </p>
        </div>
      ) : null}

      {tab === 'automation' ? (
        <div className="automation-section">
          {/* P1-02 S2: live run status. */}
          <div className="automation-status-row">
            <span
              className="automation-status-lamp"
              data-on={rpcState?.isStreaming === true}
              data-retry={retrying}
            />
            <span className="automation-status-text mono">
              {rpcState?.isStreaming ? t('automation.status.running') : t('automation.status.idle')}
            </span>
            {rpcState?.isCompacting === true ? (
              <span className="automation-status-chip mono">{t('automation.status.compacting')}</span>
            ) : null}
            {retrying ? (
              <span className="automation-status-chip mono">{t('automation.status.retrying')}</span>
            ) : null}
            {queueCount > 0 ? (
              <span className="automation-status-chip mono">
                {t('automation.status.queue', { count: String(queueCount) })}
              </span>
            ) : null}
          </div>

          {/* P1-02 S2: switch aggregation. */}
          <div className="automation-switch-row">
            <span className="automation-row-label">{t('automation.autoCompaction')}</span>
            <input
              type="checkbox"
              className="automation-switch"
              checked={compactionEnabled}
              aria-label={t('automation.autoCompaction')}
              onChange={(event) => {
                setCompaction(event.target.checked);
              }}
            />
          </div>
          <div className="automation-switch-row">
            <span className="automation-row-label">{t('automation.autoRetry')}</span>
            <input
              type="checkbox"
              className="automation-switch"
              checked={autoRetry}
              aria-label={t('automation.autoRetry')}
              onChange={(event) => {
                setRetry(event.target.checked);
              }}
            />
          </div>
          <div className="automation-switch-row">
            <span className="automation-row-label">{t('automation.mode.steering')}</span>
            <select
              className="automation-select mono"
              value={modes.steering}
              aria-label={t('automation.mode.steering')}
              onChange={(event) => {
                setMode('steering', event.target.value);
              }}
            >
              <option value="one-at-a-time">{t('automation.mode.oneAtATime')}</option>
              <option value="all">{t('automation.mode.all')}</option>
            </select>
          </div>
          <div className="automation-switch-row">
            <span className="automation-row-label">{t('automation.mode.followUp')}</span>
            <select
              className="automation-select mono"
              value={modes.followUp}
              aria-label={t('automation.mode.followUp')}
              onChange={(event) => {
                setMode('followUp', event.target.value);
              }}
            >
              <option value="sequential">{t('automation.mode.sequential')}</option>
              <option value="all">{t('automation.mode.all')}</option>
            </select>
          </div>

          {/* P1-02 S2: recent event feed. */}
          <div className="automation-events">
            <div className="automation-group-label mono">{t('automation.events')}</div>
            {events.length === 0 ? (
              <p className="automation-hint">{t('automation.events.empty')}</p>
            ) : (
              <ul className="automation-event-list">
                {events.map((entry) => (
                  <li key={entry.key} className="automation-event">
                    <span className="automation-event-time mono">
                      {formatEventTime(entry.time, intlTag)}
                    </span>
                    <span className="automation-event-label mono">
                      {t(EVENT_LABELS[entry.type] ?? 'automation.events.unknown')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="automation-hint">{t('automation.automation.note')}</p>
        </div>
      ) : null}

      {tab === 'pipelines' ? (
        <div className="automation-section">
          <PipelinesTab />
        </div>
      ) : null}
    </section>
  );
}
