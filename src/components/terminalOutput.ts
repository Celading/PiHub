import type { RpcResponse } from '../../shared/types.js';

/** Extract the final bash output only when this command emitted no SSE chunk.
 * Pi versions differ: some stream bash_execution_update, others return the
 * complete output only in the correlated RPC response. */
export function fallbackBashOutput(
  response: RpcResponse,
  streamRevisionBefore: number,
  streamRevisionAfter: number,
): string | null {
  if (streamRevisionAfter !== streamRevisionBefore) {
    return null;
  }
  const data = response.data;
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const output = (data as Record<string, unknown>)['output'];
  return typeof output === 'string' && output.length > 0 ? output : null;
}
