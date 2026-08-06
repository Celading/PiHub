import { useEffect, useMemo, useState } from 'react';
import type { PiCommand } from '../../shared/types.js';
import { api } from '../api/client.js';
import { useI18n, type MessageKey } from '../i18n/I18nProvider.js';
import { LoadingHint } from './LoadingHint.js';
import './CommandPalette.css';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onRun: (commandName: string) => void;
}

const SOURCE_LABEL: Record<PiCommand['source'], MessageKey> = {
  extension: 'palette.source.extension',
  prompt: 'palette.source.prompt',
  skill: 'palette.source.skill',
};

const SOURCE_ORDER: ReadonlyArray<PiCommand['source']> = ['skill', 'prompt', 'extension'];

export function CommandPalette({ open, onClose, onRun }: CommandPaletteProps): React.JSX.Element | null {
  const { t } = useI18n();
  const [commands, setCommands] = useState<PiCommand[] | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const list = await api.commands();
        if (!cancelled) {
          setCommands(list);
        }
      } catch {
        if (!cancelled) {
          setCommands([]);
        }
      }
    };
    void load();
    setQuery('');
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  const grouped = useMemo(() => {
    if (commands === null) {
      return null;
    }
    const needle = query.trim().toLowerCase();
    const filtered =
      needle.length === 0
        ? commands
        : commands.filter((command) => {
            return (
              command.name.toLowerCase().includes(needle) ||
              (command.description ?? '').toLowerCase().includes(needle)
            );
          });
    const groups = new Map<PiCommand['source'], PiCommand[]>();
    for (const source of SOURCE_ORDER) {
      groups.set(source, []);
    }
    for (const command of filtered) {
      const group = groups.get(command.source);
      if (group !== undefined) {
        group.push(command);
      }
    }
    return groups;
  }, [commands, query]);

  if (!open) {
    return null;
  }

  const total = commands === null ? 0 : commands.length;

  return (
    <div className="palette-overlay" role="presentation">
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('palette.title')}>
        <div className="palette-head">
          <span className="palette-title">{t('palette.title')}</span>
          <span className="palette-count mono">
            {commands === null ? (
              <LoadingHint>{t('settings.loading')}</LoadingHint>
            ) : (
              `${String(total)} ${t('palette.commands')}`
            )}
          </span>
        </div>
        <input
          className="palette-search"
          type="search"
          placeholder={t('palette.search')}
          value={query}
          autoFocus
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          aria-label={t('palette.search')}
        />
        <div className="palette-body scroll-area">
          {grouped === null ? (
            <p className="palette-hint">
              <LoadingHint>{t('settings.loading')}</LoadingHint>
            </p>
          ) : total === 0 ? (
            <p className="palette-hint">{t('palette.empty')}</p>
          ) : (
            SOURCE_ORDER.map((source) => {
              const group = grouped.get(source);
              if (group === undefined || group.length === 0) {
                return null;
              }
              return (
                <div key={source} className="palette-group">
                  <div className="palette-group-label mono">{t(SOURCE_LABEL[source])}</div>
                  {group.map((command) => (
                    <button
                      key={`${command.source}:${command.name}`}
                      type="button"
                      className="palette-item"
                      onClick={() => {
                        onRun(command.name);
                      }}
                    >
                      <span className="palette-item-name mono">/{command.name}</span>
                      {command.description !== undefined &&
                      command.description.length > 0 ? (
                        <span className="palette-item-desc">{command.description}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>
        <div className="palette-foot mono">
          <span>{t('palette.hint')}</span>
          <button type="button" className="palette-close" onClick={onClose}>
            {t('palette.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
