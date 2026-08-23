/**
 * Minimal zero-dependency MCP server (Model Context Protocol) exposing the
 * PiHub pipeline substrate to hosts like dsh (DeepSeek Harness).
 *
 * JSON-RPC 2.0 over stdio, newline-delimited frames — same framing
 * discipline as rpc-bridge (split on '\n' only, never readline; U+2028/29
 * are valid inside JSON strings).
 *
 * Protocol surface implemented: initialize, notifications/initialized,
 * ping, tools/list, tools/call. Everything else returns a JSON-RPC error.
 */
import type { PipelineRunRecord } from '../shared/types.js';

/** Backend surface the MCP server drives (wired in server/index.ts). */
export interface McpToolHandler {
  runPipeline(
    pipelineId: string,
    input: string,
  ): { ok: true; run: PipelineRunRecord } | { ok: false; error: string };
  abortRun(runId: string): boolean;
  approveRun(runId: string, approve: boolean): boolean;
  listPipelines(): Array<{ id: string; name: string; stepCount: number }>;
  listReceipts(pipelineId: string): unknown[];
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TOOLS = [
  {
    name: 'pipeline_run',
    description:
      'Start a pipeline run. Runs are serialized (one active run at a time); a busy engine is an error.',
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string' },
        input: { type: 'string' },
      },
      required: ['pipelineId'],
    },
  },
  {
    name: 'pipeline_abort',
    description: 'Abort a running pipeline run.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
    },
  },
  {
    name: 'pipeline_approve',
    description: 'Answer an awaiting-approval step (approve: boolean).',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' }, approve: { type: 'boolean' } },
      required: ['runId', 'approve'],
    },
  },
  {
    name: 'pipelines_list',
    description: 'List pipeline definitions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'receipts_list',
    description: 'List typed audit receipts for a pipeline (newest first).',
    inputSchema: {
      type: 'object',
      properties: { pipelineId: { type: 'string' } },
      required: ['pipelineId'],
    },
  },
];

const textContent = (text: string): { type: 'text'; text: string } => ({ type: 'text', text });

export class McpServer {
  private buffer = '';
  private initialized = false;

  constructor(private readonly tools: McpToolHandler) {}

  /** Starts reading stdin frames and writing responses to stdout. */
  start(): void {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.length > 0) {
          const response = this.handleFrame(line);
          if (response !== null) {
            process.stdout.write(`${response}\n`);
          }
        }
        index = this.buffer.indexOf('\n');
      }
    });
    // The MCP host owns the lifecycle: stdin EOF shuts the server down.
    process.stdin.on('end', () => {
      process.exit(0);
    });
  }

  /** Pure frame handler (unit-testable): one response line, or null for
   *  notifications / malformed frames. */
  handleFrame(line: string): string | null {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return null;
    }
    if (request.method === 'notifications/initialized') {
      return null;
    }
    const id = request.id ?? null;
    if (request.method === 'initialize') {
      this.initialized = true;
      return this.serialize({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'pihub', version: '0.3.0' },
        },
      });
    }
    if (request.method === 'ping') {
      return this.serialize({ jsonrpc: '2.0', id, result: {} });
    }
    if (!this.initialized) {
      return this.serialize({
        jsonrpc: '2.0',
        id,
        error: { code: -32002, message: 'server not initialized' },
      });
    }
    if (request.method === 'tools/list') {
      return this.serialize({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    }
    if (request.method === 'tools/call') {
      const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === 'string' ? params.name : '';
      const args =
        typeof params.arguments === 'object' && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {};
      return this.serialize(this.callTool(id, name, args));
    }
    return this.serialize({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `method not found: ${request.method}` },
    });
  }

  private callTool(
    id: number | string | null,
    name: string,
    args: Record<string, unknown>,
  ): JsonRpcResponse {
    const base: JsonRpcResponse = { jsonrpc: '2.0', id };
    try {
      switch (name) {
        case 'pipeline_run': {
          const pipelineId = typeof args['pipelineId'] === 'string' ? args['pipelineId'] : '';
          const input = typeof args['input'] === 'string' ? args['input'] : '';
          if (pipelineId.length === 0) {
            return { ...base, error: { code: -32602, message: 'pipelineId required' } };
          }
          const out = this.tools.runPipeline(pipelineId, input);
          return out.ok
            ? { ...base, result: { content: [textContent(JSON.stringify(out.run))] } }
            : { ...base, error: { code: 1, message: out.error } };
        }
        case 'pipeline_abort': {
          const runId = typeof args['runId'] === 'string' ? args['runId'] : '';
          const ok = runId.length > 0 && this.tools.abortRun(runId);
          return { ...base, result: { content: [textContent(JSON.stringify({ ok }))] } };
        }
        case 'pipeline_approve': {
          const runId = typeof args['runId'] === 'string' ? args['runId'] : '';
          const approve = args['approve'] === true;
          const ok = runId.length > 0 && this.tools.approveRun(runId, approve);
          return { ...base, result: { content: [textContent(JSON.stringify({ ok }))] } };
        }
        case 'pipelines_list':
          return {
            ...base,
            result: { content: [textContent(JSON.stringify(this.tools.listPipelines()))] },
          };
        case 'receipts_list': {
          const pipelineId = typeof args['pipelineId'] === 'string' ? args['pipelineId'] : '';
          return {
            ...base,
            result: { content: [textContent(JSON.stringify(this.tools.listReceipts(pipelineId)))] },
          };
        }
        default:
          return { ...base, error: { code: -32601, message: `unknown tool: ${name}` } };
      }
    } catch (error) {
      return {
        ...base,
        error: { code: 1, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  private serialize(response: JsonRpcResponse): string {
    return JSON.stringify(response);
  }
}
