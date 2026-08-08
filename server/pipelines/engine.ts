/**
 * Pipeline execution engine (P1-02-C, PiHub-exclusive).
 *
 * Drives a pipeline against one pi session through the existing RPC bridge:
 * - prompt/steer steps send the expanded template and wait for `agent_settled`
 * - setModel/setThinking map to RPC model/thinking switches
 * - approval steps (type or requiresApproval) hang until approve/reject
 * - match + nextOnMatch/nextOnMiss branch on the last assistant output
 * - onError stop (default) / skip / retry(maxRetries)
 *
 * State machine (per run): idle → running → completed | aborted | failed.
 * Per step: pending → running → succeeded | failed | skipped | awaiting-approval.
 * Every state change emits 'run-change' with a snapshot of the run record.
 */
import { EventEmitter } from 'node:events';
import type { Pipeline, PipelineStep } from '../../shared/types.js';
import type { PipelineStore } from './store.js';
import type { RpcCommand } from '../rpc-bridge.js';
import type { RpcResponse, RpcStreamEvent } from '../../shared/types.js';
import type {
  PipelineRunRecord,
  PipelineRunStatus,
  PipelineStepRecord,
  PipelineStepStatus,
} from '../../shared/types.js';

export type { PipelineRunRecord, PipelineRunStatus, PipelineStepRecord, PipelineStepStatus };

export interface PipelineRunContext {
  sessionName?: string | undefined;
  cwd?: string | undefined;
}

/** Minimal bridge surface the engine needs (real RpcBridge or a test fake). */
export interface PipelineBridgeLike {
  send(command: RpcCommand): Promise<RpcResponse>;
  on(event: 'event', listener: (event: RpcStreamEvent) => void): unknown;
  off(event: 'event', listener: (event: RpcStreamEvent) => void): unknown;
}

interface EngineEvents {
  'run-change': (run: PipelineRunRecord) => void;
}

const DEFAULT_SETTLE_TIMEOUT_MS = 10 * 60 * 1000;
const RETRY_DELAY_MS = 800;

/** Expands {{var}} placeholders; unknown placeholders stay untouched. */
export function expandTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : value;
  });
}

/** Output matcher: `/regex/flags`-shaped strings use RegExp, else substring. */
export function matchOutput(output: string, pattern: string): boolean {
  const regexMatch = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (regexMatch !== null) {
    const source = regexMatch[1];
    const flags = regexMatch[2] ?? '';
    if (source === undefined) {
      return false;
    }
    try {
      return new RegExp(source, flags).test(output);
    } catch {
      return false;
    }
  }
  return output.includes(pattern);
}

interface SettleWaiter {
  resolve: (result: 'settled' | 'aborted') => void;
  timer: NodeJS.Timeout;
}

function snapshot(run: PipelineRunRecord): PipelineRunRecord {
  return structuredClone(run);
}

export class PipelineEngine extends EventEmitter {
  private readonly runs = new Map<string, PipelineRunRecord>();
  private readonly waiters = new Map<string, SettleWaiter>();
  private readonly approvals = new Map<string, (approved: boolean) => void>();
  private nextRunId = 1;

  constructor(
    private readonly bridge: PipelineBridgeLike,
    private readonly store: PipelineStore,
    private readonly settleTimeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS,
  ) {
    super();
  }

  override on<K extends keyof EngineEvents>(event: K, listener: EngineEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof EngineEvents>(event: K, payload: EngineEvents[K] extends (arg: infer T) => void ? T : never): boolean {
    return super.emit(event, payload);
  }

  getRun(runId: string): PipelineRunRecord | undefined {
    const run = this.runs.get(runId);
    return run === undefined ? undefined : snapshot(run);
  }

  listRuns(): PipelineRunRecord[] {
    return [...this.runs.values()].map(snapshot);
  }

  /**
   * Starts a run. Returns the initial record; execution proceeds
   * asynchronously and emits 'run-change' on every state transition.
   */
  start(pipeline: Pipeline, input: string, context: PipelineRunContext): PipelineRunRecord {
    const runId = `run-${String(this.nextRunId)}`;
    this.nextRunId += 1;
    const run: PipelineRunRecord = {
      runId,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      status: 'running',
      input,
      startedAt: Date.now(),
      steps: pipeline.steps.map((step) => ({
        stepId: step.id,
        name: step.name,
        type: step.type,
        status: 'pending',
      })),
    };
    this.runs.set(runId, run);
    this.emitChange(run);
    void this.execute(run, pipeline, input, context);
    return snapshot(run);
  }

  /** Answers an awaiting-approval step; false aborts the whole run. */
  approve(runId: string, approved: boolean): boolean {
    const resolver = this.approvals.get(runId);
    if (resolver === undefined) {
      return false;
    }
    this.approvals.delete(runId);
    resolver(approved);
    return true;
  }

  abort(runId: string): boolean {
    const run = this.runs.get(runId);
    if (run === undefined || run.status !== 'running') {
      return false;
    }
    run.status = 'aborted';
    run.finishedAt = Date.now();
    this.emitChange(run);
    // SPRINT-2 B3: cancel the pi side too — previously only the in-memory
    // waiter was released and pi kept running the prompt to completion.
    void this.bridge.send({ type: 'abort' }).catch(() => {
      // best effort: pi may already be idle
    });
    // Release a pending settle wait; the loop then stops.
    const waiter = this.waiters.get(runId);
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      this.waiters.delete(runId);
      waiter.resolve('aborted');
    }
    // Release a pending approval.
    const resolver = this.approvals.get(runId);
    if (resolver !== undefined) {
      this.approvals.delete(runId);
      resolver(false);
    }
    return true;
  }

