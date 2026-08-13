import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PipelineEngine, expandTemplate, matchOutput, type PipelineRunRecord } from './engine.js';
import { createPipelineStore } from './store.js';
import type { Pipeline } from '../../shared/types.js';
import type { PipelineBridgeLike } from './engine.js';
import type { RpcCommand } from '../rpc-bridge.js';
import type { RpcResponse } from '../../shared/types.js';

class FakeBridge extends EventEmitter implements PipelineBridgeLike {
  public sent: RpcCommand[] = [];
  public failPrompt = false;
  /** getSessionId() result (audit P1 correlation). */
  public sessionId: string | null = null;

  getSessionId(): string | null {
    return this.sessionId;
  }

  send(command: RpcCommand): Promise<RpcResponse> {
    this.sent.push(command);
    if (this.failPrompt && command.type === 'prompt') {
      return Promise.reject(new Error('fake send failure'));
    }
    return Promise.resolve({ type: 'response', command: command.type, success: true });
  }

  assistantText(text: string, sessionId?: string): void {
    this.emit('event', {
      type: 'message_update',
      ...(sessionId !== undefined ? { sessionId } : {}),
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
  }

  toolText(text: string): void {
    this.emit('event', {
      type: 'message_update',
      message: { role: 'toolResult', content: [{ type: 'text', text }] },
    });
  }

  settle(sessionId?: string): void {
    this.emit('event', {
      type: 'agent_settled',
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function samplePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'p1',
    name: 'Refactor HTML',
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    onError: 'stop',
    steps: [
      { id: 's1', name: 'Plan', type: 'prompt', prompt: 'analyze {{input}} in {{cwd}}' },
      { id: 's2', name: 'Confirm', type: 'approval' },
      { id: 's3', name: 'Execute', type: 'prompt', prompt: 'apply: {{lastOutput}}' },
    ],
    ...overrides,
  };
}

async function waitForStatus(
  engine: PipelineEngine,
  runId: string,
  predicate: (run: PipelineRunRecord) => boolean,
  timeoutMs = 2000,
): Promise<PipelineRunRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = engine.getRun(runId);
    if (run !== undefined && predicate(run)) {
      return run;
    }
    await tick();
  }
  const run = engine.getRun(runId);
  throw new Error(`timeout waiting for run ${runId}; last: ${JSON.stringify(run)}`);
}

let tempDir: string | undefined;

async function makeEngine(bridge: FakeBridge): Promise<{ engine: PipelineEngine; storePath: string }> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-engine-test-'));
  const store = createPipelineStore(tempDir);
  const engine = new PipelineEngine(bridge, store, 5000);
  return { engine, storePath: tempDir };
}

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('expandTemplate', () => {
  it('replaces known vars and leaves unknown placeholders intact', () => {
    expect(
      expandTemplate('a {{input}} b {{lastOutput}} c {{unknown}}', {
        input: 'x',
        lastOutput: 'y',
      }),
    ).toBe('a x b y c {{unknown}}');
  });
});

describe('matchOutput', () => {
  it('matches substring patterns', () => {
    expect(matchOutput('everything failed badly', 'failed')).toBe(true);
    expect(matchOutput('all good', 'failed')).toBe(false);
  });
  it('matches /regex/flags patterns', () => {
    expect(matchOutput('ERROR: boom', '/error/i')).toBe(true);
    expect(matchOutput('all good', '/error/i')).toBe(false);
    expect(matchOutput('all good', '/[/bad')).toBe(false); // invalid regex → miss
  });
});

describe('pipeline engine', () => {
  it('runs a linear prompt pipeline with template vars and completes', async () => {
    const bridge = new FakeBridge();
    const { engine } = await makeEngine(bridge);
    const run = engine.start(samplePipeline(), 'index.html', { cwd: '/work/a' });

    await tick();
    // first prompt sent with input + cwd expanded
    expect(bridge.sent).toContainEqual({ type: 'prompt', message: 'analyze index.html in /work/a' });
    bridge.assistantText('plan: rewrite sections');
    bridge.toolText('tool ok');
    bridge.settle();

    await waitForStatus(engine, run.runId, (r) => r.steps[0]?.status === 'succeeded');
    // approval hangs
    await waitForStatus(engine, run.runId, (r) => r.steps[1]?.status === 'awaiting-approval');
    expect(engine.approve(run.runId, true)).toBe(true);
    await tick();
    // second prompt uses lastOutput from step 1
    expect(bridge.sent).toContainEqual({ type: 'prompt', message: 'apply: plan: rewrite sections' });
    bridge.assistantText('done');
    bridge.settle();

    const finalRun = await waitForStatus(engine, run.runId, (r) => r.status === 'completed');
    expect(finalRun.steps.map((s) => s.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    expect(finalRun.steps[0]?.output).toBe('plan: rewrite sections');
    expect(finalRun.steps[0]?.toolOutput).toBe('tool ok');
  });

  it('rejecting an approval aborts the run', async () => {
    const bridge = new FakeBridge();
    const { engine } = await makeEngine(bridge);
    const run = engine.start(samplePipeline(), 'x', {});
    await tick();
    bridge.settle();
    await waitForStatus(engine, run.runId, (r) => r.steps[1]?.status === 'awaiting-approval');
    engine.approve(run.runId, false);
    const finalRun = await waitForStatus(engine, run.runId, (r) => r.status === 'aborted');
    expect(finalRun.steps[1]?.status).toBe('awaiting-approval');
    expect(bridge.sent).toHaveLength(1); // step 3 never ran
  });

  it('branching: match hit follows nextOnMatch, miss follows nextOnMiss', async () => {
    const pipeline = samplePipeline({
      steps: [
        { id: 's1', name: 'Probe', type: 'prompt', prompt: 'probe' },
        { id: 's2', name: 'Happy', type: 'prompt', prompt: 'happy path' },
        { id: 's3', name: 'Sad', type: 'prompt', prompt: 'sad path' },
      ],
    });
    const probe = pipeline.steps[0];
    if (probe !== undefined) {
      probe.match = 'broken';
      probe.nextOnMatch = 's3';
      probe.nextOnMiss = 's2';
    }

    const bridge = new FakeBridge();
    const { engine } = await makeEngine(bridge);
    const run = engine.start(pipeline, 'x', {});
    await tick();
    bridge.assistantText('all broken here');
    bridge.settle();
    await tick();
    bridge.assistantText('fixed the sad path');
    bridge.settle();
    const finalRun = await waitForStatus(engine, run.runId, (r) => r.status === 'completed');
    const messages = bridge.sent
      .filter((c) => c.type === 'prompt')
      .map((c) => (c as { message: string }).message);
    expect(messages).toEqual(['probe', 'sad path']);
    expect(finalRun.steps.map((s) => s.stepId)).toEqual(['s1', 's2', 's3']);
  });

  it('branch cycles are guarded (no infinite loop)', async () => {
    const pipeline = samplePipeline({
      steps: [
        { id: 's1', name: 'Loop', type: 'prompt', prompt: 'go' },
        { id: 's2', name: 'End', type: 'prompt', prompt: 'end' },
      ],
    });
    const loop = pipeline.steps[0];
    if (loop !== undefined) {
      loop.match = 'again';
      loop.nextOnMatch = 's1'; // self-loop
    }
    const bridge = new FakeBridge();
    const { engine } = await makeEngine(bridge);
    const run = engine.start(pipeline, 'x', {});
    await tick();
    bridge.assistantText('do it again');
    bridge.settle();
    const finalRun = await waitForStatus(engine, run.runId, (r) => r.status === 'completed', 3000);
    expect(finalRun.status).toBe('completed');
  });

  it('onError=stop marks the run failed when a prompt send rejects', async () => {
    const bridge = new FakeBridge();
    bridge.failPrompt = true;
    const { engine } = await makeEngine(bridge);
    const run = engine.start(samplePipeline(), 'x', {});
    const finalRun = await waitForStatus(engine, run.runId, (r) => r.status === 'failed');
    expect(finalRun.steps[0]?.status).toBe('failed');
    expect(finalRun.steps[0]?.error).toContain('fake send failure');
  });

  it('onError=retry retries up to maxRetries and succeeds', async () => {
    const pipeline = samplePipeline({
      onError: 'retry',
      steps: [{ id: 's1', name: 'Plan', type: 'prompt', prompt: 'go' }],
    });
    const retryStep = pipeline.steps[0];
    if (retryStep !== undefined) {
      retryStep.maxRetries = 2;
    }
    const bridge = new FakeBridge();
    const { engine } = await makeEngine(bridge);
    let attempts = 0;
    bridge.send = (command: RpcCommand): Promise<RpcResponse> => {
      bridge.sent.push(command);
      attempts += 1;
      if (command.type === 'prompt' && attempts < 3) {
        return Promise.reject(new Error(`attempt ${String(attempts)}`));
      }
      if (command.type === 'prompt') {
        // auto-settle the successful attempt (macro task: runs after the
        // engine has attached its settle listener)
        setImmediate(() => {
          bridge.settle();
        });
      }
      return Promise.resolve({ type: 'response', command: command.type, success: true });
    };
    const run = engine.start(pipeline, 'x', {});
    const finalRun = await waitForStatus(engine, run.runId, (r) => r.status === 'completed', 5000);
    expect(finalRun.steps[0]?.status).toBe('succeeded');
    expect(finalRun.steps[0]?.attempts).toBe(3);
  });

  it('onError=skip marks the failed step skipped and continues', async () => {
    const pipeline = samplePipeline({ onError: 'skip' });
    const bridge = new FakeBridge();
    bridge.failPrompt = true;
    const { engine } = await makeEngine(bridge);
    const run = engine.start(pipeline, 'x', {});
    await waitForStatus(engine, run.runId, (r) => r.steps[0]?.status === 'skipped');
    // approval still hangs; reject to finish
    await waitForStatus(engine, run.runId, (r) => r.steps[1]?.status === 'awaiting-approval');
    engine.approve(run.runId, false);
    const finalRun = await waitForStatus(engine, run.runId, (r) => r.status === 'aborted');
    expect(finalRun.steps[0]?.status).toBe('skipped');
  });

  it('abort stops a running prompt wait', async () => {
    const bridge = new FakeBridge();
    const { engine } = await makeEngine(bridge);
    const run = engine.start(samplePipeline(), 'x', {});
    await tick();
    expect(engine.abort(run.runId)).toBe(true);
    const finalRun = await waitForStatus(engine, run.runId, (r) => r.status === 'aborted');
    expect(finalRun.steps[0]?.status).toBe('running');
    expect(engine.abort(run.runId)).toBe(false); // already aborted
  });

  it('SPRINT-2 B3: abort sends the pi abort command, not just a memory release', async () => {
    const bridge = new FakeBridge();
    const { engine } = await makeEngine(bridge);
    const run = engine.start(samplePipeline(), 'x', {});
    await tick();
    engine.abort(run.runId);
    await waitForStatus(engine, run.runId, (r) => r.status === 'aborted');
    expect(bridge.sent).toContainEqual({ type: 'abort' });
  });

  it('SPRINT-2 B1: a prompt with requiresApproval executes after approval', async () => {
    const bridge = new FakeBridge();
    const { engine } = await makeEngine(bridge);
    const pipeline = samplePipeline({
      steps: [
        { id: 's1', name: 'Guarded prompt', type: 'prompt', prompt: 'do it', requiresApproval: true },
      ],
    });
    const run = engine.start(pipeline, 'x', {});
    await waitForStatus(engine, run.runId, (r) => r.steps[0]?.status === 'awaiting-approval');
    // Before the fix the step succeeded right after approval and the prompt
    // was NEVER sent — the approval branch returned early.
    engine.approve(run.runId, true);
    // The guarded prompt now executes: let the approval promise settle, then
    // settle the agent to complete the run.
    await tick();
    bridge.settle();
    const finalRun = await waitForStatus(engine, run.runId, (r) => r.status === 'completed');
    expect(bridge.sent).toContainEqual({ type: 'prompt', message: 'do it' });
    expect(finalRun.steps[0]?.status).toBe('succeeded');
  });

  it('SPRINT-2 B2 + v1a: settle timeout marks the run uncertain and stops (no later step runs)', async () => {
    const bridge = new FakeBridge();
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-engine-test-'));
    const store = createPipelineStore(tempDir);
    // Tiny settle timeout so the test does not wait minutes.
    const engine = new PipelineEngine(bridge, store, 30);
    const run = engine.start(samplePipeline(), 'x', {});
    // Never emit agent_settled — the timeout must fire.
    const finalRun = await waitForStatus(engine, run.runId, (r) => r.status === 'uncertain');
    expect(finalRun.status).toBe('uncertain');
    // v1a: the timed-out step is NOT marked succeeded (we do not know the
    // outcome), and no later step may execute — uncertain is terminal.
    expect(finalRun.steps[0]?.status).toBe('running');
    expect(finalRun.steps[1]?.status).toBe('pending');
    expect(finalRun.steps[2]?.status).toBe('pending');
    expect(bridge.sent.filter((c) => c.type === 'prompt')).toHaveLength(1);
  });

  it('records step setModel/setThinking sends without waiting for settle', async () => {
    const pipeline = samplePipeline({
      steps: [
        { id: 's1', name: 'Model', type: 'setModel', model: { provider: 'deepseek', id: 'deepseek-v4-pro' } },
        { id: 's2', name: 'Think', type: 'setThinking', thinkingLevel: 'high' },
      ],
    });
    const bridge = new FakeBridge();
    const { engine } = await makeEngine(bridge);
    const run = engine.start(pipeline, 'x', {});
    const finalRun = await waitForStatus(engine, run.runId, (r) => r.status === 'completed');
    expect(bridge.sent).toContainEqual({
      type: 'set_model',
      provider: 'deepseek',
      modelId: 'deepseek-v4-pro',
    });
    expect(bridge.sent).toContainEqual({ type: 'set_thinking_level', level: 'high' });
    expect(finalRun.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('streamingBehavior passes through on prompt steps', async () => {
    const pipeline = samplePipeline({
      steps: [{ id: 's1', name: 'Follow', type: 'prompt', prompt: 'hi', streamingBehavior: 'followUp' }],
    });
    const bridge = new FakeBridge();
    const { engine } = await makeEngine(bridge);
    engine.start(pipeline, 'x', {});
    await tick();
    expect(bridge.sent).toContainEqual({ type: 'prompt', message: 'hi', streamingBehavior: 'followUp' });
  });

  it('ignores settle/output events from other sessions (audit P1 correlation)', async () => {
    const pipeline = samplePipeline({
      steps: [{ id: 's1', name: 'Go', type: 'prompt', prompt: 'work' }],
    });
    const bridge = new FakeBridge();
    bridge.sessionId = 'sess-A';
    const { engine } = await makeEngine(bridge);
    const run = engine.start(pipeline, 'x', {});
    await tick(); // let the prompt step register its settle listener

    // Another session's stream: output must not be collected, settle must
    // not finish our run.
    bridge.assistantText('foreign output', 'sess-B');
    bridge.settle('sess-B');
    await tick();
    const stillRunning = engine.getRun(run.runId);
    expect(stillRunning?.status).toBe('running');
    expect(stillRunning?.steps[0]?.output ?? '').not.toContain('foreign output');

    // Our session settles → the run completes with our own output.
    bridge.assistantText('our output', 'sess-A');
    bridge.settle('sess-A');
    const finalRun = await waitForStatus(engine, run.runId, (r) => r.status === 'completed');
    expect(finalRun.steps[0]?.output).toContain('our output');
  });

  it('keeps legacy behavior when correlation is unavailable', async () => {
    const pipeline = samplePipeline({
      steps: [{ id: 's1', name: 'Go', type: 'prompt', prompt: 'work' }],
    });
    const bridge = new FakeBridge();
    bridge.sessionId = null; // no get_state yet — events carry no ids either
    const { engine } = await makeEngine(bridge);
    const run = engine.start(pipeline, 'x', {});
    await tick();
    bridge.assistantText('legacy output');
    bridge.settle();
    const finalRun = await waitForStatus(engine, run.runId, (r) => r.status === 'completed');
    expect(finalRun.steps[0]?.output).toContain('legacy output');
  });

  it('v1a: a second run is rejected while one is active (run serialization)', async () => {
    const oneStep = samplePipeline({
      steps: [{ id: 's1', name: 'Go', type: 'prompt', prompt: 'work' }],
    });
    const bridge = new FakeBridge();
    const { engine } = await makeEngine(bridge);
    const runA = engine.start(oneStep, 'x', {});
    // The engine drives one pi session and cannot attribute settle events per
    // run — a second concurrent start must be rejected (v1a serialization).
    expect(() => engine.start(oneStep, 'y', {})).toThrow(/another pipeline run is active/);
    await tick(); // let run A register its settle listener before settling
    bridge.settle();
    const finalA = await waitForStatus(engine, runA.runId, (r) => r.status === 'completed');
    expect(finalA.status).toBe('completed');
    // Idle again → a new run is accepted.
    expect(() => engine.start(oneStep, 'z', {})).not.toThrow();
  });

  it('v1a: abort racing the settle-waiter registration does not hang the run', async () => {
    const pipeline = samplePipeline({
      steps: [{ id: 's1', name: 'Go', type: 'prompt', prompt: 'work' }],
    });
    const bridge = new FakeBridge();
    const { engine } = await makeEngine(bridge);
    let runId = 'run-1';
    // send resolves, then abort fires in the same microtask turn — before the
    // engine registers its settle waiter. The waiter's synchronous status
    // check must release it instead of hanging for the whole settle timeout.
    bridge.send = (command: RpcCommand): Promise<RpcResponse> => {
      bridge.sent.push(command);
      if (command.type === 'prompt') {
        queueMicrotask(() => {
          engine.abort(runId);
        });
      }
      return Promise.resolve({ type: 'response', command: command.type, success: true });
    };
    const run = engine.start(pipeline, 'x', {});
    runId = run.runId;
    const finalRun = await waitForStatus(engine, runId, (r) => r.status === 'aborted', 3000);
    expect(finalRun.status).toBe('aborted');
    expect(finalRun.steps[0]?.status).toBe('running');
    expect(bridge.sent).toContainEqual({ type: 'abort' });
  });

  it('v1a: a match without nextOn* targets continues linearly (no silent truncation)', async () => {
    const pipeline = samplePipeline({
      steps: [
        { id: 's1', name: 'Probe', type: 'prompt', prompt: 'probe', match: 'broken' },
        { id: 's2', name: 'End', type: 'prompt', prompt: 'end' },
      ],
    });
    const bridge = new FakeBridge();
    const { engine } = await makeEngine(bridge);
    const run = engine.start(pipeline, 'x', {});
    await tick();
    bridge.assistantText('all broken');
    bridge.settle();
    await tick();
    bridge.assistantText('done');
    bridge.settle();
    const finalRun = await waitForStatus(engine, run.runId, (r) => r.status === 'completed');
    const prompts = bridge.sent
      .filter((c) => c.type === 'prompt')
      .map((c) => (c as { message: string }).message);
    expect(prompts).toEqual(['probe', 'end']);
    expect(finalRun.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('v1a: a match whose branch target is missing continues linearly', async () => {
    const pipeline = samplePipeline({
      steps: [
        {
          id: 's1',
          name: 'Probe',
          type: 'prompt',
          prompt: 'probe',
          match: 'broken',
          nextOnMatch: 'nonexistent',
        },
        { id: 's2', name: 'End', type: 'prompt', prompt: 'end' },
      ],
    });
    const bridge = new FakeBridge();
    const { engine } = await makeEngine(bridge);
    const run = engine.start(pipeline, 'x', {});
    await tick();
    bridge.assistantText('all broken'); // match hits, but the target is missing → continue
    bridge.settle();
    await tick();
    bridge.assistantText('done');
    bridge.settle();
    const finalRun = await waitForStatus(engine, run.runId, (r) => r.status === 'completed');
    const prompts = bridge.sent
      .filter((c) => c.type === 'prompt')
      .map((c) => (c as { message: string }).message);
    expect(prompts).toEqual(['probe', 'end']);
    expect(finalRun.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded']);
  });
});
