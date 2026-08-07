import { useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { DiffView } from './DiffView.js';

/** P1-03 C: true when the content looks like a unified diff. */
function looksLikeDiff(content: string): boolean {
  return (
    content.includes('diff --git') ||
    (content.includes('@@') && content.includes('--- ') && content.includes('+++ '))
  );
}
import './FilePreview.css';

/** P1-03 B: read-only file preview overlay. */
export function FilePreview({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [state, setState] = useState<{
    status: 'loading' | 'ok' | 'error';
    content?: string;
    size?: number;
    error?: string;
  }>({ status: 'loading' });

  useMemo(() => {
    let cancelled = false;
    void api
      .filePreview(path)
      .then((response) => {
        if (!cancelled) {
          setState({ status: 'ok', content: response.content, size: response.size });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className="file-preview-overlay" role="dialog" aria-label={t('chat.filePreview')}>
      <div className="file-preview">
        <div className="file-preview-head mono">
          <span className="file-preview-path" title={path}>
            {path}
          </span>
          {state.size !== undefined ? (
            <span className="file-preview-meta">{`${String(state.size)} B`}</span>
          ) : null}
          <button
            type="button"
            className="file-preview-close mono"
            aria-label={t('chat.cancelEdit')}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="file-preview-body">
          {state.status === 'loading' ? (
            <p className="file-preview-hint mono">{t('settings.loading')}</p>
          ) : state.status === 'error' ? (
            <p className="file-preview-error mono" role="alert">
              {state.error}
            </p>
          ) : looksLikeDiff(state.content ?? '') ? (
            <DiffView content={state.content ?? ''} />
          ) : (
            <pre className="file-preview-code mono">{state.content}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
