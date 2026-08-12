import type { Theme } from '../types/app';
import { useServerHealth } from '../hooks/useServerHealth';
import { useI18n } from '../i18n/I18nProvider.js';
import { useMode } from '../kMode/useMode.js';
import './Header.css';

interface HeaderProps {
  theme: Theme;
  onThemeToggle: () => void;
  onMenuClick: () => void;
  /** Active agent (pi RPC or codex exec); switchable from the header. */
  agent: 'pi' | 'codex';
  onAgentChange: (agent: 'pi' | 'codex') => void;
}

export function Header({
  theme,
  onThemeToggle,
  onMenuClick,
  agent,
  onAgentChange,
}: HeaderProps): React.JSX.Element {
  const serverStatus = useServerHealth();
  const mode = useMode();
  const { t } = useI18n();

  const statusKey =
    serverStatus === 'online' ? 'header.status.online' : serverStatus === 'offline' ? 'header.status.offline' : 'header.status.checking';
  const modeLabel =
    mode === 'demo' ? t('kMode.demo') : mode === 'debug' ? t('kMode.debug') : null;

  return (
    <header className="header">
      <div className="header-brand">
        <button
          type="button"
          className="header-menu-toggle"
          aria-label={t('header.menu')}
          onClick={onMenuClick}
        >
          <span aria-hidden="true">☰</span>
        </button>
        {modeLabel !== null ? (
          <span className="header-mode-badge mono" data-mode={mode}>
            {modeLabel}
          </span>
        ) : null}
        <span className="header-brand-mark" aria-hidden="true">
          <img src="/icons/pihub-icon.svg" alt="" className="header-brand-mark-img" />
        </span>
        <div className="header-agent-switch" role="group" aria-label={t('header.agent')}>
          <button
            type="button"
            className="header-agent-btn mono"
            data-active={agent === 'pi'}
            data-agent="pi"
            onClick={() => {
              onAgentChange('pi');
            }}
          >
            π
          </button>
          <button
            type="button"
            className="header-agent-btn mono"
            data-active={agent === 'codex'}
            data-agent="codex"
            title="Codex"
            aria-label="Codex"
            onClick={() => {
              onAgentChange('codex');
            }}
          >
            ⌘
          </button>
        </div>
        <div className="header-brand-text">
          <span className="header-brand-name">{t('brand.name')}</span>
          <span className="header-brand-sub" title={t('brand.tagline')}>
            {t('brand.slogan')}
          </span>
        </div>
      </div>

      <div className="header-actions">
        <span className="header-status mono" data-status={serverStatus}>
          <span className="header-status-dot" aria-hidden="true" />
          {t(statusKey)}
        </span>
        <button
          type="button"
          className="header-theme-toggle"
          onClick={onThemeToggle}
          aria-label={t('header.theme.toggle')}
        >
          {theme === 'light' ? t('header.theme.dark') : t('header.theme.light')}
        </button>
      </div>
    </header>
  );
}
