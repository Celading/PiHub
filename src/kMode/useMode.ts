import { useEffect, useState } from 'react';

export type PanelMode = 'production' | 'debug' | 'demo';

/**
 * kMode frontend awareness (KMODE-001 K5): read-only mode badge. The panel
 * never branches behavior on mode — the backend keeps the API contract
 * identical across modes.
 */
export function useMode(): PanelMode {
  const [mode, setMode] = useState<PanelMode>('production');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/mode');
        const body = (await response.json()) as { mode?: PanelMode };
        if (
          !cancelled &&
          body.mode !== undefined &&
          (body.mode === 'production' || body.mode === 'debug' || body.mode === 'demo')
        ) {
          setMode(body.mode);
        }
      } catch {
        // backend offline; stay on the production default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return mode;
}
