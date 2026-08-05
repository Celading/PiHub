import type { ReactNode } from 'react';
import type { Theme, View } from '../types/app';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import './AppShell.css';

interface AppShellProps {
  view: View;
  theme: Theme;
  onViewChange: (view: View) => void;
  onThemeToggle: () => void;
  children: ReactNode;
}

export function AppShell({
  view,
  theme,
  onViewChange,
  onThemeToggle,
  children,
}: AppShellProps): React.JSX.Element {
  return (
    <div className="shell">
      <Header theme={theme} onThemeToggle={onThemeToggle} />
      <Sidebar view={view} onViewChange={onViewChange} />
      <main className="shell-main scroll-area">{children}</main>
    </div>
  );
}
