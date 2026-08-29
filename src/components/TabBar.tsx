import { useI18n } from '../i18n/I18nProvider.js';
import type { ChatTab } from '../chat/tabs.js';
import './TabBar.css';

interface TabBarProps {
  tabs: ReadonlyArray<ChatTab>;
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** Right workbench visibility (toggle shown at the strip's far right). */
  rightOpen: boolean;
  onToggleRight: () => void;
}

/** Top tab strip of the multi-session chat workspace (P1-06). */
export function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  rightOpen,
  onToggleRight,
}: TabBarProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="tabbar" role="tablist" aria-label={t('chat.tabs.list')}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeId}
          className="tabbar-tab"
          data-active={tab.id === activeId}
          title={tab.sessionFile ?? undefined}
          onClick={() => {
            onSelect(tab.id);
          }}
        >
          <span className="tabbar-label mono">{tab.label || t('chat.tabs.new')}</span>
          <button
            type="button"
            className="tabbar-close"
            aria-label={t('chat.tabs.close')}
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="tabbar-new"
        aria-label={t('chat.tabs.newTab')}
        title={t('chat.tabs.newTab')}
        onClick={onNew}
      >
        +
      </button>
      <button
        type="button"
        className="tabbar-right-toggle mono"
        title={rightOpen ? t('rightSidebar.close') : t('rightSidebar.open')}
        data-active={rightOpen}
        onClick={onToggleRight}
      >
        {rightOpen ? '⇱' : '⇲'}
      </button>
    </div>
  );
}
