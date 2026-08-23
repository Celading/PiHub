import { useCallback, useEffect, useState } from 'react';
import { api, type RuntimeCapabilitiesResponse, type ServiceTargetId } from '../api/client.js';
import { loadSessionDraft, saveSessionDraft, type SessionDraft, type SessionMode } from '../chat/sessionDraft.js';
import { useI18n } from '../i18n/I18nProvider.js';
import './NewSessionDialog.css';

export const NEW_SESSION_REQUEST_EVENT = 'pihub:new-session-request';

interface NewSessionDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (draft: SessionDraft) => void | Promise<void>;
}

/**
 * New-session dialog: choose the working folder (browse or type) and the
 * agent (pi / codex) before the session is created. The choice is persisted
 * as the session draft so a reload keeps it.
 */
export function NewSessionDialog({ open, onClose, onCreated }: NewSessionDialogProps): React.JSX.Element | null {
  const { t } = useI18n();
  const draft = loadSessionDraft();
  const [mode, setMode] = useState<SessionMode>(draft?.mode ?? 'workspace');
  const [folder, setFolder] = useState(draft?.cwd ?? '');
  // The agent list follows the adapters the backend actually exposes
  // (dsh is first-class on every form; availability is backend-judged).
  const [agentOptions, setAgentOptions] = useState<Array<'pi' | 'codex' | 'dsh' | 'claude'>>(['pi', 'codex']);
  const [agent, setAgent] = useState<'pi' | 'codex' | 'dsh' | 'claude'>(() => {
    const saved = draft?.agent;
    return saved === 'dsh' ? 'pi' : (saved ?? 'pi');
  });
  const [serviceTarget, setServiceTarget] = useState<ServiceTargetId>(draft?.serviceTarget ?? 'builtin-pihub');
  const [runtime, setRuntime] = useState<RuntimeCapabilitiesResponse | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState('');
  const [browseDirs, setBrowseDirs] = useState<string[]>([]);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the live adapter list once so the picker only offers agents the
  // backend actually exposes.
  useEffect(() => {
    let cancelled = false;
    void api
      .adapters()
      .then((response) => {
        if (cancelled) {
          return;
        }
        const kinds = new Set(response.adapters.map((entry) => entry.kind));
        const options: Array<'pi' | 'codex' | 'dsh' | 'claude'> = ['pi', 'codex'];
        if (kinds.has('dsh')) {
          options.push('dsh');
        }
        if (kinds.has('claude')) {
          options.push('claude');
        }
        setAgentOptions(options);
        setAgent((current) => (current === 'dsh' && !kinds.has('dsh') ? 'pi' : current));
      })
      .catch(() => {
        // offline — keep the pi/codex defaults
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.runtimeCapabilities().then((value) => {
      if (!cancelled) {
        setRuntime(value);
      }
    }).catch(() => {
      // The dialog can still render the built-in defaults while the server is offline.
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset state whenever the dialog opens.
  useEffect(() => {
    if (open) {
      const saved = loadSessionDraft();
      setMode(saved?.mode ?? 'workspace');
      setFolder(saved?.cwd ?? '');
      setServiceTarget(saved?.serviceTarget ?? 'builtin-pihub');
      const savedAgent = saved?.agent;
      setAgent(savedAgent === 'dsh' && !agentOptions.includes('dsh') ? 'pi' : (savedAgent ?? 'pi'));
      setBrowseOpen(false);
      setBrowseError(null);
      setError(null);
      setCreating(false);
    }
  }, [open, agentOptions]);

  const openBrowser = useCallback(async (): Promise<void> => {
    setBrowseError(null);
    try {
      const result = await api.dirs(folder.length > 0 ? folder : undefined);
      setBrowsePath(result.path);
      setBrowseDirs(result.dirs);
      setBrowseOpen(true);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : String(err));
    }
  }, [folder]);

  const enterDir = useCallback(async (name: string): Promise<void> => {
    setBrowseError(null);
    const next = browsePath.endsWith('/') ? `${browsePath}${name}` : `${browsePath}/${name}`;
    try {
      const result = await api.dirs(next);
      setBrowsePath(result.path);
      setBrowseDirs(result.dirs);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : String(err));
    }
  }, [browsePath]);

  const goUp = useCallback(async (): Promise<void> => {
    setBrowseError(null);
    const parent = browsePath.split('/').slice(0, -1).join('/') || '/';
    try {
      const result = await api.dirs(parent);
      setBrowsePath(result.path);
      setBrowseDirs(result.dirs);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : String(err));
    }
  }, [browsePath]);

  const chooseFolder = useCallback((): void => {
    setFolder(browsePath);
    setBrowseOpen(false);
  }, [browsePath]);

  const create = useCallback(async (): Promise<void> => {
    if (mode === 'workspace') {
      const trimmed = folder.trim();
      if (trimmed.length === 0) {
        setError(t('session.new.folderRequired'));
        return;
      }
      const target = runtime?.services.find((entry) => entry.id === serviceTarget);
      if (target !== undefined && !target.canCreateSession) {
        setError(target.reason ?? 'selected service is not connected');
        return;
      }
      saveSessionDraft({ cwd: trimmed, agent, serviceTarget, mode });
      setCreating(true);
      setError(null);
      try {
        await onCreated({ cwd: trimmed, agent, serviceTarget, mode });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setCreating(false);
      }
      return;
    }
    // Chat-only mode: no workspace; the server uses its default working
    // folder. Session content still persists to the panel home (private
    // space on 2in1/PC, sandbox elsewhere).
    const target = runtime?.services.find((entry) => entry.id === serviceTarget);
    if (target !== undefined && !target.canCreateSession) {
      setError(target.reason ?? 'selected service is not connected');
      return;
    }
    saveSessionDraft({ cwd: '', agent, serviceTarget, mode: 'chat' });
    setCreating(true);
    setError(null);
    try {
      await onCreated({ cwd: '', agent, serviceTarget, mode: 'chat' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  }, [mode, folder, agent, onCreated, runtime, serviceTarget, t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="new-session-overlay" role="presentation" onClick={onClose}>
      <div
        className="new-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('session.new.title')}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="new-session-title mono">{t('session.new.title')}</div>

        <div className="new-session-row">
          <span className="new-session-label mono">{t('session.new.service')}</span>
          <div className="new-session-agents">
            {(runtime?.services ?? [
              { id: 'builtin-pihub' as const, label: 'Built-in PiHub', canCreateSession: true, reason: null },
              { id: 'local-service' as const, label: 'Local service', canCreateSession: false, reason: 'connection required' },
              { id: 'remote-pihub' as const, label: 'Remote PiHub', canCreateSession: false, reason: 'pairing required' },
              { id: 'nearby-pihub' as const, label: 'Nearby PiHub', canCreateSession: false, reason: 'discovery required' },
            ]).map((target) => (
              <label key={target.id} className="new-session-agent mono" title={target.reason ?? undefined}>
                <input
                  type="radio"
                  name="new-session-service"
                  checked={serviceTarget === target.id}
                  onChange={() => {
                    setServiceTarget(target.id);
                    setError(null);
                  }}
                />
                {target.label}
                {!target.canCreateSession ? <span className="new-session-target-note">{target.reason}</span> : null}
              </label>
            ))}
          </div>
        </div>

        <div className="new-session-row">
          <span className="new-session-label mono">{t('session.new.mode')}</span>
          <div className="new-session-agents">
            {(['workspace', 'chat'] as const).map((value) => (
              <label key={value} className="new-session-agent mono">
                <input
                  type="radio"
                  name="new-session-mode"
                  checked={mode === value}
                  onChange={() => {
                    setMode(value);
                  }}
                />
                {value === 'workspace' ? t('session.new.modeWorkspace') : t('session.new.modeChat')}
              </label>
            ))}
          </div>
        </div>

        {mode === 'workspace' ? (
          <div className="new-session-row">
            <span className="new-session-label mono">{t('session.new.folder')}</span>
            <div className="new-session-folder-row">
              <input
                type="text"
                className="new-session-folder-input mono"
                placeholder={t('session.new.folderPlaceholder')}
                value={folder}
                onChange={(event) => {
                  setFolder(event.target.value);
                }}
              />
              <button
                type="button"
                className="btn-secondary mono"
                onClick={() => {
                  void openBrowser();
                }}
              >
                {t('session.new.browse')}
              </button>
            </div>
          </div>
        ) : null}

        {browseError !== null ? (
          <p className="new-session-error mono" role="alert">
            {browseError}
          </p>
        ) : null}

        {browseOpen ? (
          <div className="new-session-browser">
            <div className="new-session-browser-head">
              <span className="new-session-browser-path mono" title={browsePath}>
                {browsePath}
              </span>
              <button
                type="button"
                className="btn-secondary mono"
                disabled={browsePath === '/'}
                onClick={() => {
                  void goUp();
                }}
              >
                {t('session.new.up')}
              </button>
            </div>
            <ul className="new-session-dir-list">
              {browseDirs.map((name) => (
                <li key={name}>
                  <button
                    type="button"
                    className="new-session-dir mono"
                    onClick={() => {
                      void enterDir(name);
                    }}
                  >
                    {name}/
                  </button>
                </li>
              ))}
              {browseDirs.length === 0 ? (
                <li className="new-session-empty mono">{t('session.new.noDirs')}</li>
              ) : null}
            </ul>
            <button
              type="button"
              className="btn-primary mono"
              onClick={chooseFolder}
            >
              {t('session.new.selectFolder')}
            </button>
          </div>
        ) : null}

        <div className="new-session-row">
          <span className="new-session-label mono">{t('session.new.agent')}</span>
          <div className="new-session-agents">
            {agentOptions.map((value) => (
              <label key={value} className="new-session-agent mono">
                <input
                  type="radio"
                  name="new-session-agent"
                  disabled={runtime?.engines.find((entry) => entry.engine === (value === 'dsh' ? 'dsh' : 'pi'))?.canCreateSession === false}
                  checked={agent === value}
                  onChange={() => {
                    setAgent(value);
                  }}
                />
                {value === 'dsh' ? t('session.new.agentDsh') : value === 'pi' ? t('session.new.agentPi') : value === 'codex' ? t('session.new.agentCodex') : 'Claude'}
              </label>
            ))}
          </div>
        </div>
        <p className="new-session-hint">
          {runtime === null ? t('session.new.checking') : `${t('session.new.hint')} ${runtime.mode === 'debug' ? t('session.new.debug') : ''}`}
        </p>

        {error !== null ? <p className="new-session-error mono">{error}</p> : null}

        <div className="new-session-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={creating}
            onClick={() => {
              void create();
            }}
          >
            {creating ? t('session.new.creating') : t('session.new.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
