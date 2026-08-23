import { useCallback, useEffect, useState } from 'react';
import type { Pipeline, PipelineRunRecord } from '../../shared/types.js';
import { api } from '../api/client.js';
import { eventsUrl } from '../api/controlToken.js';

const ACTIVE_RUN_STATUSES: readonly string[] = ['running', 'idle', 'awaiting-approval'];

/** Runs shown in the run view: active first, then the latest finished. */
export function selectVisibleRuns(runs: PipelineRunRecord[]): PipelineRunRecord[] {
  const active = runs.filter((r) => ACTIVE_RUN_STATUSES.includes(r.status));
  const finished = runs
    .filter((r) => !ACTIVE_RUN_STATUSES.includes(r.status))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 3);
  return [...active.sort((a, b) => b.startedAt - a.startedAt), ...finished];
}

/** Shape guard for SSE pipeline_step snapshots (untrusted event data). */
function isPipelineRunRecord(value: unknown): value is PipelineRunRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['runId'] === 'string' &&
    typeof record['pipelineId'] === 'string' &&
    typeof record['status'] === 'string' &&
    typeof record['startedAt'] === 'number' &&
    Array.isArray(record['steps'])
  );
}

/**
 * Pipelines state (P1-02-C): definitions, in-memory runs, and live SSE
 * updates. The backend broadcasts a `pipeline_step` event with a full run
 * snapshot on every state transition, so the frontend never polls runs.
 */
export function usePipelines(): {
  pipelines: Pipeline[] | null;
  runs: PipelineRunRecord[];
  error: string | null;
  refresh: () => Promise<void>;
  save: (pipeline: Pipeline) => Promise<void>;
  remove: (id: string) => Promise<void>;
  run: (pipelineId: string, input?: string, targeting?: { cwd?: string; agent?: 'pi' | 'codex' }) => Promise<void>;
  abort: (runId: string) => Promise<void>;
  approve: (runId: string, approved: boolean) => Promise<void>;
} {
  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [runs, setRuns] = useState<PipelineRunRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [list, runList] = await Promise.all([api.pipelines(), api.pipelineRuns()]);
      setPipelines(list.pipelines);
      setRuns(runList.runs);
      setError(null);
    } catch (err) {
      // Keep the tab renderable after a failed first load; a null list is
      // reserved for an in-flight request, not a settled error.
      setPipelines([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // SSE: pipeline_step snapshots upsert into the runs list live.
  useEffect(() => {
    const source = new EventSource(eventsUrl());
    const onEvent = (event: MessageEvent<string>): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return;
      }
      const data = parsed as Record<string, unknown>;
      if (data['type'] !== 'pipeline_step' || !isPipelineRunRecord(data['run'])) {
        return;
      }
      const run = data['run'];
      setRuns((prev) => {
        const index = prev.findIndex((r) => r.runId === run.runId);
        if (index === -1) {
          return [...prev, run];
        }
        const next = [...prev];
        next[index] = run;
        return next;
      });
    };
    // The hub broadcasts named `pi` events (same channel as chat state).
    source.addEventListener('pi', onEvent);
    return () => {
      source.removeEventListener('pi', onEvent);
      source.close();
    };
  }, []);

  const save = useCallback(
    async (pipeline: Pipeline): Promise<void> => {
      await api.savePipeline(pipeline);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await api.deletePipeline(id);
      await refresh();
    },
    [refresh],
  );

  const run = useCallback(
    async (pipelineId: string, input?: string, targeting?: { cwd?: string; agent?: 'pi' | 'codex' }): Promise<void> => {
      const { run: record } = await api.runPipeline(pipelineId, input, targeting);
      setRuns((prev) => [...prev.filter((r) => r.runId !== record.runId), record]);
    },
    [],
  );

  const abort = useCallback(
    async (runId: string): Promise<void> => {
      await api.abortPipelineRun(runId);
    },
    [],
  );

  const approve = useCallback(
    async (runId: string, approved: boolean): Promise<void> => {
      await api.approvePipelineRun(runId, approved);
    },
    [],
  );

  return { pipelines, runs, error, refresh, save, remove, run, abort, approve };
}
