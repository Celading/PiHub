import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { SettingsSectionId, Theme, View } from '../types/app';
import type { SessionStatus } from '../chat/sessionWatch.js';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import './AppShell.css';

const SIDEBAR_WIDTH_KEY = 'pi-panel:sidebar-width';
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 272;
const RESIZER_WIDTH = 6;

interface AppShellProps {
  view: View;
  theme: Theme;
  settingsSection: SettingsSectionId;
  onSettingsSectionChange: (section: SettingsSectionId) => void;
  sidebarCollapsed: boolean;
  onToggleCollapsed: () => void;
  sessionFile: string | null;
  sessionStatus: SessionStatus;
  /** P1-17 E: agent request pending → active session dot blinks. */
  requestPending: boolean;
  onViewChange: (view: View) => void;
  onSessionChanged: () => void;
  onThemeToggle: () => void;
  children: ReactNode;
}

function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, parsed));
      }
    }
  } catch {
    // storage unavailable — keep default
  }
  return SIDEBAR_DEFAULT;
}

export function AppShell({
  view,
  theme,
  settingsSection,
  onSettingsSectionChange,
  sidebarCollapsed,
  onToggleCollapsed,
  sessionFile,
  sessionStatus,
  requestPending,
  onViewChange,
  onSessionChanged,
  onThemeToggle,
  children,
}: AppShellProps): React.JSX.Element {
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => loadSidebarWidth());
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches,
  );

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const onChange = (event: MediaQueryListEvent): void => {
      setIsMobile(event.matches);
      if (!event.matches) {
        setMobileOpen(false);
      }
    };
    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, []);

  // Close the mobile drawer when the view or the active session changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [view, sessionFile]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      // storage unavailable
    }
  }, [sidebarWidth]);

  // Drag-to-resize: mousemove/mouseup listeners live on the window so the
  // drag keeps tracking outside the resizer strip.
  const startResize = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const onMove = (moveEvent: MouseEvent): void => {
      const next = Math.min(
        SIDEBAR_MAX,
        Math.max(SIDEBAR_MIN, startWidth + (moveEvent.clientX - startX)),
      );
      setSidebarWidth(next);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarWidth]);

  const sidebarCol = sidebarCollapsed ? '2rem' : `${String(sidebarWidth)}px`;

  return (
    <div
      className="shell"
      style={
        isMobile
          ? undefined
          : { gridTemplateColumns: `${sidebarCol} ${String(RESIZER_WIDTH)}px minmax(0, 1fr)` }
      }
    >
      <Header
        theme={theme}
        onThemeToggle={onThemeToggle}
        onMenuClick={() => {
          setMobileOpen(true);
        }}
      />
      {isMobile && mobileOpen ? (
        <div
          className="shell-mobile-overlay"
          role="presentation"
          onClick={() => {
            setMobileOpen(false);
          }}
        />
      ) : null}
      <div className="shell-sidebar" data-mobile-open={isMobile && mobileOpen}>
        <Sidebar
          view={view}
          mode={view === 'settings' ? 'settings' : 'primary'}
          settingsSection={settingsSection}
          onSettingsSectionChange={onSettingsSectionChange}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={onToggleCollapsed}
          sessionFile={sessionFile}
          sessionStatus={sessionStatus}
          requestPending={requestPending}
          onViewChange={onViewChange}
          onSessionChanged={onSessionChanged}
        />
      </div>
      <div
        className="shell-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onMouseDown={startResize}
        data-collapsed={sidebarCollapsed}
        data-mobile={isMobile}
      />
      <main className="shell-main scroll-area">{children}</main>
    </div>
  );
}
