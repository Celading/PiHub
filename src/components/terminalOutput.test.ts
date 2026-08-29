import { describe, expect, it } from 'vitest';
import type { RpcResponse } from '../../shared/types.js';
import { fallbackBashOutput } from './terminalOutput.js';

const response: RpcResponse = {
  type: 'response',
  command: 'bash',
  success: true,
  data: { output: '/workspace\n' },
};

describe('terminal response fallback', () => {
  it('returns RPC output when no SSE chunk arrived', () => {
    expect(fallbackBashOutput(response, 4, 4)).toBe('/workspace\n');
  });

  it('does not duplicate output after an SSE chunk', () => {
    expect(fallbackBashOutput(response, 4, 5)).toBeNull();
  });

  it('ignores missing output fields', () => {
    expect(
      fallbackBashOutput({ type: 'response', command: 'bash', success: true }, 0, 0),
    ).toBeNull();
  });
});
