import { useEffect, useRef, useState } from 'react';
import './IconButton.css';

interface IconButtonProps {
  /** HMSymbols glyph class (e.g. "hico-plus"). */
  icon: string;
  /** Accessible label; also used as the tooltip title. */
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Tooltip placement: above or below the button. */
  placement?: 'top' | 'bottom';
  className?: string;
}

const LONG_PRESS_MS = 450;

/**
 * Single-icon button with a long-press (or hover) tooltip. The tooltip is
 * rendered with position:fixed so it can overflow its parent without
 * expanding the container layout.
 */
export function IconButton({
  icon,
  label,
  onClick,
  disabled = false,
  placement = 'top',
  className,
}: IconButtonProps): React.JSX.Element {
  const [tooltip, setTooltip] = useState(false);
  const pressTimer = useRef<number | undefined>(undefined);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const hideTooltip = (): void => {
    if (pressTimer.current !== undefined) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = undefined;
    }
    setTooltip(false);
  };

  const handlePointerDown = (): void => {
    if (disabled) {
      return;
    }
    pressTimer.current = window.setTimeout(() => {
      setTooltip(true);
    }, LONG_PRESS_MS);
  };

  const handlePointerEnter = (): void => {
    if (disabled) {
      return;
    }
    setTooltip(true);
  };

  // Keep the tooltip glued to the button when the page scrolls/resizes.
  useEffect(() => {
    if (!tooltip) {
      return;
    }
    const position = (): void => {
      const button = buttonRef.current;
      const tooltipEl = tooltipRef.current;
      if (button === null || tooltipEl === null) {
        return;
      }
      const rect = button.getBoundingClientRect();
      const tooltipRect = tooltipEl.getBoundingClientRect();
      const gap = 6;
      let top: number;
      if (placement === 'top') {
        top = rect.top - tooltipRect.height - gap;
      } else {
        top = rect.bottom + gap;
      }
      let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
      // Clamp to viewport so the tooltip never overflows the screen.
      left = Math.max(4, Math.min(left, window.innerWidth - tooltipRect.width - 4));
      tooltipEl.style.top = `${String(Math.max(4, top))}px`;
      tooltipEl.style.left = `${String(left)}px`;
      tooltipEl.style.visibility = 'visible';
      tooltipEl.style.opacity = '1';
    };
    position();
    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    return () => {
      window.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
    };
  }, [tooltip, placement]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`icon-button${className === undefined ? '' : ` ${className}`}`}
        disabled={disabled}
        aria-label={label}
        onClick={onClick}
        onPointerDown={handlePointerDown}
        onPointerUp={hideTooltip}
        onPointerLeave={hideTooltip}
        onPointerEnter={handlePointerEnter}
        onFocus={handlePointerEnter}
        onBlur={hideTooltip}
      >
        <span className={`hico ${icon}`} aria-hidden="true" />
      </button>
      {tooltip ? (
        <div ref={tooltipRef} className="icon-tooltip mono" role="tooltip">
          {label}
        </div>
      ) : null}
    </>
  );
}
