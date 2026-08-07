import { useEffect, useMemo, useState } from 'react';
import type { PiCommand } from '../../shared/types.js';
import { api } from '../api/client.js';
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

/**
 * Automation · Skills · Pipelines center (P1-02). Skills and automation
 * surface pi-native capabilities; the pipelines tab is the PiHub-exclusive
 * orchestration surface (engine lands in P1-02 C1).
 */
export function AutomationPage({ onRunCommand }: { onRunCommand: (name: string) => void }): React.JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<AutomationTab>('skills');
  const [commands, setCommands] = useState<PiCommand[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

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
    <section className="automation-page">
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
                            className="automation-run mono"
                            onClick={() => {
                              onRunCommand(command.name);
                            }}
                            title={t('automation.run')}
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
          <div className="automation-row">
            <span className="automation-row-label">{t('automation.autoCompaction')}</span>
            <span className="automation-row-value mono">{t('automation.inSettings')}</span>
          </div>
          <div className="automation-row">
            <span className="automation-row-label">{t('automation.autoRetry')}</span>
            <span className="automation-row-value mono">{t('automation.inSettings')}</span>
          </div>
          <div className="automation-row">
            <span className="automation-row-label">{t('automation.modes')}</span>
            <span className="automation-row-value mono">{t('automation.inSettings')}</span>
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
