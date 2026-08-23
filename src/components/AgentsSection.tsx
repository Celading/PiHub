import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AgentManageRow } from '../api/client.js';
import { useI18n } from '../i18n/I18nProvider.js';
import './AgentsSection.css';

/**
 * Agent management — panel-side startup/config for pi/codex/dsh: binary
 * overrides persist to agents.json (effective from the next panel restart),
 * the pi RPC bridge restarts immediately. Lifecycle facts are honest:
 * codex/dsh have no resident process (per-call exec).
 */
export function AgentsSection(): React.JSX.Element {
  const { t } = useI18n();
  const [agents, setAgents] = useState<AgentManageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [binaryDrafts, setBinaryDrafts] = useState<Record<string, string>>({});
  const [restarting, setRestarting] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await api.agents();
      setAgents(response.agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveBinary = useCallback(
    async (kind: AgentManageRow['kind']): Promise<void> => {
      const value = (binaryDrafts[kind] ?? '').trim();
      setError(null);
      try {
        const response = await api.configureAgent(kind, { binary: value });
        setAgents(response.agents);
        setBinaryDrafts((prev) => ({ ...prev, [kind]: '' }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [binaryDrafts],
  );

  const toggleEnabled = useCallback(async (kind: AgentManageRow['kind'], enabled: boolean): Promise<void> => {
    setError(null);
    try {
      const response = await api.configureAgent(kind, { enabled });
      setAgents(response.agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const restartPi = useCallback(async (): Promise<void> => {
    setRestarting(true);
    setError(null);
    try {
      await api.restartPiAgent();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(false);
    }
  }, [refresh]);

  // One-click install: only agents without a binary get the button; the
  // server runs a predefined command template (never user input).
  const [installing, setInstalling] = useState<Record<string, boolean>>({});
  const [installOutput, setInstallOutput] = useState<Record<string, string>>({});
  const [installExit, setInstallExit] = useState<Record<string, number | null>>({});
  const installPollRef = useRef<Record<string, number | undefined>>({});

  const pollInstall = useCallback((kind: string): void => {
    const existing = installPollRef.current[kind];
    if (existing !== undefined) {
      window.clearInterval(existing);
    }
    installPollRef.current[kind] = window.setInterval(() => {
      void api
        .agentInstallStatus(kind)
        .then((response) => {
          const status = response.status;
          setInstallOutput((prev) => ({ ...prev, [kind]: status.output }));
          setInstallExit((prev) => ({ ...prev, [kind]: status.exit }));
          if (!status.running) {
            const timer = installPollRef.current[kind];
            if (timer !== undefined) {
              window.clearInterval(timer);
              installPollRef.current[kind] = undefined;
            }
            setInstalling((prev) => ({ ...prev, [kind]: false }));
            void refresh();
          }
        })
        .catch(() => {
          const timer = installPollRef.current[kind];
          if (timer !== undefined) {
            window.clearInterval(timer);
            installPollRef.current[kind] = undefined;
          }
          setInstalling((prev) => ({ ...prev, [kind]: false }));
        });
    }, 1500);
  }, [refresh]);

  const install = useCallback(
    async (kind: AgentManageRow['kind']): Promise<void> => {
      setError(null);
      try {
        const response = await api.installAgent(kind);
        setInstalling((prev) => ({ ...prev, [kind]: true }));
        setInstallOutput((prev) => ({ ...prev, [kind]: response.status.output }));
        setInstallExit((prev) => ({ ...prev, [kind]: null }));
        pollInstall(kind);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [pollInstall],
  );

  return (
    <section className="settings-section">
      <h2 className="settings-section-title mono">{t('settings.agents.title')}</h2>
      {error !== null ? (
        <p className="new-session-error mono" role="alert">
          {error}
        </p>
      ) : null}
      {agents === null ? (
        <p className="settings-hint">{t('settings.agents.loading')}</p>
      ) : (
        <ul className="agents-list">
          {agents.map((agent) => (
            <li key={agent.kind} className="agents-row">
              <div className="agents-row-head">
                <span className="agents-kind mono" data-kind={agent.kind}>
                  {agent.kind === 'pi' ? 'pi' : agent.kind === 'codex' ? 'Codex' : agent.kind === 'claude' ? 'Claude' : 'dsh'}
                </span>
                <span className="agents-status mono" data-ok={agent.available}>
                  {agent.available
                    ? agent.running
                      ? t('settings.agents.running')
                      : t('settings.agents.ready')
                    : t('settings.agents.missing')}
                </span>
                <span className="agents-version mono">{agent.version ?? ''}</span>
                <label className="agents-enable mono">
                  <input
                    type="checkbox"
                    checked={agent.enabled}
                    onChange={(event) => {
                      void toggleEnabled(agent.kind, event.target.checked);
                    }}
                  />
                  {t('settings.agents.enabled')}
                </label>
                {agent.kind === 'pi' ? (
                  <button
                    type="button"
                    className="btn-secondary mono"
                    disabled={restarting}
                    onClick={() => void restartPi()}
                  >
                    {restarting ? '…' : t('settings.agents.restart')}
                  </button>
                ) : null}
                {!agent.available && agent.kind !== 'pi' ? (
                  <button
                    type="button"
                    className="btn-secondary mono"
                    disabled={installing[agent.kind] === true}
                    onClick={() => void install(agent.kind)}
                  >
                    {installing[agent.kind] === true ? '…' : t('settings.agents.install')}
                  </button>
                ) : null}
              </div>
              {installing[agent.kind] === true || (installOutput[agent.kind] ?? '').length > 0 ? (
                <pre className="agents-install-output mono">
                  {(installOutput[agent.kind] ?? '').slice(-1200)}
                  {installExit[agent.kind] !== null ? `\n[exit ${String(installExit[agent.kind])}]` : ''}
                </pre>
              ) : null}
              <div className="agents-row-body">
                <span className="agents-binary mono" title={agent.binary ?? ''}>
                  {agent.binary ?? '—'}
                </span>
                <input
                  type="text"
                  className="setting-input mono"
                  placeholder={t('settings.agents.binaryPlaceholder')}
                  value={binaryDrafts[agent.kind] ?? ''}
                  onChange={(event) => {
                    setBinaryDrafts((prev) => ({ ...prev, [agent.kind]: event.target.value }));
                  }}
                />
                <button
                  type="button"
                  className="btn-secondary mono"
                  onClick={() => void saveBinary(agent.kind)}
                >
                  {t('settings.agents.saveBinary')}
                </button>
              </div>
              <p className="agents-lifecycle mono">{agent.lifecycle}</p>
            </li>
          ))}
        </ul>
      )}
      <p className="settings-hint">{t('settings.agents.hint')}</p>
    </section>
  );
}
