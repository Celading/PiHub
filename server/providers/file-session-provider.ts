import { createSessionStore } from '../sessions.js';
import type { SessionStore } from '../sessions.js';

/**
 * SessionProvider is the kMode data-source abstraction: production/debug
 * use the real ~/.pi file store, demo uses the in-memory mock store. The
 * routes layer only depends on this interface (KMODE-001 K1).
 */
export type SessionProvider = SessionStore;

export function createFileSessionProvider(dir?: string): SessionProvider {
  return createSessionStore(dir);
}