  private emitChange(run: PipelineRunRecord): void {
    const snap = snapshot(run);
    this.store.appendRunLine(run.pipelineId, snap);
    this.emit('run-change', snap);
  }

  private async execute(
    run: PipelineRunRecord,
    pipeline: Pipeline,
    input: string,
    context: PipelineRunContext,
  ): Promise<void> {
    const vars: Record<string, string> = {
      input,
      lastOutput: '',
      lastToolOutput: '',
      sessionName: context.sessionName ?? '',
      cwd: context.cwd ?? '',
    };
    const byId = new Map(pipeline.steps.map((step) => [step.id, step] as const));
    const visited = new Set<string>();
    let index = 0;

    while (index < pipeline.steps.length) {
      // abort() mutates run.status from outside the async loop; re-read the
      // full status union here so the runtime check is visible to TS.
      const status: PipelineRunStatus = run.status;
      if (status === 'aborted') {
        return;
      }
      const step = pipeline.steps[index];
      if (step === undefined) {
        break;
      }
      if (visited.has(step.id)) {
        // Guard against match-branch cycles; loops are a phase-2 enhancement.
        break;
      }
      visited.add(step.id);
      const record = run.steps.find((s) => s.stepId === step.id);
      if (record === undefined) {
        break;
      }
      const outcome = await this.executeStep(run, record, step, vars, pipeline);
      const afterStep: PipelineRunStatus = run.status;
      if (afterStep === 'aborted') {
        return;
      }
      if (outcome === 'stop') {
        run.status = 'failed';
        run.finishedAt = Date.now();
        this.emitChange(run);
        return;
      }
      if (outcome === 'branch') {
        // Fall through to the branch resolution below with the same record.
      }

      // Branching: match against the last output, then jump or continue.
      const next = outcome === 'branch' ? this.resolveNext(step, record, byId) : index + 1;
      if (next === null || next === index) {
        break;
      }
      index = next;
    }

    if (run.status !== 'aborted' && run.status !== 'failed' && run.status !== 'uncertain') {
      run.status = 'completed';
      run.finishedAt = Date.now();
      this.emitChange(run);
    }
  }

  /** Resolves the next step id honoring match/nextOnMatch/nextOnMiss. */
  private resolveNext(
    step: PipelineStep,
    record: PipelineStepRecord,
    byId: Map<string, PipelineStep>,
  ): number | null {
    const output = record.output ?? '';
    if (step.match !== undefined && (step.nextOnMatch !== undefined || step.nextOnMiss !== undefined)) {
      const hit = matchOutput(output, step.match);
      const target = hit ? step.nextOnMatch : step.nextOnMiss;
      if (target !== undefined) {
        const index = [...byId.keys()].indexOf(target);
        if (index !== -1) {
          return index;
        }
      }
      // branch target missing → end the run
      return null;
    }
    return null;
  }

