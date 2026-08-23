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
import { createHash, randomBytes } from 'node:crypto';
import type { Pipeline, PipelineStep } from '../../shared/types.js';
import type { PipelineStore } from './store.js';
import type { Lease } from './lease.js';
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
  /** Current session file for correlation (audit P1 fix): when available,
   *  settle/output events from OTHER sessions are ignored, so concurrent
   *  runs cannot steal each other's events. */
  getSessionId?: () => string | null;
  /** Run targeting (chosen folder): the bridge may respawn with a new cwd. */
  getCwd?: () => string;
  restart?: (cwd?: string) => void;
  isRunning?: () => boolean;
  waitReady?: (timeoutMs?: number) => Promise<void>;
}

/** Optional codex executor: prompt steps route here for agent=codex runs.
 *  `prompt` resolves when the turn settles (codex spawns per prompt), so the
 *  engine's bridge-based settle waiting is bypassed for codex runs. */
export interface CodexRunExecutor {
  prompt(message: string, opts?: { cwd?: string }): Promise<{ success: boolean; error?: string }>;
  abort(): Promise<unknown>;
}

interface EngineEvents {
  'run-change': (run: PipelineRunRecord) => void;
}

const DEFAULT_SETTLE_TIMEOUT_MS = 10 * 60 * 1000;
const RETRY_DELAY_MS = 800;
/** v1c: the cross-process execution lease resource (one pipeline run at a
 *  time across PiHub instances on the same machine). */
export const EXECUTION_LEASE_RESOURCE = 'pihub:execution';

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

/** v1b: run statuses that are terminal (the typed receipt is written once). */
function isTerminalRunStatus(status: PipelineRunStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'aborted' ||
    status === 'uncertain'
  );
}

/** v1c-completion: a structured operator/engine intervention on a run. */
export interface RunIntervention {
  kind: 'approval' | 'abort';
  at: number;
  decision: 'approved' | 'rejected' | 'requested' | 'cancelled';
}

/** v1c-completion: deterministic checks computed from the run + pipeline. */
function buildChecks(
  run: PipelineRunRecord,
  pipeline: Pipeline | undefined,
  context: PipelineRunContext | undefined,
): Array<{ checkId: string; target: string; passed: boolean; detail: string }> {
  const checks: Array<{ checkId: string; target: string; passed: boolean; detail: string }> = [];
  if (pipeline === undefined) {
    checks.push({
      checkId: 'no-pipeline-def',
      target: run.runId,
      passed: true,
      detail: 'definition unavailable at closeout; only digest checks apply',
    });
    return checks;
  }
  const byId = new Map(pipeline.steps.map((step) => [step.id, step] as const));
  // template-replay: rebuild vars from the run context + the last succeeded
  // outputs, then re-expand each prompt/steer step's template against its
  // recorded input. A mismatch is an honest failed check (never fabricated).
  const vars: Record<string, string> = {
    input: run.input,
    lastOutput: '',
    lastToolOutput: '',
    sessionName: context?.sessionName ?? '',
    cwd: context?.cwd ?? '',
  };
  for (const s of run.steps) {
    if (s.status === 'succeeded') {
      if (s.output !== undefined) {
        vars.lastOutput = s.output;
      }
      if (s.toolOutput !== undefined) {
        vars.lastToolOutput = s.toolOutput;
      }
    }
  }
  for (const s of run.steps) {
    const def = byId.get(s.stepId);
    if (def !== undefined && (def.type === 'prompt' || def.type === 'steer') && s.input !== undefined) {
      const replayed = expandTemplate(def.prompt ?? '', vars);
      checks.push({
        checkId: 'template-replay',
        target: s.stepId,
        passed: replayed === s.input,
        detail: replayed === s.input ? 'exact' : `mismatch: recorded=${s.input} replayed=${replayed}`,
      });
    }
  }
  // attempts-bounded: retries must respect maxRetries.
  for (const s of run.steps) {
    const def = byId.get(s.stepId);
    const maxRetries = def?.maxRetries ?? 0;
    if (s.attempts !== undefined && s.attempts > maxRetries + 1) {
      checks.push({
        checkId: 'attempts-bounded',
        target: s.stepId,
        passed: false,
        detail: `attempts=${String(s.attempts)} > maxRetries+1=${String(maxRetries + 1)}`,
      });
    }
  }
  if (checks.length === 0) {
    checks.push({
      checkId: 'no-replayable-step',
      target: run.runId,
      passed: true,
      detail: 'no prompt/steer step with a recorded input to replay',
    });
  }
  return checks;
}

