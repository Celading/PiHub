import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { SettingsSectionId, Theme, View } from '../types/app';
import type { SessionStatus } from '../chat/sessionWatch.js';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { RightSidebar } from './RightSidebar';
import './AppShell.css';

const SIDEBAR_WIDTH_KEY = 'pi-panel:sidebar-width';
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 272;
const RESIZER_WIDTH = 6;
const RIGHT_WIDTH_KEY = 'pi-panel:right-sidebar-width';
const RIGHT_MODE_KEY = 'pi-panel:right-sidebar-mode';
const RIGHT_MIN = 220;
const RIGHT_MAX = 560;
const RIGHT_DEFAULT = 300;

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
  /** P1-06: session changed under the chat workspace (see Sidebar). */
  onSessionChanged: (fileName?: string | null, label?: string) => void;
  onThemeToggle: () => void;
  /** Active agent (pi RPC, codex exec, or the embedded dsh kernel) — the
   *  right sidebar tree tab is pi-only. */
  agent: 'pi' | 'codex' | 'dsh' | 'claude';
  /** Right panel open state — owned by App so the TabBar toggle shares it. */
  rightOpen: boolean;
  onToggleRight: () => void;
  /** Open a codex record in the codex chat (from the sidebar). */
  onOpenCodexSession: (threadId: string, label: string) => void;
  /** Open a claude transcript read-only (from the sidebar). */
  onOpenClaudeSession: (sessionId: string, label: string) => void;
  /** Open a dsh session in the dsh chat (switch agent + fresh tab). */
  onOpenDshSession: (sessionId: string, label: string) => void;
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

