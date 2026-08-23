import { useEffect, useState } from 'react';
import { api, type RuntimeCapabilitiesResponse } from '../api/client.js';

const POLL_INTERVAL_MS = 5000;

/** Read-only capability probe shared by the header and session gate. */
export function useRuntimeCapabilities(): RuntimeCapabilitiesResponse | null {
  const [capabilities, setCapabilities] = useState<RuntimeCapabilitiesResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const value = await api.runtimeCapabilities();
        if (!cancelled) {
          setCapabilities(value);
        }
      } catch {
        // The server health dot remains the primary offline signal.
      }
    };
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return capabilities;
}
