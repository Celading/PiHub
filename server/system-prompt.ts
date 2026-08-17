import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Settings system prompt (ISSUE-20260812-PI-PANEL-CODEX-DEEP-ADAPT-ROUTING-
 * SYSPROMPT): a PiHub-managed prompt stored in the PiHub home
 * (`<home>/system-prompt.md` — the designated space for PiHub-owned data),
 * appended to pi's default coding assistant prompt via
 * `--append-system-prompt` on the next bridge spawn. Saving restarts the pi
 * runtime through the same idle/deferred path the model-config reload uses.
 */

export const SYSTEM_PROMPT_FILE = 'system-prompt.md';
const MAX_PROMPT_BYTES = 64 * 1024;

export interface SystemPromptStore {
  get: () => Promise<string>;
  save: (prompt: string) => Promise<{ success: boolean; error?: string }>;
}

export function createSystemPromptStore(options: {
  home: string;
  /** Restart the pi runtime (restart-now or deferred-until-settle). */
  reload: () => 'reloaded' | 'deferred';
}): SystemPromptStore {
  const file = path.join(options.home, SYSTEM_PROMPT_FILE);
  return {
    async get() {
      try {
        return await readFile(file, 'utf8');
      } catch {
        return '';
      }
    },
    async save(prompt) {
      if (prompt.length > MAX_PROMPT_BYTES) {
        return { success: false, error: 'system prompt too large (64KB max)' };
      }
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, prompt, 'utf8');
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      options.reload();
      return { success: true };
    },
  };
}
