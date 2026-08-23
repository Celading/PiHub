import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DshAdapter } from './dsh-adapter.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pihub-dsh-'));
  tempDirs.push(dir);
  return dir;
}

describe('dsh adapter (headless kernel)', () => {
  it('captures the final answer from a successful headless task', async () => {
    const dir = await makeDir();
    const stub = path.join(dir, 'stub.mjs');
    await writeFile(stub, 'console.log("final answer here");\n', 'utf8');
    const adapter = new DshAdapter({ binaryPath: stub, cwd: dir });
    const response = await adapter.send({ type: 'prompt', message: 'hi' });
    expect(response.success).toBe(true);
    const data = response.data as { answer: string };
    expect(data.answer).toBe('final answer here');
    const messages = adapter.getMessages();
    expect(messages.some((m) => m.role === 'user')).toBe(true);
    expect(messages.some((m) => m.role === 'assistant' && m.content[0]?.text === 'final answer here')).toBe(true);
  });

  it('reports a non-zero exit honestly with the stderr tail', async () => {
    const dir = await makeDir();
    const stub = path.join(dir, 'fail.mjs');
    await writeFile(stub, 'console.error("profile not configured");\nprocess.exit(1);\n', 'utf8');
    const adapter = new DshAdapter({ binaryPath: stub, cwd: dir });
    const response = await adapter.send({ type: 'prompt', message: 'hi' });
    expect(response.success).toBe(false);
    expect(response.error).toContain('exit 1');
    expect(response.error).toContain('profile not configured');
  });

  it('refuses a second task while one is still running', async () => {
    const dir = await makeDir();
    const stub = path.join(dir, 'slow.mjs');
    await writeFile(
      stub,
      'await new Promise((r) => setTimeout(r, 400));\nconsole.log("done");\n',
      'utf8',
    );
    const adapter = new DshAdapter({ binaryPath: stub, cwd: dir });
    const first = adapter.send({ type: 'prompt', message: 'one' });
    const second = await adapter.send({ type: 'prompt', message: 'two' });
    expect(second.success).toBe(false);
    expect(second.error).toContain('still running');
    const firstResponse = await first;
    expect(firstResponse.success).toBe(true);
    expect(adapter.isRunning()).toBe(false);
  });

  it('abort interrupts a running task (SIGINT)', async () => {
    const dir = await makeDir();
    const stub = path.join(dir, 'abortable.mjs');
    await writeFile(
      stub,
      'process.on("SIGINT", () => { console.log("interrupted"); process.exit(130); });\n' +
        'setInterval(() => {}, 1000);\n',
      'utf8',
    );
    const adapter = new DshAdapter({ binaryPath: stub, cwd: dir });
    const task = adapter.send({ type: 'prompt', message: 'long' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(adapter.isRunning()).toBe(true);
    const abort = await adapter.send({ type: 'abort' });
    expect(abort.success).toBe(true);
    const response = await task;
    expect(response.success).toBe(false);
  });
});