  private async executeStep(
    run: PipelineRunRecord,
    record: PipelineStepRecord,
    step: PipelineStep,
    vars: Record<string, string>,
    pipeline: Pipeline,
  ): Promise<'ok' | 'stop' | 'branch'> {
    let attempts = 0;
    const maxRetries = step.maxRetries ?? 0;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const beforeStep: PipelineRunStatus = run.status;
      if (beforeStep === 'aborted') {
        return 'stop';
      }
      attempts += 1;
      record.status = 'running';
      record.attempts = attempts;
      record.startedAt = Date.now();
      delete record.error;
      this.emitChange(run);

      const needsApproval = step.type === 'approval' || step.requiresApproval === true;
      if (needsApproval) {
        record.status = 'awaiting-approval';
        this.emitChange(run);
        const approved = await this.waitForApproval(run);
        if (run.status === 'aborted' || !approved) {
          run.status = 'aborted';
          run.finishedAt = Date.now();
          this.emitChange(run);
          return 'stop';
        }
        if (step.type === 'approval') {
          // Pure approval gate: approving the step completes it.
          record.status = 'succeeded';
          record.finishedAt = Date.now();
          this.emitChange(run);
          return 'ok';
        }
        // SPRINT-2 B1: a prompt/steer step with requiresApproval=true must
        // EXECUTE after approval — previously the gate branch returned 'ok'
        // directly, so the prompt was never sent to pi (audit-confirmed bug).
        // Fall through to the switch below with the same step.
      }

      try {
        switch (step.type) {
          case 'prompt': {
            const message = expandTemplate(step.prompt ?? '', vars);
            record.input = message;
            this.emitChange(run);
            const behavior =
              step.streamingBehavior === 'steer' || step.streamingBehavior === 'followUp'
                ? step.streamingBehavior
                : undefined;
            const sent = await this.bridge.send({
              type: 'prompt',
              message,
              ...(behavior !== undefined ? { streamingBehavior: behavior } : {}),
            });
            if (!sent.success) {
              throw new Error(sent.error ?? 'prompt 被 pi 拒绝');
            }
            const settled = await this.waitForSettle(run, record, vars);
            if (settled === 'aborted') {
              return 'stop';
            }
            // 'uncertain': run.status already flipped to uncertain; the step
            // itself completed with whatever output was collected.
            break;
          }
          case 'steer': {
            const message = expandTemplate(step.prompt ?? '', vars);
            record.input = message;
            this.emitChange(run);
            const sent = await this.bridge.send({ type: 'steer', message });
            if (!sent.success) {
              throw new Error(sent.error ?? 'steer 被 pi 拒绝');
            }
            const settled = await this.waitForSettle(run, record, vars);
            if (settled === 'aborted') {
              return 'stop';
            }
            break;
          }
          case 'setModel': {
            if (step.model !== undefined) {
              await this.bridge.send({ type: 'set_model', provider: step.model.provider, modelId: step.model.id });
            }
            break;
          }
          case 'setThinking': {
            await this.bridge.send({ type: 'set_thinking_level', level: step.thinkingLevel ?? '' });
            break;
          }
          case 'approval': {
            // handled above; unreachable here
            break;
          }
        }
        record.status = 'succeeded';
        record.finishedAt = Date.now();
        this.emitChange(run);
        return step.match !== undefined ? 'branch' : 'ok';
      } catch (err) {
        record.status = 'failed';
        record.error = err instanceof Error ? err.message : String(err);
        record.finishedAt = Date.now();
        this.emitChange(run);
        if (pipeline.onError === 'retry' && attempts <= maxRetries) {
          await new Promise((resolve) => {
            setTimeout(resolve, RETRY_DELAY_MS);
          });
          continue;
        }
        if (pipeline.onError === 'skip') {
          record.status = 'skipped';
          record.finishedAt = Date.now();
          this.emitChange(run);
          return 'ok';
        }
        return 'stop';
      }
    }
  }

  private waitForApproval(run: PipelineRunRecord): Promise<boolean> {
    return new Promise((resolve) => {
      this.approvals.set(run.runId, resolve);
    });
  }

  /** Waits for `agent_settled` while collecting the step's assistant/tool text. */
  private waitForSettle(
    run: PipelineRunRecord,
    record: PipelineStepRecord,
    vars: Record<string, string>,
  ): Promise<'settled' | 'aborted' | 'uncertain'> {
    return new Promise<'settled' | 'aborted' | 'uncertain'>((resolve) => {
      let done = false;
      const finish = (result: 'settled' | 'aborted' | 'uncertain'): void => {
        if (done) {
          return;
        }
        done = true;
        this.bridge.off('event', onEvent);
        const waiter = this.waiters.get(run.runId);
        if (waiter !== undefined) {
          clearTimeout(waiter.timer);
          this.waiters.delete(run.runId);
        }
        resolve(result);
      };
      const onEvent = (event: RpcStreamEvent): void => {
        if (event.type === 'agent_settled') {
          finish('settled');
          return;
        }
        if (event.type === 'message_update') {
          const message = event.message as { role?: unknown; content?: unknown } | undefined;
          if (message?.role === 'assistant' && Array.isArray(message.content)) {
            const text = (message.content as { type?: unknown; text?: unknown }[])
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string)
              .join('');
            if (text.length > 0) {
              record.output = text;
              vars.lastOutput = text;
            }
          }
          if (message?.role === 'toolResult') {
            const content = message.content as { type?: unknown; text?: unknown }[] | undefined;
            if (Array.isArray(content)) {
              const text = content
                .filter((b) => b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text as string)
                .join('');
              if (text.length > 0) {
                record.toolOutput = text;
                vars.lastToolOutput = text;
              }
            }
          }
        }
      };
      const timer = setTimeout(() => {
        // SPRINT-2 B2: a settle timeout is NOT a successful settle — the pi
        // side may still be working (or hung). Mark the run uncertain so the
        // UI shows "result uncertain" instead of a fake green completion.
        run.status = 'uncertain';
        finish('uncertain');
      }, this.settleTimeoutMs);
      this.waiters.set(run.runId, {
        resolve: (result) => {
          finish(result);
        },
        timer,
      });
      this.bridge.on('event', onEvent);
    });
  }
}
