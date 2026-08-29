/**
 * Draft targeting for a NEW session (chosen folder + agent), persisted so a
 * reload keeps the user's last choice. The new-session dialog writes it; the
 * chat layer reads it to route codex prompts to the chosen folder.
 */

export type SessionMode = 'workspace' | 'chat';
export type SessionServiceTarget = 'builtin-pihub' | 'local-service' | 'remote-pihub' | 'nearby-pihub';

export interface SessionDraft {
  /** Empty in chat-only mode (no workspace). */
  cwd: string;
  agent: 'pi' | 'codex' | 'dsh' | 'claude';
  serviceTarget: SessionServiceTarget;
  mode?: SessionMode;
}

const DRAFT_KEY = 'pi-panel:session-draft';

export function loadSessionDraft(): SessionDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record['cwd'] !== 'string' || (record['agent'] !== 'pi' && record['agent'] !== 'codex' && record['agent'] !== 'dsh' && record['agent'] !== 'claude')) {
      return null;
    }
    const mode = record['mode'] === 'chat' ? 'chat' : 'workspace';
    const serviceTarget =
      record['serviceTarget'] === 'local-service' || record['serviceTarget'] === 'remote-pihub' || record['serviceTarget'] === 'nearby-pihub'
        ? record['serviceTarget']
        : 'builtin-pihub';
    return { cwd: record['cwd'], agent: record['agent'], serviceTarget, mode };
  } catch {
    return null;
  }
}

export function saveSessionDraft(draft: SessionDraft): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // storage unavailable — in-memory choice still applies this session
  }
}
