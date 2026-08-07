import { useEffect, useState } from 'react';

export type PanelMode = 'production' | 'debug' | 'demo';

const PANEL_MODES: readonly PanelMode[] = ['production', 'debug', 'demo'];

/**
 * kMode frontend awareness (KMODE-001 K5): read-only mode badge. The panel
 * never branches behavior on mode — the backend keeps the API contract
 * identical across modes.
 */
export function useMode(): PanelMode {
  const [mode, setMode] = useState<PanelMode>('production');

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch('/api/mode');
        const body = (await response.json()) as { mode?: PanelMode };
        if (!cancelled && body.mode !== undefined && PANEL_MODES.includes(body.mode)) {
          setMode(body.mode);
        }
      } catch {
        // backend offline; stay on the production default
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return mode;
}
