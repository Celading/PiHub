import type { View } from '../types/app';
import { VIEW_LABELS } from '../types/app';
import './Sidebar.css';

interface SidebarProps {
  view: View;
  onViewChange: (view: View) => void;
}

const NAV_ITEMS: readonly View[] = ['chat', 'sessions', 'stats', 'settings'];

const NAV_NUMBER: Record<View, string> = {
  chat: '01',
  sessions: '02',
  stats: '03',
  settings: '04',
};

export function Sidebar({ view, onViewChange }: SidebarProps): React.JSX.Element {
  return (
    <nav className="sidebar" aria-label="Primary">
      <div className="sidebar-section-label swiss-section-label">pi agent</div>
      <ul className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <li key={item}>
            <button
              type="button"
              className="sidebar-nav-item"
              data-active={view === item}
              onClick={() => {
                onViewChange(item);
              }}
              aria-current={view === item ? 'page' : undefined}
            >
              <span className="sidebar-nav-number mono">{NAV_NUMBER[item]}</span>
              <span>{VIEW_LABELS[item]}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="sidebar-footer mono">~/.pi/agent</div>
    </nav>
  );
}
