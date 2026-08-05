import { useEffect, useState } from 'react';

export type ServerStatus = 'checking' | 'online' | 'offline';

const POLL_INTERVAL_MS = 5000;

/** Polls the backend /api/health endpoint. */
export function useServerHealth(): ServerStatus {
  const [status, setStatus] = useState<ServerStatus>('checking');

  useEffect(() => {
    let cancelled = false;

    const check = async (): Promise<void> => {
      try {
        const response = await fetch('/api/health');
        if (!cancelled) {
          setStatus(response.ok ? 'online' : 'offline');
        }
      } catch {
        if (!cancelled) {
          setStatus('offline');
        }
      }
    };

    void check();
    const timer = window.setInterval(() => {
      void check();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return status;
}
