import { useState } from 'react';
import { useI18n, type MessageKey } from '../i18n/I18nProvider.js';
import { RightFilesPanel } from '../components/RightFilesPanel.js';
import { RightChangesPanel } from '../components/RightChangesPanel.js';
import { RightTreePanel } from '../components/RightTreePanel.js';
import './RightSidebar.css';

/** Right workbench panel tabs: workspace files, git changes, session tree. */
export type RightTabId = 'files' | 'changes' | 'tree';

const RIGHT_TABS: ReadonlyArray<{ id: RightTabId; labelKey: MessageKey }> = [
  { id: 'files', labelKey: 'rightSidebar.files' },
  { id: 'changes', labelKey: 'rightSidebar.changes' },
  { id: 'tree', labelKey: 'rightSidebar.tree' },
];

interface RightSidebarProps {
  /** Active session file — the server resolves the workspace cwd from it. */
  sessionFile: string | null;
  /** Active agent: the tree tab is pi-only (get_tree RPC passthrough). */
  agent: 'pi' | 'codex' | 'dsh' | 'claude';
  /** Docked (edge-attached, grid column + resizer) or floating (top-right). */
  mode: 'docked' | 'float';
  /** Panel width (both modes share the persisted width). */
  width: number;
  onModeChange: (mode: 'docked' | 'float') => void;
  /** Drag-to-resize (docked: the grid resizer; float: the left-edge strip). */
  onResizeStart: (event: React.MouseEvent<HTMLDivElement>) => void;
  onClose: () => void;
}

/**
 * Right workbench sidebar — a three-tab workspace panel (文件 / 变更 /
 * 会话树) bound to the ACTIVE session's cwd. Docked mode attaches to the
 * right edge with a grid resizer; float mode shows a top-right card whose
 * left edge resizes the panel.
 */
export function RightSidebar({
  sessionFile,
  agent,
  mode,
  width,
  onModeChange,
  onResizeStart,
  onClose,
}: RightSidebarProps): React.JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<RightTabId>('files');

  return (
    <aside
      className="right-sidebar"
      data-tab={tab}
      data-mode={mode}
      style={mode === 'float' ? { width: `${String(width)}px` } : undefined}
    >
      {mode === 'float' ? (
        <div
          className="right-sidebar-float-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('rightSidebar.resize')}
          onMouseDown={onResizeStart}
        />
      ) : null}
      <div className="right-sidebar-head">
        <div className="right-sidebar-tabs" role="tablist" aria-label="right panel">
          {RIGHT_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className="right-sidebar-tab mono"
              data-active={tab === item.id}
              onClick={() => {
                setTab(item.id);
              }}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>
        <div className="right-sidebar-head-actions">
          <button
            type="button"
            className="right-sidebar-mode mono"
            title={mode === 'docked' ? t('rightSidebar.float') : t('rightSidebar.dock')}
            onClick={() => {
              onModeChange(mode === 'docked' ? 'float' : 'docked');
            }}
          >
            {mode === 'docked' ? '⇱' : '⇲'}
          </button>
          <button
            type="button"
            className="right-sidebar-close mono"
            aria-label={t('rightSidebar.close')}
            title={t('rightSidebar.close')}
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </div>
      <div className="right-sidebar-body scroll-area" role="tabpanel">
        {tab === 'files' ? <RightFilesPanel sessionFile={sessionFile} /> : null}
        {tab === 'changes' ? <RightChangesPanel sessionFile={sessionFile} /> : null}
        {tab === 'tree' && agent === 'pi' ? <RightTreePanel /> : null}
        {tab === 'tree' && agent !== 'pi' ? (
          <p className="right-sidebar-empty mono">{t('rightSidebar.treePiOnly')}</p>
        ) : null}
      </div>
    </aside>
  );
}
