import { useCallback, useEffect, useState } from 'react';
import type { GitChange } from '../../shared/types.js';
import { api } from '../api/client.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { DiffView } from './DiffView.js';
import './RightChangesPanel.css';

const POLL_MS = 10_000;

/** P1-08b: git worktree changes for the right workbench (变更 tab).
 *  Read-only status + per-file diffs; polls lightly while the panel is
 *  visible so settle-driven changes converge without plumbing. */
export function RightChangesPanel({ sessionFile }: { sessionFile: string | null }): React.JSX.Element {
  const { t } = useI18n();
  const [root, setRoot] = useState<string | null>(null);
  const [repo, setRepo] = useState<boolean | null>(null);
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GitChange | null>(null);

  const load = useCallback((): void => {
    setError(null);
    if (sessionFile === null) {
      setRepo(null);
      setChanges([]);
      setRoot(null);
      return;
    }
    api
      .gitStatus(sessionFile)
      .then((response) => {
        setRoot(response.root);
        setRepo(response.repo);
        setChanges(response.changes);
      })
      .catch((reason: unknown) => {
        setRepo(null);
        setChanges([]);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [sessionFile]);

  useEffect(() => {
    load();
  }, [load]);

  // Light poll while the panel is visible — covers settle-driven changes.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        load();
      }
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [load]);

  const base = root === null ? '' : root.split('/').filter(Boolean).at(-1) ?? root;
  const staged = changes.filter((item) => item.staged);
  const unstaged = changes.filter((item) => !item.staged);

  return (
    <div className="right-changes">
      <div className="right-changes-head mono">
        <span className="right-changes-root" title={root ?? ''}>
          {base}
        </span>
        <button
          type="button"
          className="right-changes-refresh mono"
          title={t('rightSidebar.refresh')}
          onClick={() => {
            setSelected(null);
            load();
          }}
        >
          ⟳
        </button>
      </div>
      {error !== null ? (
        <p className="right-changes-error mono" role="alert">
          {error}
        </p>
      ) : null}
      {repo === false ? (
        <p className="right-changes-empty mono">{t('rightSidebar.changesNoRepo')}</p>
      ) : null}
      {repo === true && changes.length === 0 ? (
        <p className="right-changes-empty mono">{t('rightSidebar.changesClean')}</p>
      ) : null}
      {repo === true && changes.length > 0 && selected === null ? (
        <>
          <ChangeGroup title={t('rightSidebar.changesStaged')} items={staged} onOpen={setSelected} />
          <ChangeGroup title={t('rightSidebar.changesUnstaged')} items={unstaged} onOpen={setSelected} />
        </>
      ) : null}
      {selected !== null ? (
        <GitDiffView
          change={selected}
          sessionFile={sessionFile}
          onBack={() => {
            setSelected(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ChangeGroup({
  title,
  items,
  onOpen,
}: {
  title: string;
  items: GitChange[];
  onOpen: (change: GitChange) => void;
}): React.JSX.Element | null {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="right-changes-group">
      <p className="right-changes-group-title mono">
        {title} · {String(items.length)}
      </p>
      {items.map((item) => (
        <button
          key={`${item.index}:${item.path}`}
          type="button"
          className="right-changes-row mono"
          data-kind={item.kind}
          onClick={() => {
            onOpen(item);
          }}
        >
          <span className="right-changes-code" aria-hidden="true">
            {statusLetter(item)}
          </span>
          <span className="right-changes-path" title={item.path}>
            {item.path}
          </span>
        </button>
      ))}
    </div>
  );
}

function statusLetter(change: GitChange): string {
  switch (change.kind) {
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'untracked':
      return '?';
    case 'conflicted':
      return 'U';
    default:
      return 'M';
  }
}

function GitDiffView({
  change,
  sessionFile,
  onBack,
}: {
  change: GitChange;
  sessionFile: string | null;
  onBack: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [state, setState] = useState<{
    status: 'loading' | 'ok' | 'error';
    diff?: string;
    error?: string;
  }>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void api
      .gitDiff(change.path, sessionFile ?? undefined, change.staged)
      .then((response) => {
        if (!cancelled) {
          setState({ status: 'ok', diff: response.diff });
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            error: reason instanceof Error ? reason.message : String(reason),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [change, sessionFile]);

  return (
    <div className="right-changes-diff">
      <div className="right-changes-diff-head mono">
        <button type="button" className="right-changes-diff-back mono" onClick={onBack}>
          ←
        </button>
        <span className="right-changes-diff-path" title={change.path}>
          {change.path}
        </span>
        {change.staged ? (
          <span className="right-changes-diff-staged mono">{t('rightSidebar.changesStagedTag')}</span>
        ) : null}
      </div>
      {state.status === 'loading' ? (
        <p className="right-changes-empty mono">{t('settings.loading')}</p>
      ) : state.status === 'error' ? (
        <p className="right-changes-error mono" role="alert">
          {state.error}
        </p>
      ) : (state.diff ?? '').trim().length === 0 ? (
        <p className="right-changes-empty mono">{t('rightSidebar.changesNoDiff')}</p>
      ) : (
        <div className="right-changes-diff-body">
          <DiffView content={state.diff ?? ''} />
        </div>
      )}
    </div>
  );
}
