import { describe, expect, it } from 'vitest';
import { McpServer, type McpToolHandler } from './mcp.js';

function fakeTools(): McpToolHandler {
  return {
    runPipeline: (pipelineId: string, input: string) =>
      pipelineId === 'missing'
        ? { ok: false, error: 'pipeline not found' }
        : {
            ok: true,
            run: {
              runId: 'run-test-1',
              pipelineId,
              pipelineName: 'Test',
              status: 'running',
              input,
              startedAt: 1,
              steps: [],
            },
          },
    abortRun: () => true,
    approveRun: () => true,
    listPipelines: () => [{ id: 'p1', name: 'Refactor HTML', stepCount: 3 }],
    listReceipts: () => [{ runId: 'run-1', status: 'completed' }],
  };
}

const frame = (method: string, id: number, params?: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

describe('MCP server (zero-dependency stdio bridge)', () => {
  it('handshakes initialize and answers ping', () => {
    const srv = new McpServer(fakeTools());
    const init = JSON.parse(srv.handleFrame(frame('initialize', 1, {})) ?? '') as {
      result: { serverInfo: { name: string }; protocolVersion: string };
    };
    expect(init.result.serverInfo.name).toBe('pihub');
    expect(init.result.protocolVersion).toBe('2024-11-05');
    const ping = JSON.parse(srv.handleFrame(frame('ping', 2)) ?? '') as { result: unknown };
    expect(ping.result).toEqual({});
    // notifications produce no response
    expect(srv.handleFrame(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBeNull();
  });

  it('lists the five tools after initialization', () => {
    const srv = new McpServer(fakeTools());
    srv.handleFrame(frame('initialize', 1, {}));
    const list = JSON.parse(srv.handleFrame(frame('tools/list', 2)) ?? '') as {
      result: { tools: Array<{ name: string }> };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual([
      'pipeline_run',
      'pipeline_abort',
      'pipeline_approve',
      'pipelines_list',
      'receipts_list',
    ]);
  });

  it('rejects tool calls before initialize', () => {
    const srv = new McpServer(fakeTools());
    const resp = JSON.parse(srv.handleFrame(frame('tools/list', 1)) ?? '') as {
      error: { code: number };
    };
    expect(resp.error.code).toBe(-32002);
  });

  it('calls pipeline_run through the handler and returns the run record', () => {
    const srv = new McpServer(fakeTools());
    srv.handleFrame(frame('initialize', 1, {}));
    const resp = JSON.parse(
      srv.handleFrame(
        frame('tools/call', 2, { name: 'pipeline_run', arguments: { pipelineId: 'p1', input: 'x' } }),
      ) ?? '',
    ) as { result: { content: Array<{ type: string; text: string }> } };
    const run = JSON.parse(resp.result.content[0]?.text ?? '') as { runId: string; pipelineId: string };
    expect(run.runId).toBe('run-test-1');
    expect(run.pipelineId).toBe('p1');
  });

  it('surfaces handler errors as tool errors', () => {
    const srv = new McpServer(fakeTools());
    srv.handleFrame(frame('initialize', 1, {}));
    const resp = JSON.parse(
      srv.handleFrame(
        frame('tools/call', 2, { name: 'pipeline_run', arguments: { pipelineId: 'missing' } }),
      ) ?? '',
    ) as { error: { code: number; message: string } };
    expect(resp.error.code).toBe(1);
    expect(resp.error.message).toBe('pipeline not found');
  });

  it('rejects unknown methods and unknown tools', () => {
    const srv = new McpServer(fakeTools());
    srv.handleFrame(frame('initialize', 1, {}));
    const unknownMethod = JSON.parse(srv.handleFrame(frame('bogus', 2)) ?? '') as {
      error: { code: number };
    };
    expect(unknownMethod.error.code).toBe(-32601);
    const unknownTool = JSON.parse(
      srv.handleFrame(frame('tools/call', 3, { name: 'bogus_tool' })) ?? '',
    ) as { error: { code: number } };
    expect(unknownTool.error.code).toBe(-32601);
  });
});
