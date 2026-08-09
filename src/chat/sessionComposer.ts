import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { eventsUrl } from '../api/controlToken.js';

interface SessionComposerState {
  isRunning: boolean;
  error: string | null;
  sendPrompt: (text: string) => Promise<void>;
  sendSteer: (text: string) => Promise<void>;
  abort: () => Promise<void>;
}

/**
 * Composer actions for a resumed historical session: switches the RPC
 * subprocess to the session file, sends prompts, and refreshes the detail
 * view when the agent settles (driven by the SSE event stream).
 */
export function useSessionComposer(
  sessionPath: string,
  onSettled: () => void,
): SessionComposerState {
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onSettledRef = useRef(onSettled);

  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  useEffect(() => {
    const source = new EventSource(eventsUrl());
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
      const record = parsed as Record<string, unknown>;
      if (record['type'] === 'agent_start') {
        setIsRunning(true);
      } else if (record['type'] === 'agent_end' || record['type'] === 'agent_settled') {
        setIsRunning(false);
        onSettledRef.current();
      }
    };
    source.addEventListener('pi', onPiEvent);
    return () => {
      source.close();
    };
  }, []);

  const switchAndSend = useCallback(
    async (send: () => Promise<unknown>): Promise<void> => {
      try {
        const switched = await api.switchSession(sessionPath);
        if (!switched.success) {
          setError(switched.error ?? 'failed to open session');
          return;
        }
        await send();
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionPath],
  );

  const sendPrompt = useCallback(
    async (text: string): Promise<void> => {
      await switchAndSend(() => api.prompt(text));
    },
    [switchAndSend],
  );

  const sendSteer = useCallback(
    async (text: string): Promise<void> => {
      await switchAndSend(() => api.steer(text));
    },
    [switchAndSend],
  );

  const abort = useCallback(async (): Promise<void> => {
    try {
      await api.abort();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return { isRunning, error, sendPrompt, sendSteer, abort };
}