/** v1c-completion: entropy snapshot (non-determinism sources) — honest
 *  minimal set; anything not observable is null, never fabricated. */
function buildEntropy(
  run: PipelineRunRecord,
  context: PipelineRunContext | undefined,
): unknown {
  const envKeys = ['PIHUB_MODE', 'PIHUB_NET'];
  const env: Record<string, string> = {};
  for (const key of envKeys) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  const retryCount = run.steps.reduce(
    (acc, s) => acc + Math.max(0, (s.attempts ?? 1) - 1),
    0,
  );
  return {
    env: Object.keys(env).length > 0 ? env : null,
    toolVersions: { node: process.version },
    cwd: context?.cwd ?? null,
    startedAtEpochMs: run.startedAt,
    retryCount,
    model: null,
    seed: null,
    network: null,
    leaseConflicts: 0,
  };
}

/** v1b: typed receipt — audit truth for a finished run. pi is an RPC
 *  execution surface, so there is no local command/exitCode; the honest
 *  fields are digests + attempts + timing, with nonClaims stating exactly
 *  what is absent. checks/interventions/entropy are filled in at closeout
 *  (v1c-completion), not left as placeholders. */
function buildRunReceipt(
  run: PipelineRunRecord,
  pipeline: Pipeline | undefined,
  context: PipelineRunContext | undefined,
  interventions: RunIntervention[] | undefined,
): unknown {
  const digest = (text: string | undefined): string | null =>
    text !== undefined && text.length > 0
      ? `sha256:${createHash('sha256').update(text).digest('hex')}`
      : null;
  return {
    schemaVersion: 'pihub-receipt-v2',
    runId: run.runId,
    pipelineId: run.pipelineId,
    pipelineName: run.pipelineName,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    steps: run.steps.map((s) => ({
      stepId: s.stepId,
      name: s.name,
      type: s.type,
      status: s.status,
      attempts: s.attempts ?? 0,
      inputDigest: digest(s.input),
      outputDigest: digest(s.output),
      toolOutputDigest: digest(s.toolOutput),
      error: s.error ?? null,
      startedAt: s.startedAt ?? null,
      finishedAt: s.finishedAt ?? null,
      durationMs:
        s.startedAt !== undefined && s.finishedAt !== undefined
          ? Math.max(0, s.finishedAt - s.startedAt)
          : null,
    })),
    checks: buildChecks(run, pipeline, context),
    interventions: interventions ?? [],
    entropy: buildEntropy(run, context),
    environment: {},
    nonClaims: [
      'RPC execution surface: no local command/exitCode fields (pi drives via JSONL)',
      'entropy: model/seed/network are null when not observable; env hash covers only PIHUB_MODE/PIHUB_NET',
      'template-replay vars are rebuilt from the final succeeded outputs (branch-sensitive steps may diverge)',
    ],
  };
}

export class PipelineEngine extends EventEmitter {
  private readonly runs = new Map<string, PipelineRunRecord>();
  private readonly waiters = new Map<string, SettleWaiter>();
  private readonly approvals = new Map<string, (approved: boolean) => void>();
  /** v1c: leases held by active runs (released at terminal state). */
  private readonly runLeases = new Map<string, Lease>();
  /** v1c-completion: per-run context/pipeline/interventions for the receipt. */
  private readonly runContexts = new Map<string, PipelineRunContext>();
  private readonly runPipelines = new Map<string, Pipeline>();
  private readonly runInterventions = new Map<string, RunIntervention[]>();
  /** v1c: per-instance id so runIds are globally unique across processes —
   *  the execution lease owner is the runId, and uniqueness is what makes
   *  cross-process exclusivity meaningful (a recovered run keeps its id and
   *  its owner takes over; a NEW run in another process gets a different id
   *  and conflicts). */
  private readonly instanceId = randomBytes(4).toString('hex');
  private nextRunId = 1;

