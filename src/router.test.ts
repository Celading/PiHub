import { describe, expect, it } from 'vitest';
import { parseRoute, serializeRoute } from './router.js';
import type { SettingsSectionId, View } from './types/app.js';

interface RouteState {
  view: View;
  agent: 'pi' | 'codex' | 'dsh' | 'claude';
  codexThread: string | null;
  claudeThread: { sessionId: string; label: string } | null;
  dshThread: { sessionId: string; label: string } | null;
  sessionFile: string | null;
  settingsSection: SettingsSectionId;
}

const STATE: RouteState = {
  view: 'chat',
  agent: 'pi',
  codexThread: null,
  claudeThread: null,
  dshThread: null,
  sessionFile: null,
  settingsSection: 'general',
};

describe('hash router (refresh keeps the selected session)', () => {
  it('parses every known view', () => {
    expect(parseRoute('#/chat')).toEqual({ view: 'chat', kind: 'draft' });
    expect(parseRoute('#/sessions')).toEqual({ view: 'sessions' });
    expect(parseRoute('#/stats')).toEqual({ view: 'stats' });
    expect(parseRoute('#/automation')).toEqual({ view: 'automation' });
    expect(parseRoute('#/settings/models')).toEqual({ view: 'settings', section: 'models' });
  });

  it('defaults unknown settings sections to general', () => {
    expect(parseRoute('#/settings/nope')).toEqual({ view: 'settings', section: 'general' });
    expect(parseRoute('#/settings')).toEqual({ view: 'settings', section: 'general' });
  });

  it('parses pi/codex/claude chat routes', () => {
    expect(parseRoute('#/chat/pi/foo%2Fbar.ses')).toEqual({
      view: 'chat',
      kind: 'pi',
      sessionFile: 'foo/bar.ses',
    });
    expect(parseRoute('#/chat/codex/019ff46e-abc')).toEqual({
      view: 'chat',
      kind: 'codex',
      threadId: '019ff46e-abc',
    });
    expect(parseRoute('#/chat/claude/proj%2Fabc/My%20transcript')).toEqual({
      view: 'chat',
      kind: 'claude',
      sessionId: 'proj/abc',
      label: 'My transcript',
    });
    expect(parseRoute('#/chat/dsh')).toEqual({ view: 'chat', kind: 'dsh', sessionId: null, label: '' });
    expect(parseRoute('#/chat/dsh/sess-abc/My%20run')).toEqual({
      view: 'chat',
      kind: 'dsh',
      sessionId: 'sess-abc',
      label: 'My run',
    });
  });

  it('rejects unknown hashes', () => {
    expect(parseRoute('')).toBeNull();
    expect(parseRoute('#')).toBeNull();
    expect(parseRoute('#/nope')).toBeNull();
    expect(parseRoute('#/chat/pi')).toBeNull();
    expect(parseRoute('#/chat/unknown/x')).toBeNull();
    // malformed percent-encoding is kept as the raw segment, not a crash
    expect(parseRoute('#/chat/pi/%E0%A4%A')).toEqual({
      view: 'chat',
      kind: 'pi',
      sessionFile: '%E0%A4%A',
    });
  });

  it('serializes the current state back into an addressable hash', () => {
    expect(serializeRoute(STATE)).toBe('#/chat');
    expect(serializeRoute({ ...STATE, view: 'stats' })).toBe('#/stats');
    expect(serializeRoute({ ...STATE, view: 'settings', settingsSection: 'about' })).toBe(
      '#/settings/about',
    );
    expect(
      serializeRoute({ ...STATE, sessionFile: 'foo/bar.ses' }),
    ).toBe('#/chat/pi/foo%2Fbar.ses');
    expect(
      serializeRoute({ ...STATE, agent: 'codex', codexThread: '019ff46e-abc' }),
    ).toBe('#/chat/codex/019ff46e-abc');
    expect(
      serializeRoute({
        ...STATE,
        claudeThread: { sessionId: 'proj/abc', label: 'My transcript' },
      }),
    ).toBe('#/chat/claude/proj%2Fabc/My%20transcript');
    expect(serializeRoute({ ...STATE, agent: 'dsh' })).toBe('#/chat/dsh');
    expect(
      serializeRoute({
        ...STATE,
        agent: 'dsh',
        dshThread: { sessionId: 'sess-abc', label: 'My run' },
      }),
    ).toBe('#/chat/dsh/sess-abc/My%20run');
  });

  it('round-trips canonical routes', () => {
    for (const hash of [
      '#/chat',
      '#/chat/pi/a%2Fb.ses',
      '#/chat/codex/019ff46e-abc',
      '#/chat/claude/p%2Fq/My%20label',
      '#/chat/dsh',
      '#/chat/dsh/sess-abc/My%20run',
      '#/sessions',
      '#/settings/lab',
      '#/automation',
    ]) {
      const route = parseRoute(hash);
      expect(route).not.toBeNull();
      if (route === null) {
        continue;
      }
      expect(serializeRoute(hashToState(hash))).toBe(hash);
    }
  });
});

/** Rebuild the serialize input from a hash (route → state → hash). */
function hashToState(hash: string): RouteState {
  const route = parseRoute(hash);
  if (route === null) {
    return { ...STATE };
  }
  if (route.view === 'chat') {
    if (route.kind === 'pi') {
      return { ...STATE, sessionFile: route.sessionFile };
    }
    if (route.kind === 'codex') {
      return { ...STATE, agent: 'codex', codexThread: route.threadId };
    }
    if (route.kind === 'claude') {
      return { ...STATE, claudeThread: { sessionId: route.sessionId, label: route.label } };
    }
    if (route.kind === 'dsh') {
      return {
        ...STATE,
        agent: 'dsh',
        dshThread:
          route.sessionId !== null ? { sessionId: route.sessionId, label: route.label } : null,
      };
    }
    return { ...STATE };
  }
  return {
    ...STATE,
    view: route.view,
    settingsSection: route.view === 'settings' ? route.section : STATE.settingsSection,
  };
}
