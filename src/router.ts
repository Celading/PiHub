import { SETTINGS_SECTIONS, type SettingsSectionId, type View } from './types/app.js';

/**
 * Hash routing (ISSUE-20260812-PI-PANEL-CODEX-DEEP-ADAPT-ROUTING-SYSPROMPT):
 * the selected view + session survive a refresh. Grammar:
 *
 *   #/chat                       — draft tab (pi, current RPC session)
 *   #/chat/pi/<sessionFile>      — pi session tab (URL-encoded file name)
 *   #/chat/codex/<threadId>      — codex thread (resume)
 *   #/chat/claude/<id>/<label>   — claude read-only transcript
 *   #/chat/dsh                   — dsh agent chat (fresh draft tab)
 *   #/chat/dsh/<id>/<label>      — dsh session transcript (read-only)
 *   #/sessions | #/stats | #/automation
 *   #/settings/<section>
 *
 * Segments are split RAW then decoded, so encoded slashes (%2F) in file
 * names / session ids survive round-trips.
 */

export type ChatRoute =
  | { view: 'chat'; kind: 'draft' }
  | { view: 'chat'; kind: 'pi'; sessionFile: string }
  | { view: 'chat'; kind: 'codex'; threadId: string }
  | { view: 'chat'; kind: 'claude'; sessionId: string; label: string }
  | { view: 'chat'; kind: 'dsh'; sessionId: string | null; label: string };

export type Route =
  | ChatRoute
  | { view: 'sessions' }
  | { view: 'stats' }
  | { view: 'settings'; section: SettingsSectionId }
  | { view: 'automation' };

const KNOWN_SECTIONS = new Set<string>(SETTINGS_SECTIONS.map((entry) => entry.id));

/** Current chat state as an addressable route. */
export function serializeRoute(params: {
  view: View;
  agent: 'pi' | 'codex' | 'dsh' | 'claude';
  codexThread: string | null;
  claudeThread: { sessionId: string; label: string } | null;
  dshThread: { sessionId: string; label: string } | null;
  sessionFile: string | null;
  settingsSection: SettingsSectionId;
}): string {
  if (params.view === 'chat') {
    if (params.dshThread !== null) {
      return `#/chat/dsh/${encodeURIComponent(params.dshThread.sessionId)}/${encodeURIComponent(params.dshThread.label)}`;
    }
    if (params.claudeThread !== null) {
      return `#/chat/claude/${encodeURIComponent(params.claudeThread.sessionId)}/${encodeURIComponent(params.claudeThread.label)}`;
    }
    if (params.agent === 'codex' && params.codexThread !== null) {
      return `#/chat/codex/${encodeURIComponent(params.codexThread)}`;
    }
    if (params.agent === 'dsh') {
      return '#/chat/dsh';
    }
    if (params.sessionFile !== null) {
      return `#/chat/pi/${encodeURIComponent(params.sessionFile)}`;
    }
    return '#/chat';
  }
  if (params.view === 'settings') {
    return `#/settings/${params.settingsSection}`;
  }
  return `#/${params.view}`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Parses a location hash into a route; null = not a known route. */
export function parseRoute(hash: string): Route | null {
  const raw = hash.replace(/^#\/?/, '');
  if (raw.length === 0) {
    return null;
  }
  const segments = raw.split('/').map(decodeSegment);
  const head = segments[0] ?? '';
  if (head === 'chat') {
    if (segments.length === 1) {
      return { view: 'chat', kind: 'draft' };
    }
    const kind = segments[1];
    if (kind === 'pi' && segments.length >= 3) {
      const sessionFile = segments.slice(2).join('/');
      if (sessionFile.length > 0) {
        return { view: 'chat', kind: 'pi', sessionFile };
      }
    }
    if (kind === 'codex' && segments.length >= 3) {
      const threadId = segments.slice(2).join('/');
      if (threadId.length > 0) {
        return { view: 'chat', kind: 'codex', threadId };
      }
    }
    if (kind === 'claude' && segments.length >= 4) {
      const sessionId = segments[2];
      const label = segments.slice(3).join('/');
      if (sessionId !== undefined && sessionId.length > 0) {
        return { view: 'chat', kind: 'claude', sessionId, label };
      }
    }
    if (kind === 'dsh') {
      if (segments.length >= 4) {
        const sessionId = segments[2];
        const label = segments.slice(3).join('/');
        if (sessionId !== undefined && sessionId.length > 0) {
          return { view: 'chat', kind: 'dsh', sessionId, label };
        }
      }
      return { view: 'chat', kind: 'dsh', sessionId: null, label: '' };
    }
    return null;
  }
  if (head === 'sessions' || head === 'stats' || head === 'automation') {
    return { view: head };
  }
  if (head === 'settings') {
    const section = segments[1];
    return {
      view: 'settings',
      section:
        typeof section === 'string' && KNOWN_SECTIONS.has(section)
          ? (section as SettingsSectionId)
          : 'general',
    };
  }
  return null;
}
