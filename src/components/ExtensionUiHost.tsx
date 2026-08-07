import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ExtensionUiRequest } from '../../shared/types.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import type { ExtensionUiState } from '../extui/useExtensionUi.js';
import './ExtensionUiHost.css';

function SelectDialog({
  request,
  onAnswer,
}: {
  request: Extract<ExtensionUiRequest, { method: 'select' }>;
  onAnswer: (value: string | null) => void;
}): ReactNode {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const options = useMemo(
    () => request.options.filter((option) => option.toLowerCase().includes(query.toLowerCase())),
    [request.options, query],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onAnswer(null);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelected((prev) => Math.min(prev + 1, options.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected((prev) => Math.max(prev - 1, 0));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const option = options[selected];
        if (option !== undefined) {
          onAnswer(option);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [options, selected, onAnswer]);

  return (
    <div className="confirm-overlay" role="presentation">
      <div className="extui-dialog" role="dialog" aria-modal="true" aria-label={request.title}>
        <div className="extui-dialog-title mono">{request.title}</div>
        {typeof request.timeout === 'number' ? (
          <div className="extui-timeout-hint mono">{t('extui.timeoutHint')}</div>
        ) : null}
        <input
          className="extui-search"
          type="search"
          value={query}
          autoFocus
          placeholder={t('extui.selectPlaceholder')}
          aria-label={t('extui.selectPlaceholder')}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
        />
        <div className="extui-options scroll-area">
          {options.length === 0 ? (
            <div className="extui-empty mono">{t('extui.selectEmpty')}</div>
          ) : (
            options.map((option, index) => (
              <button
                key={option}
                type="button"
                className="extui-option mono"
                data-active={index === selected}
                onClick={() => {
                  onAnswer(option);
                }}
                onMouseEnter={() => {
                  setSelected(index);
                }}
              >
                {option}
              </button>
            ))
          )}
        </div>
        <div className="confirm-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              onAnswer(null);
            }}
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

function InputDialog({
  request,
  onAnswer,
}: {
  request: Extract<ExtensionUiRequest, { method: 'input' }>;
  onAnswer: (value: string | null) => void;
}): ReactNode {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  return (
    <div className="confirm-overlay" role="presentation">
      <div className="extui-dialog" role="dialog" aria-modal="true" aria-label={request.title}>
        <div className="extui-dialog-title mono">{request.title}</div>
        {typeof request.timeout === 'number' ? (
          <div className="extui-timeout-hint mono">{t('extui.timeoutHint')}</div>
        ) : null}
        <input
          className="extui-input mono"
          value={value}
          autoFocus
          placeholder={request.placeholder ?? t('extui.inputPlaceholder')}
          aria-label={request.placeholder ?? t('extui.inputPlaceholder')}
          onChange={(event) => {
            setValue(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              onAnswer(value);
            }
            if (event.key === 'Escape') {
              onAnswer(null);
            }
          }}
        />
        <div className="confirm-actions">
          <button type="button" className="btn-secondary" onClick={() => { onAnswer(null); }}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              onAnswer(value);
            }}
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditorDialog({
  request,
  onAnswer,
}: {
  request: Extract<ExtensionUiRequest, { method: 'editor' }>;
  onAnswer: (value: string | null) => void;
}): ReactNode {
  const { t } = useI18n();
  const [value, setValue] = useState(request.prefill ?? '');
  return (
    <div className="confirm-overlay" role="presentation">
      <div className="extui-editor" role="dialog" aria-modal="true" aria-label={request.title}>
        <div className="extui-dialog-title mono">{request.title}</div>
        <textarea
          className="extui-editor-text mono"
          value={value}
          autoFocus
          placeholder={t('extui.editorPlaceholder')}
          aria-label={t('extui.editorPlaceholder')}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
        <div className="confirm-actions">
          <button type="button" className="btn-secondary" onClick={() => { onAnswer(null); }}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              onAnswer(value);
            }}
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Renders all extension UI surfaces (P1-01): dialog requests, toasts,
 * status bar, and widget slots.
 */
export function ExtensionUiHost({ ui }: { ui: ExtensionUiState }): ReactNode {
  const { t } = useI18n();
  const dialog = ui.dialogs[0];

  let dialogNode: ReactNode = null;
  if (dialog !== undefined) {
    const answer = (value: string | null): void => {
      if (value === null) {
        void ui.respond({ id: dialog.id, cancelled: true });
      } else if (dialog.method === 'confirm') {
        void ui.respond({ id: dialog.id, confirmed: value === 'yes' });
      } else {
        void ui.respond({ id: dialog.id, value });
      }
    };
    if (dialog.method === 'select') {
      dialogNode = <SelectDialog request={dialog} onAnswer={answer} />;
    } else if (dialog.method === 'input') {
      dialogNode = <InputDialog request={dialog} onAnswer={answer} />;
    } else if (dialog.method === 'editor') {
      dialogNode = <EditorDialog request={dialog} onAnswer={answer} />;
    } else if (dialog.method === 'confirm') {
      dialogNode = (
        <ConfirmDialog
          title={dialog.title}
          message={dialog.message}
          danger={false}
          confirmLabel={t('common.confirm')}
          onConfirm={() => {
            void ui.respond({ id: dialog.id, confirmed: true });
          }}
          onCancel={() => {
            void ui.respond({ id: dialog.id, confirmed: false });
          }}
        />
      );
    }
  }

  return (
    <>
      {dialogNode}
      {ui.statusBar !== null ? (
        <div className="extui-statusbar mono" role="status">
          <span className="hico hico-bolt" aria-hidden="true" />
          {ui.statusBar.text}
        </div>
      ) : null}
      {ui.widgets.map((widget) => (
        <div key={widget.key} className="extui-widget mono" role="status">
          {widget.lines.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      ))}
      <div className="extui-toasts" aria-live="polite">
        {ui.toasts.map((toast) => (
          <div key={toast.id} className="extui-toast mono" data-type={toast.notifyType} role="status">
            {toast.message}
          </div>
        ))}
      </div>
    </>
  );
}
