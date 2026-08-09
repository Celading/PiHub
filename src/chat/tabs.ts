/**
 * Multi-tab chat workspace (P1-06). Each tab either owns a bound RPC session
 * file or is the draft tab (sessionFile === null) that follows whatever
 * session the RPC process currently has. The RPC session pool stays a single
 * instance — tabs are UI-level parallelism: activating a tab whose bound
 * session differs from the RPC's current one switches sessions first, then
 * remounts that tab's chat. Per-tab isolation comes from keying the ChatPage
 * instance with the tab id, so message flow, composer and preview state never
 * leak across tabs.
 */

export interface ChatTab {
  /** Stable identity used as React key and tab-bar selection handle. */
  id: string;
  /** Bound RPC session file name, or null for the draft tab. */
  sessionFile: string | null;
  /** Display label (session name or the localized draft label). */
  label: string;
}

let tabCounter = 0;

/** Tab ids need no crypto dependency (headless demo Chrome included). */
export function newTabId(): string {
  tabCounter += 1;
  return `tab-${Date.now().toString(36)}-${tabCounter.toString(36)}`;
}

/** The draft tab (bound to no session); at most one exists per workspace. */
export function findDraftTab(tabs: ReadonlyArray<ChatTab>): ChatTab | undefined {
  return tabs.find((tab) => tab.sessionFile === null);
}
