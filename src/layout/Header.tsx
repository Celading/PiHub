import { useEffect, useState } from 'react';
import { nextTheme, type Theme } from '../types/app';
import { useServerHealth } from '../hooks/useServerHealth';
import { useI18n } from '../i18n/I18nProvider.js';
import { useMode } from '../kMode/useMode.js';
import { useRuntimeCapabilities } from '../hooks/useRuntimeCapabilities.js';
import './Header.css';

/** Internal build barcode: version+build numeric segments → printable chars
 *  (e.g. 0.3.0.260814.server → " !'&\"…"), title carries the full stamp. */
function buildBarcode(version: string, build: string): string {
  const segments = `${version}.${build}`
    .split('.')
    .map((segment) => {
      const digits = segment.replace(/\D/g, '');
      return digits.length > 0 ? Number(digits) : NaN;
    })
    .filter((value) => Number.isFinite(value));
  return segments.map((value) => String.fromCharCode(0x20 + (value % 0x5e))).join('');
}

/** Frameless-window bridge exposed by the Electron preload (desktop shell). */
interface PihubWindowBridge {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  onMaximizedChange(callback: (maximized: boolean) => void): () => void;
  /** LAN compatibility mode: URL and bootstrap are separate IPC values. */
  openRemote(url: string, bootstrap?: string): void;
  takeRemoteBootstrap(): Promise<string | null>;
}

declare global {
  interface Window {
    pihubWindow?: PihubWindowBridge;
  }
}

interface HeaderProps {
  theme: Theme;
  onThemeToggle: () => void;
  onMenuClick: () => void;
  mobileMenuOpen: boolean;
  /** Sidebar expand/collapse — toggled by clicking the brand logo. */
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

export function Header({
  theme,
  onThemeToggle,
  onMenuClick,
  mobileMenuOpen,
  sidebarCollapsed,
  onToggleSidebar,
}: HeaderProps): React.JSX.Element {
  const serverStatus = useServerHealth();
  const mode = useMode();
  const runtime = useRuntimeCapabilities();
  const { t } = useI18n();
  // Internal build stamp for the header barcode (fetch once, no polling).
  const [buildInfo, setBuildInfo] = useState<{ version: string; build: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/health')
      .then((response) => (response.ok ? (response.json() as Promise<{ version?: string; build?: string }>) : null))
      .then((health) => {
        if (!cancelled && health !== null) {
          setBuildInfo({
            version: health.version ?? '0.0.0',
            build: health.build ?? '',
          });
        }
      })
      .catch(() => {
        // offline — no barcode
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const barcode =
    buildInfo !== null && buildInfo.build.length > 0 ? buildBarcode(buildInfo.version, buildInfo.build) : '';
  const barcodeTitle =
    buildInfo !== null && buildInfo.build.length > 0 ? `v${buildInfo.version}.${buildInfo.build}` : '';

  const targetTheme = nextTheme(theme);
  const themeLabel =
    targetTheme === 'light'
      ? t('header.theme.light')
      : targetTheme === 'dark'
        ? t('header.theme.dark')
        : t('theme.fog');
  const statusKey =
    serverStatus === 'online' ? 'header.status.online' : serverStatus === 'offline' ? 'header.status.offline' : 'header.status.checking';
  const modeLabel =
    mode === 'demo' ? t('kMode.demo') : mode === 'debug' ? t('kMode.debug') : null;
  const piEngine = runtime?.engines.find((entry) => entry.engine === 'pi');
  const engineLabel = piEngine?.ready ? t('header.engine.piReady') : piEngine?.available ? t('header.engine.piStarting') : t('header.engine.piMissing');

  return (
    <header className="header">
      <div className="header-brand">
        <button
          type="button"
          className="header-menu-toggle"
          aria-label={t('header.menu')}
          aria-expanded={mobileMenuOpen}
          aria-controls="pihub-primary-nav"
          onClick={onMenuClick}
        >
          <span aria-hidden="true">☰</span>
        </button>
        {modeLabel !== null ? (
          <span className="header-mode-badge mono" data-mode={mode}>
            {modeLabel}
          </span>
        ) : null}
        <button
          type="button"
          className="header-brand-mark"
          title={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          data-collapsed={sidebarCollapsed}
          onClick={onToggleSidebar}
        >
          <img src="/icons/pihub-icon.svg" alt="" className="header-brand-mark-img" />
        </button>
        <div className="header-brand-text">
          <span className="header-brand-name">{t('brand.name')}</span>
          <span className="header-brand-sub" title={t('brand.tagline')}>
            {t('brand.slogan')}
          </span>
        </div>
      </div>

      <div className="header-actions">
        <span className="header-status-cluster" title={runtime?.debug !== null && runtime?.debug !== undefined ? JSON.stringify(runtime.debug) : undefined}>
          <span className="header-status mono" data-status={serverStatus}>
            <span className="header-status-dot" aria-hidden="true" />
            {t(statusKey)}
          </span>
          <span className="header-engine-status mono" data-status={piEngine?.status ?? 'checking'}>
            {engineLabel}
          </span>
        </span>
        {barcode.length > 0 ? (
          <span className="header-barcode mono" title={barcodeTitle} aria-label={barcodeTitle}>
            {barcode}
          </span>
        ) : null}
        <button
          type="button"
          className="header-theme-toggle"
          onClick={onThemeToggle}
          aria-label={t('header.theme.toggle')}
        >
          {themeLabel}
        </button>
      </div>

    </header>
  );
}
