import type { Theme } from '../types/app';
import { useServerHealth } from '../hooks/useServerHealth';
import { useI18n } from '../i18n/I18nProvider.js';
import './Header.css';

interface HeaderProps {
  theme: Theme;
  onThemeToggle: () => void;
}

export function Header({ theme, onThemeToggle }: HeaderProps): React.JSX.Element {
  const serverStatus = useServerHealth();
  const { t } = useI18n();

  const statusKey =
    serverStatus === 'online' ? 'header.status.online' : serverStatus === 'offline' ? 'header.status.offline' : 'header.status.checking';

  return (
    <header className="header">
      <div className="header-brand">
        <span className="header-brand-mark" aria-hidden="true">
          π
        </span>
        <div className="header-brand-text">
          <span className="header-brand-name">{t('brand.name')}</span>
          <span className="header-brand-sub mono">{t('brand.tagline')}</span>
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
