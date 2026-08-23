import { describe, expect, it, vi } from 'vitest';
import type { DshWebClient, DshWebMuxEvent } from './dsh-web-client.js';
import { DEFAULT_DSH_WEB_URL, DshWebRuntime, parsePendingApproval } from './dsh-web-runtime.js';

function fakeClient(
  describeValue: unknown,
  eventError?: (emit: (error: Error) => void) => void,
): DshWebClient {
  return {
    describe: vi.fn().mockResolvedValue({ ok: true, value: describeValue }),
    openEvents: vi.fn((
      _onFrame: (frame: DshWebMuxEvent, rpcId: string) => void,
      onError?: (error: Error) => void,
    ) => {
      if (eventError !== undefined && onError !== undefined) {
        eventError(onError);
      }
      return vi.fn();
    }),
  } as unknown as DshWebClient;
}

describe('DshWebRuntime', () => {
  it('uses the current DSH local web default', () => {
    expect(DEFAULT_DSH_WEB_URL).toBe('http://127.0.0.1:3080');
  });

  it('reports connected only after a compatible host.describe probe', async () => {
    const client = fakeClient({
      version: '0.0.1',
      cwd: '/workspace',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      attachedSessions: 25,
      canOpenPath: true,
    });
    const runtime = new DshWebRuntime({
      onFrame: () => undefined,
      clientFactory: () => client,
    });
    const result = await runtime.connect('http://127.0.0.1:3080/');
    expect(result.ok).toBe(true);
    expect(runtime.status()).toMatchObject({
      connected: true,
      state: 'connected',
      url: 'http://127.0.0.1:3080',
      protocol: 'dsh-web-rpc-v1',
      describe: { version: '0.0.1', attachedSessions: 25 },
      lastError: null,
    });
  });

  it('rejects a nominal success with an incompatible describe payload', async () => {
    const runtime = new DshWebRuntime({
      onFrame: () => undefined,
      clientFactory: () => fakeClient({ version: '0.0.1' }),
    });
    const result = await runtime.connect(DEFAULT_DSH_WEB_URL);
    expect(result.ok).toBe(false);
    expect(runtime.status().connected).toBe(false);
    expect(runtime.status().lastError).toContain('incompatible');
  });

  it('normalizes approval frames for polling clients', () => {
    expect(parsePendingApproval({
      type: 'session/event',
      sessionId: 'session-1',
      event: {
        type: 'approval/requested',
        data: { approvalId: 'approval-1', summary: '运行命令' },
      },
    }, 'rpc-1')).toEqual(expect.objectContaining({
      rpcId: 'rpc-1',
      sessionId: 'session-1',
      approvalId: 'approval-1',
      summary: '运行命令',
    }));
  });
});