function loadRightWidth(): number {
  try {
    const raw = localStorage.getItem(RIGHT_WIDTH_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, parsed));
      }
    }
  } catch {
    // storage unavailable — keep default
  }
  return RIGHT_DEFAULT;
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
  agent,
  rightOpen,
  onToggleRight,
  onOpenCodexSession,
  onOpenClaudeSession,
  onOpenDshSession,
  children,
}: AppShellProps): React.JSX.Element {
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => loadSidebarWidth());
  const [rightWidth, setRightWidth] = useState<number>(() => loadRightWidth());
  // P1-08d: docked (edge-attached with the grid resizer) or floating
  // (top-right card). Persisted so the choice survives reloads.
  const [rightMode, setRightMode] = useState<'docked' | 'float'>(() => {
    try {
      return localStorage.getItem(RIGHT_MODE_KEY) === 'float' ? 'float' : 'docked';
    } catch {
      return 'docked';
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches,
  );
  const [isCompact, setIsCompact] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 1024px)').matches,
  );

  useEffect(() => {
    const mobileMedia = window.matchMedia('(max-width: 760px)');
    const compactMedia = window.matchMedia('(max-width: 1024px)');
    const onMobileChange = (event: MediaQueryListEvent): void => {
      setIsMobile(event.matches);
      if (!event.matches) {
        setMobileOpen(false);
      }
    };
    const onCompactChange = (event: MediaQueryListEvent): void => {
      setIsCompact(event.matches);
    };
    mobileMedia.addEventListener('change', onMobileChange);
    compactMedia.addEventListener('change', onCompactChange);
    return () => {
      mobileMedia.removeEventListener('change', onMobileChange);
      compactMedia.removeEventListener('change', onCompactChange);
    };
  }, []);

  // The mobile drawer is a real keyboard surface, not only a visual slide-in.
  // Keep focus inside it and provide the expected Escape dismissal path.
  useEffect(() => {
    if (!isMobile || !mobileOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const drawer = document.querySelector<HTMLElement>('.shell-sidebar[data-mobile-open="true"]');
      if (drawer === null) {
        return;
      }
      const focusable = Array.from(
        drawer.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex]:not([tabindex="-1"])'),
      ).filter((element) => !element.hasAttribute('disabled') && element.getClientRects().length > 0);
      if (focusable.length === 0) {
        return;
      }
      const active = document.activeElement;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!drawer.contains(active)) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isMobile, mobileOpen]);

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

  useEffect(() => {
    try {
      localStorage.setItem(RIGHT_WIDTH_KEY, String(rightWidth));
    } catch {
      // storage unavailable
    }
  }, [rightWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(RIGHT_MODE_KEY, rightMode);
    } catch {
      // storage unavailable
    }
  }, [rightMode]);

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

  // Right panel resizer: dragging left shrinks the panel.
  const startRightResize = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightWidth;
    const onMove = (moveEvent: MouseEvent): void => {
      const next = Math.min(
        RIGHT_MAX,
        Math.max(RIGHT_MIN, startWidth + (startX - moveEvent.clientX)),
      );
      setRightWidth(next);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [rightWidth]);

  const onSidebarResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    setSidebarWidth((current) =>
      Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, current + (event.key === 'ArrowRight' ? 16 : -16))),
    );
  }, []);

  const onRightResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    setRightWidth((current) =>
      Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, current + (event.key === 'ArrowLeft' ? 16 : -16))),
    );
  }, []);

  const sidebarCol = sidebarCollapsed ? '2rem' : `${String(sidebarWidth)}px`;
  // Settings is a dedicated management workspace. Keep the user's right
  // workbench preference intact, but do not render or reserve chat-context
  // Files/Changes/Tree chrome while settings is active.
  const rightVisible = rightOpen && view !== 'settings';
  const docked = rightVisible && rightMode === 'docked' && !isCompact;
  const rightCol = docked ? `${String(rightWidth)}px` : '0px';

  return (
    <div
      className="shell"
      data-right-mode={rightMode}
      style={
        isMobile
          ? undefined
          : {
              gridTemplateColumns: `${sidebarCol} ${String(RESIZER_WIDTH)}px minmax(0, 1fr) ${String(RESIZER_WIDTH)}px ${rightCol}`,
            }
      }
    >
      <Header
        theme={theme}
        onThemeToggle={onThemeToggle}
        onMenuClick={() => {
          setMobileOpen(true);
        }}
        mobileMenuOpen={mobileOpen}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={onToggleCollapsed}
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
      <div
        id="pihub-primary-nav"
        className="shell-sidebar"
        data-mobile-open={isMobile && mobileOpen}
        role={isMobile && mobileOpen ? 'dialog' : undefined}
        aria-modal={isMobile && mobileOpen ? true : undefined}
        aria-label={isMobile && mobileOpen ? '主导航' : undefined}
      >
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
          onOpenCodexSession={onOpenCodexSession}
          onOpenClaudeSession={onOpenClaudeSession}
          onOpenDshSession={onOpenDshSession}
        />
      </div>
      <div
        className="shell-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={Math.round(sidebarWidth)}
        tabIndex={isMobile ? -1 : 0}
        onMouseDown={startResize}
        onKeyDown={onSidebarResizeKeyDown}
        data-collapsed={sidebarCollapsed}
        data-mobile={isMobile}
      />
      <main className="shell-main scroll-area">{children}</main>
      <div
        className="shell-resizer shell-resizer-right"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize right panel"
        aria-valuemin={RIGHT_MIN}
        aria-valuemax={RIGHT_MAX}
        aria-valuenow={Math.round(rightWidth)}
        tabIndex={isMobile || !docked ? -1 : 0}
        onMouseDown={startRightResize}
        onKeyDown={onRightResizeKeyDown}
        data-open={docked}
        data-mobile={isMobile}
      />
      {rightVisible && !isMobile ? (
        <RightSidebar
          sessionFile={sessionFile}
          agent={agent}
          mode={isCompact && rightMode === 'docked' ? 'float' : rightMode}
          width={rightWidth}
          onModeChange={(mode) => {
            setRightMode(mode);
          }}
          onResizeStart={startRightResize}
          onClose={onToggleRight}
        />
      ) : null}
    </div>
  );
}
