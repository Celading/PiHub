import { describe, expect, it } from 'vitest';
import { isPrivateIp } from './routes.js';

describe('isPrivateIp (P2-2 SSRF guard)', () => {
  it('flags loopback / private / link-local / metadata addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '127.8.9.10',
      '10.0.0.1',
      '192.168.1.5',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.169.254', // cloud metadata
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2001:4860:4860::8888']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});
