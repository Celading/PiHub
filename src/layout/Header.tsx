import type { Theme } from '../types/app';
import { useServerHealth } from '../hooks/useServerHealth';
import './Header.css';

interface HeaderProps {
  theme: Theme;
  onThemeToggle: () => void;
}

const STATUS_LABEL: Record<'checking' | 'online' | 'offline', string> = {
  checking: 'connecting',
  online: 'server online',
  offline: 'server offline',
};

export function Header({ theme, onThemeToggle }: HeaderProps): React.JSX.Element {
  const serverStatus = useServerHealth();

  return (
    <header className="header">
      <div className="header-brand">
        <span className="header-brand-mark" aria-hidden="true">
          pi
        </span>
        <div className="header-brand-text">
          <span className="header-brand-name">pi panel</span>
          <span className="header-brand-sub mono">pi.dev agent console</span>
        </div>
      </div>

      <div className="header-actions">
        <span className="header-status mono" data-status={serverStatus}>
          <span className="header-status-dot" aria-hidden="true" />
          {STATUS_LABEL[serverStatus]}
        </span>
        <button
          type="button"
          className="header-theme-toggle"
          onClick={onThemeToggle}
          aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
        >
          {theme === 'light' ? 'dark' : 'light'}
        </button>
      </div>
    </header>
  );
}
