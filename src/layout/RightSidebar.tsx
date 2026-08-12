import { useState } from 'react';
import { useI18n, type MessageKey } from '../i18n/I18nProvider.js';
import { RightFilesPanel } from '../components/RightFilesPanel.js';
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
  agent: 'pi' | 'codex';
  onClose: () => void;
}

/**
 * Right workbench sidebar — a three-tab workspace panel (文件 / 变更 /
 * 会话树) bound to the ACTIVE session's cwd. Panels fill in A2–A4.
 */
export function RightSidebar({
  sessionFile,
  agent,
  onClose,
}: RightSidebarProps): React.JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<RightTabId>('files');

  return (
    <aside className="right-sidebar" data-tab={tab}>
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
      <div className="right-sidebar-body scroll-area" role="tabpanel">
        {tab === 'files' && sessionFile !== null ? <RightFilesPanel sessionFile={sessionFile} /> : null}
        {tab === 'files' && sessionFile === null ? (
          <p className="right-sidebar-empty mono">{t('rightSidebar.noSession')}</p>
        ) : null}
        {tab === 'changes' ? (
          <p className="right-sidebar-empty mono">{t('rightSidebar.comingSoon')}</p>
        ) : null}
        {tab === 'tree' && agent === 'pi' ? (
          <p className="right-sidebar-empty mono">{t('rightSidebar.comingSoon')}</p>
        ) : null}
        {tab === 'tree' && agent !== 'pi' ? (
          <p className="right-sidebar-empty mono">{t('rightSidebar.treePiOnly')}</p>
        ) : null}
      </div>
    </aside>
  );
}
