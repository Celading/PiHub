import { useEffect, useRef } from 'react';
import './ContextMenu.css';

export interface ContextMenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * Lightweight right-click menu: fixed position (never expands its parent),
 * clamped to the viewport, closes on Escape, outside click or scroll.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      const el = menuRef.current;
      if (el !== null && !el.contains(event.target as Node)) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onClose]);

  const menuWidth = 176;
  const itemCount = items.length;
  const itemHeight = 36;
  const height = itemCount * itemHeight + 8;
  const left = Math.max(4, Math.min(x, window.innerWidth - menuWidth - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - height - 4));

  return (
    <div
      ref={menuRef}
      className="context-menu mono"
      role="menu"
      style={{ left: `${String(left)}px`, top: `${String(top)}px`, width: `${String(menuWidth)}px` }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="context-menu-item"
          data-danger={item.danger}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.icon !== undefined ? (
            <span className={`hico ${item.icon}`} aria-hidden="true" />
          ) : null}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