  constructor(
    private readonly bridge: PipelineBridgeLike,
    private readonly store: PipelineStore,
    private readonly settleTimeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS,
    private readonly leaseGate?: { lease(resource: string, owner: string, ttlMs?: number): Lease | null; release(lease: Lease): boolean },
    private readonly codex?: CodexRunExecutor,
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
   * Starts a run. Throws when another run is already active (v1a
   * serialization: the engine drives ONE bridge / pi session and the protocol
   * cannot attribute settle events per run, so concurrent same-session runs
   * pollute each other's waiters). Execution proceeds asynchronously and
   * emits 'run-change' on every state transition.
   */
  start(
    pipeline: Pipeline,
    input: string,
    context: PipelineRunContext,
    targeting?: { cwd?: string; agent?: 'pi' | 'codex' },
  ): PipelineRunRecord {
    // v1a: reject a new start while any run is still active.
    for (const existing of this.runs.values()) {
      if (existing.status === 'running') {
        throw new Error('another pipeline run is active');
      }
    }
    const runId = `run-${this.instanceId}-${String(this.nextRunId)}`;
    this.nextRunId += 1;
    // v1c: cross-process execution lease (when a lease gate is wired) — a
    // live foreign lease means another PiHub process is running a pipeline.
    if (this.leaseGate !== undefined) {
      const lease = this.leaseGate.lease(EXECUTION_LEASE_RESOURCE, runId);
      if (lease === null) {
        throw new Error('execution lease conflict: another process is running a pipeline');
      }
      this.runLeases.set(runId, lease);
    }
    const run: PipelineRunRecord = {
      runId,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      status: 'running',
      input,
      ...(targeting?.cwd !== undefined && targeting.cwd.length > 0 ? { cwd: targeting.cwd } : {}),
      ...(targeting?.agent !== undefined ? { agent: targeting.agent } : {}),
      startedAt: Date.now(),
      steps: pipeline.steps.map((step) => ({
        stepId: step.id,
        name: step.name,
        type: step.type,
        status: 'pending',
      })),
    };
    // v1c-completion: keep the closeout context for the typed receipt.
    this.runPipelines.set(runId, pipeline);
    this.runContexts.set(runId, context);
    this.runs.set(runId, run);
    this.emitChange(run);
    void this.execute(run, pipeline, input, context);
    return snapshot(run);
  }

  /** v1b: recover in-flight runs from the durable journal (idempotent replay
   *  MVP). Terminal runs are skipped; a run whose last journal snapshot is
   *  still `running` is rebuilt from that snapshot and resumes at the first
   *  non-terminal step — completed steps are never re-sent. */
  recover(): void {
    for (const { runId, snapshot: snap } of this.store.listRecoverableRuns()) {
      if (this.runs.has(runId)) {
        continue;
      }
      const run = snap as PipelineRunRecord;
      if (run.status !== 'running') {
        continue;
      }
      const pipeline = this.store.get(run.pipelineId);
      if (pipeline === undefined) {
        // The pipeline definition is gone; mark the run failed honestly.
        run.status = 'failed';
        run.finishedAt = Date.now();
        this.runs.set(runId, run);
        this.emitChange(run);
        continue;
      }
      // run-<instance>-<n>: keep the monotonic counter for future ids.
      const match = /^run-[a-f0-9]+-(\d+)$/.exec(runId);
      if (match !== null) {
        const numericId = Number(match[1]);
        if (Number.isFinite(numericId)) {
          this.nextRunId = Math.max(this.nextRunId, numericId + 1);
        }
      }
      // v1c: re-acquire the execution lease for the recovered run. The same
      // owner (runId) takes over its own lease; a live foreign lease means
      // another process is actively running it — skip honestly.
      if (this.leaseGate !== undefined) {
        const lease = this.leaseGate.lease(EXECUTION_LEASE_RESOURCE, runId);
        if (lease === null) {
          continue;
        }
        this.runLeases.set(runId, lease);
      }
      // Rebuild resume state from the last snapshot: completed steps are
      // visited (never re-sent); vars come from their collected output.
      const vars: Record<string, string> = {
        input: run.input,
        lastOutput: '',
        lastToolOutput: '',
        sessionName: '',
        cwd: '',
      };
      let index = 0;
      run.steps.forEach((step, i) => {
        if (step.status === 'succeeded' || step.status === 'failed' || step.status === 'skipped') {
          if (step.status === 'succeeded') {
            if (step.output !== undefined) {
              vars.lastOutput = step.output;
            }
            if (step.toolOutput !== undefined) {
              vars.lastToolOutput = step.toolOutput;
            }
          }
          index = i + 1;
        }
      });
      this.runPipelines.set(runId, pipeline);
      this.runs.set(runId, run);
      this.emitChange(run); // surface the recovered run on SSE
      void this.execute(run, pipeline, run.input, {}, { index, vars });
    }
  }

  /** Answers an awaiting-approval step; false aborts the whole run. */
  approve(runId: string, approved: boolean): boolean {
    const resolver = this.approvals.get(runId);
    if (resolver === undefined) {
      return false;
    }
    this.approvals.delete(runId);
    resolver(approved);
    // v1c-completion: record the intervention on the run's audit trail.
    const prior = this.runInterventions.get(runId) ?? [];
    prior.push({
      kind: 'approval',
      at: Date.now(),
      decision: approved ? 'approved' : 'rejected',
    });
    this.runInterventions.set(runId, prior);
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
    if (run.agent === 'codex') {
      // SPRINT-2 B3 (codex analogue): cancel the adapter side too.
      void this.codex?.abort().catch(() => {
        // best effort
      });
    } else {
      // SPRINT-2 B3: cancel the pi side too — previously only the in-memory
      // waiter was released and pi kept running the prompt to completion.
      void this.bridge.send({ type: 'abort' }).catch(() => {
        // best effort: pi may already be idle
      });
    }
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
    // v1c-completion: record the abort intervention on the run's audit trail.
    const prior = this.runInterventions.get(runId) ?? [];
    prior.push({ kind: 'abort', at: Date.now(), decision: 'requested' });
    this.runInterventions.set(runId, prior);
    return true;
  }

  private emitChange(run: PipelineRunRecord): void {
    const snap = snapshot(run);
    this.store.appendRunLine(run.pipelineId, snap);
    // v1b: per-run durable journal (append-only audit truth) + terminal
    // typed receipt (written exactly once per run).
    this.store.appendRunJournal(run.runId, snap);
    if (isTerminalRunStatus(snap.status)) {
      if (this.store.readRunReceipt(run.runId) === null) {
        this.store.writeRunReceipt(
          run.runId,
          buildRunReceipt(
            snap,
            this.runPipelines.get(run.runId),
            this.runContexts.get(run.runId),
            this.runInterventions.get(run.runId),
          ),
        );
      }
      // v1c: release the execution lease exactly once, at the terminal state.
      const lease = this.runLeases.get(run.runId);
      if (lease !== undefined) {
        this.leaseGate?.release(lease);
        this.runLeases.delete(run.runId);
      }
    }
    this.emit('run-change', snap);
  }

  private async execute(
    run: PipelineRunRecord,
    pipeline: Pipeline,
    input: string,
    context: PipelineRunContext,
    resume?: { index: number; vars: Record<string, string> },
  ): Promise<void> {
    const vars: Record<string, string> = resume?.vars ?? {
      input,
      lastOutput: '',
      lastToolOutput: '',
      sessionName: context.sessionName ?? '',
      cwd: context.cwd ?? '',
    };
    // Run targeting: a chosen folder on a pi run respawns the bridge with
    // that cwd (codex runs pass the folder per prompt instead).
    if (run.agent !== 'codex' && run.cwd !== undefined && this.bridge.getCwd !== undefined) {
      if (this.bridge.getCwd() !== run.cwd) {
        this.bridge.restart?.(run.cwd);
        try {
          if (this.bridge.waitReady !== undefined) {
            await this.bridge.waitReady(10_000);
          }
        } catch {
          run.status = 'failed';
          run.finishedAt = Date.now();
          this.emitChange(run);
          return;
        }
      }
    }
    const byId = new Map(pipeline.steps.map((step) => [step.id, step] as const));
    // v1b: rebuilt from persisted step states on resume — completed steps are
    // never re-sent (idempotent replay).
    const visited = new Set<string>(
      run.steps
        .filter((s) => s.status === 'succeeded' || s.status === 'failed' || s.status === 'skipped')
        .map((s) => s.stepId),
    );
    let index = resume?.index ?? 0;

    while (index < pipeline.steps.length) {
      // abort()/timeout mutate run.status from outside the async loop; re-read
      // the full status union here so the runtime check is visible to TS.
      // v1a: uncertain is a TERMINAL state — a settle timeout must not let the
      // engine keep executing subsequent steps.
      const status: PipelineRunStatus = run.status;
      if (status === 'aborted' || status === 'uncertain') {
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
      if (afterStep === 'aborted' || afterStep === 'uncertain') {
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
      // v1a: a match with no resolvable route (no nextOn* targets, or a
      // missing target) continues linearly instead of silently truncating the
      // remaining steps.
      const next = outcome === 'branch' ? this.resolveNext(step, record, byId) : index + 1;
      if (next === null) {
        index += 1;
        continue;
      }
      if (next === index) {
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
      // No resolvable branch target → null; execute() continues linearly
      // instead of silently ending the run.
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
  ): Promise<'ok' | 'stop' | 'branch' | 'uncertain'> {
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
            if (run.agent === 'codex') {
              // Codex runs spawn one exec per prompt; the promise resolves
              // when the turn settles, so no bridge settle wait is needed.
              if (this.codex === undefined) {
                throw new Error('agent codex 未接线（executor 不可用）');
              }
              const sent = await this.codex.prompt(message, run.cwd !== undefined ? { cwd: run.cwd } : undefined);
              if (!sent.success) {
                throw new Error(sent.error ?? 'prompt 被 codex 拒绝');
              }
              break;
            }
            const sent = await this.bridge.send({
              type: 'prompt',
              message,
              ...(behavior !== undefined ? { streamingBehavior: behavior } : {}),
            });
            if (!sent.success) {
              throw new Error(sent.error ?? 'prompt 被 pi 拒绝');
            }
            const settled = await this.waitForSettle(
              run,
              record,
              vars,
              this.bridge.getSessionId?.() ?? null,
            );
            if (settled === 'aborted') {
              return 'stop';
            }
            // v1a: uncertain is terminal — the step must NOT be marked
            // succeeded and no later step may run.
            if (settled === 'uncertain') {
              return 'uncertain';
            }
            break;
          }
          case 'steer': {
            const message = expandTemplate(step.prompt ?? '', vars);
            record.input = message;
            this.emitChange(run);
            if (run.agent === 'codex') {
              // codex exec has no steer surface — honest refusal instead of
              // pretending the step ran.
              throw new Error('agent codex 不支持 steer 步骤');
            }
            const sent = await this.bridge.send({ type: 'steer', message });
            if (!sent.success) {
              throw new Error(sent.error ?? 'steer 被 pi 拒绝');
            }
            const settled = await this.waitForSettle(
              run,
              record,
              vars,
              this.bridge.getSessionId?.() ?? null,
            );
            if (settled === 'aborted') {
              return 'stop';
            }
            // v1a: uncertain is terminal (same rule as the prompt case).
            if (settled === 'uncertain') {
              return 'uncertain';
            }
            break;
          }
          case 'setModel': {
            if (run.agent === 'codex') {
              throw new Error('agent codex 不支持 setModel 步骤');
            }
            if (step.model !== undefined) {
              await this.bridge.send({ type: 'set_model', provider: step.model.provider, modelId: step.model.id });
            }
            break;
          }
          case 'setThinking': {
            if (run.agent === 'codex') {
              throw new Error('agent codex 不支持 setThinking 步骤');
            }
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

  /** Waits for `agent_settled` while collecting the step's assistant/tool text.
   *  Events are filtered by session (audit P1 fix): when the bridge knows the
   *  current session AND the event carries a different sessionId, the event
   *  belongs to another concurrent run and is ignored. */
  private waitForSettle(
    run: PipelineRunRecord,
    record: PipelineStepRecord,
    vars: Record<string, string>,
    runSessionId: string | null,
  ): Promise<'settled' | 'aborted' | 'uncertain'> {
    return new Promise<'settled' | 'aborted' | 'uncertain'>((resolve) => {
      // v1a: abort-race guard — abort() may have flipped run.status between
      // bridge.send resolving and this waiter registering; check it
      // synchronously so the waiter never hangs for the full settle timeout.
      if (run.status === 'aborted') {
        resolve('aborted');
        return;
      }
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
        if (
          runSessionId !== null &&
          typeof event.sessionId === 'string' &&
          event.sessionId !== runSessionId
        ) {
          return; // another session's run — not ours
        }
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
        // v1a: broadcast the terminal transition — the step is NOT marked
        // succeeded anymore, so without this the frontend would never see
        // the uncertain state.
        this.emitChange(run);
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
