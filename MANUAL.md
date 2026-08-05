# PiHub Manual

*Your π, connecting everything — a local web panel for the
[pi coding agent](https://pi.dev).*

> **Safety first:** PiHub listens on `127.0.0.1` / `localhost` only. It never
> reads `~/.pi/agent/auth.json`. Everything you see is on your machine.

---

## 1. Installation & first run

Requirements:

- [pi](https://pi.dev) ≥ 0.83 (`pi --version`)
- Node.js ≥ 20
- A configured model provider (pi's usual setup)

```bash
git clone <repo>/pi-panel
cd pi-panel
npm install
npm run dev
```

- Web UI: **http://localhost:18384**
- Backend: `127.0.0.1:3001` (the web page proxies `/api` to it)

Open the URL and check the header shows **服务器在线 / Server online**.
The panel spawns `pi --mode rpc` itself — you do not need a terminal open.

Production build: `npm run build` → serve `dist/` from the Node server
(`npm start`). Tests: `npm test`.

---

## 2. Interface tour

```
┌─────────────────────────────────────────────────────────────────┐
│ π PiHub · your π, connecting everything     [server status] [☾] │  header
├──────────────┬──────────────────────────────────────────────────┤
│ NEW SESSION  │  toolbar (current-session actions: clone/archive) │
│ search       │  ─────────────────────────────────────────────   │
│ / commands   │  chat stream                                      │
│ ──────────── │                                                  │
│ collections  │                                                  │
│ ungrouped    │  ─────────────────────────────────────────────   │
│  ● sessions  │  model [▾]  thinking [▾]                         │
│ ──────────── │  input …                    [♡] [send]           │
│ help ⏱ ▦ ⚙  │  model row · note: takes effect immediately       │
└──────────────┴──────────────────────────────────────────────────┘
```

- **Sidebar**: new session, search, automation palette, collections,
  session list with status lights, footer actions (help / history / stats /
  settings).
- **Resizer**: drag the vertical strip between sidebar and content to resize
  the sidebar (200–480 px, remembered). The sidebar can be collapsed from
  **Settings → Personalization → Sidebar** (reopen via the slim left bar).
- **Toolbar (top-right)**: actions for the current session — new branch
  (clone) and archive.
- **Composer**: textarea with send/steer, bookmark (favorite) button, and a
  bottom row with model + thinking selectors.

---

## 3. Chatting

### Send modes
Set in **Settings → Personalization → Send mode**:

| Mode | Behaviour |
| --- | --- |
| `Enter` (default) | Enter sends, Shift+Enter = newline |
| `⌘+Enter` | only Command+Enter sends |
| `Ctrl+Enter` | only Ctrl+Enter sends |

While the agent runs, the send button becomes **steer** — typing Enter
injects a steering message into the running task. **Esc** interrupts.

### Slash suggestions
Type `/` in the composer to open the automation / skills / workflows list.
`↑`/`↓` to move, `Tab`/`Enter` to apply `/<name> `, `Esc` to close.

### Images
Paste an image from the clipboard into the composer — it is attached to the
next prompt.

### Reasoning UI
- **Thinking states** (icons, no emoji): *thinking…* (animated, chars fade in
  sequence), *thought process…* (collapsed, click to expand), *thinking
  interrupted!* (red).
- **Workflow settlement**: when a run completes, its unit shows
  `Elapsed hh时mm分ss秒` + `>` — clicking `>` collapses the whole prompt
  workflow; a full-width divider closes the unit.
- **Simplified output** (Lab): settled workflows auto-collapse and show
  `.....` marking folded content; expand to reveal it.

---

## 4. Sessions

### Status lights
Each session shows a dot: **green** done · **cyan** running · **red**
interrupted. The current session is highlighted.

### Open & navigate
Click a session to resume it. `⌘`/`Ctrl` + `↑`/`↓` cycles sessions (the
modifier is chosen in Settings → Personalization). `Alt+2` opens the history
page; `Alt+1` returns to chat.

### Collections
Click **＋** next to *Collections* to create one, then drag sessions into it.
Rename by clicking the collection name; delete via the trash icon. Sessions
outside any collection stay under *Ungrouped*.

### Right-click menu
Right-click any session row: **Open · New branch (clone) · Archive · Delete**.

- *New branch* clones the session after switching to it (pi's clone RPC
  forks the current session). The toolbar clone button does the same for the
  current session.
- *Archive* hides the session from the sidebar; restore it under
  **Settings → Session Management**.
- *Delete* asks for confirmation, then removes the session file (guarded on
  the server against path traversal; only `.jsonl` files inside the sessions
  directory can be removed).

### Session details & tree filters
From the history page, open a session to browse its message tree with branch
navigation, rename, stats, compact, and tree filters:
**All · Mainline · No tools · User** (Labeled is reserved — no label data
yet).

---

## 5. Models & channels

### Model & thinking
The composer's bottom row holds **model** and **thinking** selects —
changes apply immediately (no save button). `Ctrl+Shift+L` cycles models.

### Custom API channels
**Settings → Models & Channels → Channels** edits
`~/.pi/agent/models.json`:

| Field | Meaning |
| --- | --- |
| Channel name (key) | provider key in `models.json` |
| Base URL | endpoint, e.g. `https://api.example.com/v1` |
| API Token | stored in `models.json` (same convention as pi) |
| API type | openai-completions / anthropic-messages / google-generative |
| Model ID / name | model identifier and display name |
| Max context | context window (tokens) |
| Max output | max output tokens |
| Details (accordion) | reasoning toggle, input types |

Click **Save** to write the file. The **Model store** section above it
lists models read-only.

---

## 6. Settings (seven areas)

| Area | Contents |
| --- | --- |
| **General** | language (中文 / English), theme (light/dark), run modes (steering / follow-up), agent settings |
| **Personalization** | user ID, sidebar expand/collapse, send mode, session-switch modifier |
| **Models & Channels** | model store (read-only), custom channels editor |
| **Session Management** | archived sessions (restore), export current session to HTML |
| **Permissions** | browser notification state/request, local-boundary notes |
| **Prompt Favorites** | manage saved prompts; run them as new prompts |
| **Lab** | streaming animation, compact tool cards, notify on settle, simplified output |

The settings view swaps the sidebar into a navigation tree — the bottom
**Back to home** button returns to chat.

### Favorites
Click the bookmark button in the composer to save the current input.
Manage and run favorites under **Settings → Prompt Favorites** (running
switches to chat and sends immediately).

---

## 7. Privacy & permissions

- The panel binds loopback addresses only.
- `~/.pi/agent/auth.json` is never read or exposed.
- Writes are limited to: conversations via pi RPC, `models.json` when you
  save channels, and panel preferences in browser localStorage.
- Browser notifications are requested only when you trigger them
  (**Permissions** area or the settle-notify Lab switch).

---

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Page shows *server offline* | ensure the backend is running (`npm run dev`); check nothing else occupies `3001` |
| Port 18384 busy | kill the stale process or change the port in `vite.config.ts` (web) — the panel frontend uses 18384 |
| "Agent is already processing" | the shared pi session is busy (another tool may be using it); wait or send as steer/follow-up |
| "This session has not been saved yet" | pi requires the session to have an assistant response before cloning |
| Model dropdown empty | check `models.json` / provider configuration in pi |
| Dev changes not visible | run the dev server with polling watchers (see `scripts/dev.mjs`, `CHOKIDAR_USEPOLLING`) |

---

## 9. Development

```bash
npm run dev        # parallel: vite (18384) + tsx watch server (3001)
npm run typecheck
npm run lint
npm test           # vitest — shared zod schemas + server session parsing
npm run build      # typecheck + lint + bundle to dist/
```

Layout: `src/` (React SPA) · `server/` (RPC bridge, REST, SSE) · `shared/`
(zod boundary schemas) · `public/` (PWA manifest, icon, service worker).

### Contributing
Open issues/PRs against the repository. The project is Apache-2.0, an
independent clean-room implementation written from scratch.

---

*PiHub — Apache License 2.0. Fonts: HarmonyOS Sans SC (Huawei) and IBM Plex
(SIL OFL); HM Symbols subset from the `hm_symbol` package.*
