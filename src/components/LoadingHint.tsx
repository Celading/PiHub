import type { ReactNode } from 'react';

/**
 * Loading hint: spinner + text. The spinner was previously defined but never
 * used (visual audit C-1); this is the single entry point for loading states.
 */
export function LoadingHint({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="loading-hint">
      <span className="spinner" aria-hidden="true" />
      {children}
    </span>
  );
}
