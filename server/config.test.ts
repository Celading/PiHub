import { describe, expect, it } from 'vitest';
import { effectiveServerConfig, parseToml } from './config.js';

describe('P1-08c config.toml parsing', () => {
  it('parses sections, strings, numbers and booleans', () => {
    const cfg = parseToml(`# PiHub config
[server]
port = 4000
host = "127.0.0.1"
url = 'http://localhost:4000'

[other]
enabled = true
`);
    expect(cfg.server.port).toBe(4000);
    expect(cfg.server.host).toBe('127.0.0.1');
    expect(cfg.server.url).toBe('http://localhost:4000');
  });

  it('ignores comments, blank lines and unknown keys', () => {
    const cfg = parseToml(`# leading comment
[server]
# port comment
port = 8080
weird = [1, 2, 3]
`);
    expect(cfg.server.port).toBe(8080);
    expect(cfg.server.host).toBeUndefined();
  });

  it('returns empty config for garbage and missing sections', () => {
    expect(parseToml('not toml at all ===')).toEqual({ server: {} });
    expect(parseToml('')).toEqual({ server: {} });
  });

  it('effective config precedence: env PIHUB_PORT > PORT > file > mode default', () => {
    const previousPihub = process.env.PIHUB_PORT;
    const previousPort = process.env.PORT;
    try {
      delete process.env.PIHUB_PORT;
      delete process.env.PORT;
      expect(effectiveServerConfig({ server: {} }, 'production').port).toBe(18_384);
      expect(effectiveServerConfig({ server: {} }, 'debug').port).toBe(3_001);
      expect(effectiveServerConfig({ server: {} }, 'demo').port).toBe(18_384);
      expect(effectiveServerConfig({ server: { port: 4000 } }).port).toBe(4000);
      process.env.PORT = '5000';
      expect(effectiveServerConfig({ server: { port: 4000 } }).port).toBe(5000);
      process.env.PIHUB_PORT = '6000';
      expect(effectiveServerConfig({ server: { port: 4000 } }).port).toBe(6000);
    } finally {
      if (previousPihub === undefined) {
        delete process.env.PIHUB_PORT;
      } else {
        process.env.PIHUB_PORT = previousPihub;
      }
      if (previousPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = previousPort;
      }
    }
  });

  it('derives the url from host and port when not configured', () => {
    const cfg = effectiveServerConfig({ server: { port: 4000 } });
    expect(cfg.url).toBe('http://127.0.0.1:4000');
    const withUrl = effectiveServerConfig({ server: { url: 'http://proxy:9' } });
    expect(withUrl.url).toBe('http://proxy:9');
  });

  it('uses port 3001 only when debug mode is explicit', () => {
    expect(effectiveServerConfig({ server: {} }, 'production')).toEqual({
      port: 18_384,
      host: '127.0.0.1',
      url: 'http://127.0.0.1:18384',
    });
    expect(effectiveServerConfig({ server: {} }, 'debug')).toEqual({
      port: 3_001,
      host: '127.0.0.1',
      url: 'http://127.0.0.1:3001',
    });
  });
});
