import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileEntry, FileListing } from '../../shared/types.js';
import { api } from '../api/client.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { DiffView } from './DiffView.js';
import { looksLikeDiff } from './DiffBlock.js';
import './RightFilesPanel.css';

/** P1-08b: workspace file browser for the right workbench (文件 tab).
 *  Read-only tree of the active session's cwd with lazy directory expansion
 *  and an inline preview (diff-aware). */
export function RightFilesPanel({ sessionFile }: { sessionFile: string | null }): React.JSX.Element {
  const { t } = useI18n();
  const [root, setRoot] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [recent, setRecent] = useState<Array<{ path: string; action: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  /** Expanded dir paths → their cached children. */
  const [dirCache, setDirCache] = useState<Record<string, FileEntry[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  /** Selected file path → inline preview mode. */
  const [selected, setSelected] = useState<string | null>(null);

  const loadRoot = useCallback((): void => {
    setError(null);
    setSelected(null);
    setDirCache({});
    api
      .listFiles('', sessionFile ?? undefined)
      .then((listing: FileListing) => {
        setRoot(listing.root);
        setEntries(listing.entries);
        setRecent(listing.recent);
      })
      .catch((reason: unknown) => {
        setEntries(null);
        setRecent([]);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [sessionFile]);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

  const toggleDir = useCallback(
    (dirPath: string): void => {
      setSelected(null);
      if (dirCache[dirPath] !== undefined) {
        // collapse: drop children (re-expanding refetches — keeps it fresh)
        const next: Record<string, FileEntry[]> = {};
        for (const key of Object.keys(dirCache)) {
          if (key !== dirPath) {
            next[key] = dirCache[key] as FileEntry[];
          }
        }
        setDirCache(next);
        return;
      }
      setLoadingDirs((prev) => new Set(prev).add(dirPath));
      api
        .listFiles(dirPath, sessionFile ?? undefined)
        .then((listing: FileListing) => {
          setDirCache((prev) => ({ ...prev, [dirPath]: listing.entries }));
        })
        .catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          setLoadingDirs((prev) => {
            const next = new Set(prev);
            next.delete(dirPath);
            return next;
          });
        });
    },
    [dirCache, sessionFile],
  );

  const breadcrumb = useMemo(() => {
    const base = root === null ? '' : root.split('/').filter(Boolean).at(-1) ?? root;
    return base;
  }, [root]);

  /** Rows of one listing level (recursive via dirCache). */
  const renderLevel = (list: FileEntry[], depth: number): React.JSX.Element[] => {
    const rows: React.JSX.Element[] = [];
    for (const entry of list) {
      const isOpen = dirCache[entry.path] !== undefined;
      const isLoading = loadingDirs.has(entry.path);
      rows.push(
        <div key={entry.path}>
          <button
            type="button"
            className="right-files-row mono"
            data-kind={entry.kind}
            style={{ paddingLeft: `${String(8 + depth * 14)}px` }}
            data-selected={selected === entry.path}
            onClick={() => {
              if (entry.kind === 'dir') {
                toggleDir(entry.path);
              } else {
                setSelected(entry.path);
              }
            }}
          >
            <span className="right-files-caret" aria-hidden="true">
              {entry.kind === 'dir' ? (isLoading ? '…' : isOpen ? '−' : '+') : ''}
            </span>
            <span className="right-files-name">{entry.name}</span>
            {entry.kind === 'file' && entry.size !== undefined ? (
              <span className="right-files-meta">{formatSize(entry.size)}</span>
            ) : null}
          </button>
          {isOpen ? renderLevel(dirCache[entry.path] ?? [], depth + 1) : null}
        </div>,
      );
    }
    return rows;
  };

  return (
    <div className="right-files">
      <div className="right-files-head mono">
        <span className="right-files-breadcrumb" title={root ?? ''}>
          {breadcrumb}
        </span>
      </div>
      {error !== null ? (
        <p className="right-files-error mono" role="alert">
          {error}
        </p>
      ) : null}
      {entries === null && error === null ? (
        <p className="right-files-hint mono">{t('settings.loading')}</p>
      ) : null}
      {selected !== null ? (
        <FileContent
          path={selected}
          sessionFile={sessionFile}
          onBack={() => {
            setSelected(null);
          }}
        />
      ) : (
        <>
          <div className="right-files-tree">{entries !== null ? renderLevel(entries, 0) : null}</div>
          {recent.length > 0 ? (
            <div className="right-files-recent">
              <p className="right-files-recent-title mono">{t('rightSidebar.recent')}</p>
              {recent.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  className="right-files-row mono"
                  data-kind="file"
                  onClick={() => {
                    setSelected(item.path);
                  }}
                >
                  <span className="right-files-caret" aria-hidden="true">
                    {item.action[0]}
                  </span>
                  <span className="right-files-name" title={item.path}>
                    {item.path.split('/').filter(Boolean).at(-1)}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}K`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/** Inline diff-aware file viewer (same rules as the preview overlay). */
function FileContent({
  path,
  sessionFile,
  onBack,
}: {
  path: string;
  sessionFile: string | null;
  onBack: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [state, setState] = useState<{
    status: 'loading' | 'ok' | 'error';
    content?: string;
    size?: number;
    error?: string;
  }>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void api
      .filePreview(path, sessionFile ?? undefined)
      .then((response) => {
        if (!cancelled) {
          setState({ status: 'ok', content: response.content, size: response.size });
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
  }, [path, sessionFile]);

  return (
    <div className="right-file-view">
      <div className="right-file-view-head mono">
        <button type="button" className="right-file-view-back mono" onClick={onBack}>
          ←
        </button>
        <span className="right-file-view-path" title={path}>
          {path.split('/').filter(Boolean).at(-1)}
        </span>
        {state.size !== undefined ? (
          <span className="right-file-view-meta">{formatSize(state.size)}</span>
        ) : null}
      </div>
      {state.status === 'loading' ? (
        <p className="right-files-hint mono">{t('settings.loading')}</p>
      ) : state.status === 'error' ? (
        <p className="right-files-error mono" role="alert">
          {state.error}
        </p>
      ) : looksLikeDiff(state.content ?? '') ? (
        <DiffView content={state.content ?? ''} />
      ) : (
        <pre className="right-file-view-code mono">{state.content}</pre>
      )}
    </div>
  );
}
