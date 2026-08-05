import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

/** Semantic traffic-light status of the current RPC session:
 *  green = settled/done, red = interrupted, cyan = running,
 *  yellow = blocked waiting on a permission request (no live source yet —
 *  reserved; see receipt non-claims). */
export type SessionStatus = 'done' | 'running' | 'aborted' | 'pending';

export interface SessionWatch {
  /** fileName of the current RPC session (matches SessionSummary.fileName). */
  sessionFile: string | null;
  status: SessionStatus;
}

const POLL_MS = 4000;

/**
 * App-level watch over the current RPC session: polls rpc state and listens
 * to the SSE stream so the sidebar can highlight the active session and show
 * its traffic light. The abort marker is set via a custom event dispatched
 * by the chat page when the user interrupts a run.
 */
export function useSessionWatch(): SessionWatch {
  const [sessionFile, setSessionFile] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [aborted, setAborted] = useState(false);
  const pollTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const state = await api.rpcState();
        if (cancelled) {
          return;
        }
        const file = state.sessionFile;
        setSessionFile(typeof file === 'string' && file.length > 0 ? file : null);
        if (!state.isStreaming) {
          setRunning(false);
        }
      } catch {
        // offline; keep previous state
      }
    };

    void poll();
    pollTimer.current = window.setInterval(() => {
      void poll();
    }, POLL_MS);

    const source = new EventSource('/api/events');
    const onPiEvent = (event: MessageEvent<string>): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return;
      }
      const type = (parsed as Record<string, unknown>)['type'];
      if (type === 'agent_start') {
        setRunning(true);
        setAborted(false);
      } else if (type === 'agent_end' || type === 'agent_settled') {
        setRunning(false);
      }
    };
    source.addEventListener('pi', onPiEvent);

    const onAborted = (): void => {
      setAborted(true);
    };
    window.addEventListener('pihub:run-aborted', onAborted);

    return () => {
      cancelled = true;
      if (pollTimer.current !== undefined) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = undefined;
      }
      source.close();
      window.removeEventListener('pihub:run-aborted', onAborted);
    };
  }, []);

  const status: SessionStatus = running ? 'running' : aborted ? 'aborted' : 'done';

  return { sessionFile, status };
}
