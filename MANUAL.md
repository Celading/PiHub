# PiHub Manual

*Your π, connecting everything — a local web panel for the
[pi coding agent](https://pi.dev).*

**English** · [中文版](MANUAL.zh-CN.md)

> **Safety first:** PiHub listens on `127.0.0.1` / `localhost` only. It never
> reads `~/.pi/agent/auth.json`. Everything you see is on your machine.
> Optional LAN access is off by default — see §12.

---

## 1. Installation & first run

Requirements:

- [pi](https://pi.dev) ≥ 0.83 (`pi --version`)
- Node.js ≥ 20
- A configured model provider (pi's usual setup)

```bash
git clone https://github.com/HapPub/PiHub.git
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

> **Why 18384 vs 3001?** 18384 is the Vite dev-server port only (chapter 14:
> `npm run dev` shows the UI at http://localhost:18384, proxying `/api` to
> the backend on 127.0.0.1:3001). The packaged `pihub`/`npm start` build is
> a single process: the Node server hosts the UI itself, defaulting to port
> **3001**.

### Port

The server binds to `127.0.0.1` only. Change the port with:

```bash
PIHUB_PORT=4000 pihub        # packaged CLI
PIHUB_PORT=4000 npm start    # from source
```

`PIHUB_PORT` takes precedence over the generic `PORT` env var (which many
deployment platforms inject automatically). The About section in Settings
always shows the port you are actually on.

### Configuration & data home

Every PiHub-owned artifact (config, stored data, databases, hardcoded
content) lives under ONE dedicated home, resolved in this order:

1. `$PIHUB_HOME` — explicit override,
2. `~/.pihub` — default,
3. `./itData` — runtime directory, used when the primary home cannot be
   created or written (no permission).

`<home>/config.toml` holds the server options (TOML subset):

```toml
# PiHub config — dedicated home: ~/.pihub (fallback ./itData)
[server]
port = 4000            # number — overridden by PIHUB_PORT/PORT env
host = "127.0.0.1"     # bind host
url = "http://127.0.0.1:4000"  # optional display/base url (derived by default)
```

The Settings → About section shows the resolved data home and config file.
Nothing PiHub-owned is ever written into `~/.pi`.

### Versions

PiHub follows [Semantic Versioning](https://semver.org/). The changelog
([`CHANGELOG.md`](CHANGELOG.md)) documents every release; user-facing
release notes templates and community materials live in
[`docs/`](docs/release-notes-template.md).

---

## 2. Interface tour

```
┌─────────────────────────────────────────────────────────────────┐
│ π PiHub · your π, connecting everything     [server status] [☾] │  header
├──────────────┬──────────────────────────────────────────────────┤
│ NEW SESSION  │  ▎tab 1 ✕  ▎tab 2 ✕  ▎+        (multi-tab strip) │
│ search       │  ─────────────────────────────────────────────   │
│ / commands   │  toolbar (current-session actions: clone/archive) │
│ ──────────── │  chat stream                                      │
│ collections  │                                                  │
│ ungrouped    │  ─────────────────────────────────────────────   │
│  ● sessions  │  model [▾]  thinking [▾]                         │
│ ──────────── │  input …                    [♡] [send]           │
│ help ⏱ ▦ ⚙  │  model row · note: takes effect immediately       │
└──────────────┴──────────────────────────────────────────────────┘
```

- **Header**: brand, server status, theme toggle (☾), menu (mobile).
- **Sidebar**: new session, search, automation palette, collections,
  session list with status lights, footer actions (help / history / stats /
  settings).
- **Resizer**: drag the vertical strip between sidebar and content to resize
  the sidebar (200–480 px, remembered). The sidebar can be collapsed from
  **Settings → Personalization → Sidebar** (reopen via the slim left bar).
- **Multi-tab strip**: one tab per open conversation (§4). The active tab is
  marked with the primary-color underline; close any tab with ✕, add one
  with +.
- **Toolbar (top-right)**: actions for the current session — new branch
  (clone) and archive.
- **Composer**: textarea with send/steer, bookmark (favorite) button, and a
  bottom row with model + thinking selectors.

### View switching (keyboard)

| Shortcut | Action |
| --- | --- |
| `Alt+1` | chat |
| `Alt+2` | sessions history |
| `Alt+3` | statistics & costs |
| `Alt+4` | settings |
| `Alt+5` | automation center |
| `Esc` | interrupt the running agent |
| `Ctrl+Shift+M` | automation / skills / workflows palette |
| `Ctrl+Shift+L` | cycle model |
| `⌘`/`Ctrl` + `↑`/`↓` | switch session (modifier in Settings) |

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

### Branching
From the toolbar (**new branch**) or the right-click menu on a session
(**new branch**), PiHub clones the current conversation after switching to
it — the new branch starts from your latest user message, with an alias
derived from the parent (`新支源自{旧 alias}`).

---

## 4. Multi-tab workspace

Sessions open in **parallel tabs** at the top of the chat view:

- **Open or switch**: clicking any session in the sidebar opens it in a new
  tab — or, if it is already open, switches to that tab.
- **Isolation**: every tab keeps its own message stream, composer draft and
  preview state. Only the active tab is live; switching tabs reloads that
  tab's conversation.
- **Draft tab**: the unbound tab (labelled *新会话 / New chat*) follows
  whatever session the RPC process currently holds — a fresh chat after
  *New session*, or the active session after you switch via the sidebar
  shortcuts. There is at most one draft tab.
- **Close**: ✕ on a tab closes it; closing the active tab activates its
  neighbour. Closing every tab creates a fresh draft tab — the workspace is
  never left tab-less.
- **New tab**: the `+` button (or *New session* anywhere) opens a draft tab
  and starts a new conversation in it.

> **Note on parallelism**: the pi session pool remains a single instance —
  one session is active at a time. Tabs are UI-level parallelism: activating
  a tab whose session differs from the current one switches the session
  first, then shows its conversation. Two tabs never send prompts to two
  sessions simultaneously.

---

## 5. Sessions

### Status lights
Each session shows a dot: **green** done · **cyan** running · **red**
interrupted. The current session is highlighted. A blinking dot means a
pending request (e.g. an approval dialog waiting).

### Open & navigate
Click a session to open it in a tab (§4). `⌘`/`Ctrl` + `↑`/`↓` cycles
sessions (the modifier is chosen in Settings → Personalization). `Alt+2`
opens the history page; `Alt+1` returns to chat.

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

### Session tree view
The details page offers a **tree view** toggle: the conversation rendered as
a branch timeline — a vertical mainline with side branches indented, role
glyphs (user / assistant / tool / branch), timestamps and summaries. Click
the fork icon on a mainline user message to **fork** it (reuses the
standard branch flow; the new branch keeps the traditional alias prefix).

---

## 6. Statistics & costs

The stats view (`Alt+3`) aggregates token usage and spend across sessions,
entirely from local session records:

- **Cost share** by model provider and by directory (horizontal share bars)
- **Daily trend** — cost per day (UTC day boundary), for the last days
- **Top sessions** — the most expensive sessions (tokens + cost)
- **Token totals** per directory (input / output / cache)
- Global and per-session totals (also visible on the history page)

All charts are zero-dependency SVG — they follow the light/dark theme and
render without any network call. Empty states show a hint instead of an
empty axis.

---

## 7. File workbench

While an agent works, files it reads, writes, edits or patches are tracked:

- **Clickable paths**: file paths in tool output become links — click to
  preview the file.
- **Read-only preview**: an overlay shows the file content. Preview is
  restricted to the active session's working directory (whitelist follows
  the session you switched to; symlinks escaping the workspace are rejected).
- **Inline diffs**: previews with a unified diff highlight added/removed
  lines with +/- marks.
- **Recent files strip**: the last read / write / edit / patch calls,
  deduplicated, one click to preview.

The workbench is read-only — PiHub never writes files on your behalf.

---

## 8. Automation center

The automation center (`Alt+5` or the sidebar entry) is the built-in
workflow surface. It has three tabs:

### Skills
The full command directory — skills, prompt templates and extension
commands — with search and one-click run. Typing `/` in the composer offers
the same suggestions live.

### Automation
Live switches that are sent to the agent session:

- **Auto-compaction** and **auto-retry**
- **Steering / follow-up modes** (including the parallel follow-up queue)

### Pipelines
**Pipelines are PiHub-exclusive multi-step orchestration** — pi itself has
no equivalent surface:

- A pipeline is a declared sequence of steps: `prompt` / `steer` /
  `approval` / `setModel` / `setThinking`, executed on one pi session
- **Match branching**: a step can branch on the agent's reply
- **Error strategies**: what to do when a step fails (stop / retry /
  continue)
- **Human approval gates**: a step with `requiresApproval` pauses the run
  and asks for approval in the UI; the prompt is only sent after you approve
- **Live timeline**: every run streams its step-by-step progress via SSE;
  you can abort a running pipeline
- **Skill import**: convert any skill into a pipeline — algorithmic
  conversion (zero tokens) or agent-assisted conversion (token-gated,
  confirmed before it runs)

Pipelines run on the same RPC session as your chat, so pipeline runs,
approvals and steering all share one conversation.

---

## 9. Models & channels

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
lists models read-only (including their configured cost data).

---

## 10. Multi-agent visibility

PiHub shows **read-only session views for other agent CLIs** installed on
the same machine, so you can find past work without switching tools:

| Adapter | What is shown | Source |
| --- | --- | --- |
| **Codex** | session history and per-session message/usage details (rollout records) | `~/.codex/sessions` |
| **AtomCode** | session history with messages and datalog entries | `~/.atomcode/history.json` |
| **ZCode** | model I/O records with usage, duration and turn ids | `~/.zcode/cli/rollout/` |

- Each adapter has its **own accent color** in the sessions list; override
  the colors in **Settings → Appearance**.
- Codex is **never spawned** by the panel; the optional `exec` integration
  is opt-in and streams JSONL events without disturbing a running Codex.
- Credential files (`auth.json`, `auth.toml`) are never read; redacted
  fields are never rendered.

---

## 11. Settings

The settings view swaps the sidebar into a navigation tree — the bottom
**Back to home** button returns to chat.

| Area | Contents |
| --- | --- |
| **General** | language (中文 / English), theme (light/dark), run modes (steering / follow-up), agent settings |
| **Personalization** | user ID, sidebar expand/collapse, send mode, session-switch modifier |
| **Models & Channels** | model store (read-only), custom channels editor |
| **Session Management** | archived sessions (restore), export current session to HTML |
| **Permissions** | browser notification state/request, local-boundary notes |
| **Prompt Favorites** | manage saved prompts; run them as new prompts |
| **Appearance** | per-adapter accent colors (pi / Codex / AtomCode / ZCode) |
| **Access** | network mode display, pairing code generation/revocation, remote capability switches (§12) |
| **Lab** | streaming animation, compact tool cards, notify on settle, simplified output |

### Favorites
Click the bookmark button in the composer to save the current input.
Manage and run favorites under **Settings → Prompt Favorites** (running
switches to chat and sends immediately).

---

## 12. Privacy, access & permissions

### Defaults
- The panel binds loopback addresses only and refuses other Host headers.
- `~/.pi/agent/auth.json` is never read or exposed.
- Writes are limited to: conversations via pi RPC, `models.json` when you
  save channels, and panel preferences in browser localStorage.
- Browser notifications are requested only when you trigger them
  (**Permissions** area or the settle-notify Lab switch).

### Control token
Every write route and every sensitive read route (model config, file
preview, session state, the SSE event stream) requires a random per-process
**control token**. The served page receives the token automatically and
sends it as `X-PiHub-Token`; the event stream carries it as `?token=`. The
token is never persisted or logged. API responses are never cached by the
service worker (`Cache-Control: no-store`).

### LAN access (off by default)
Access from other devices is **disabled by default**. When you explicitly
enable it (`PIHUB_NET=pair` or `lan`):

- **Pairing codes**: a one-time code with a short time-to-live; the peer
  presents it once and receives a session token. Codes can be revoked or
  rotated at any time from **Settings → Access**.
- **Capability switches**: each remote write class — prompts/steer,
  deletions, shell, approvals — has an **independent switch, all off by
  default**. Remote requests without the paired token are rejected (403).
- Loopback access is never affected by these switches.

### File preview containment
The preview path is re-verified with `realpath` against the real workspace
root before reading — a symlink inside the workspace pointing outside is
rejected.

---

## 13. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Page shows *server offline* | ensure the backend is running (`npm run dev`); check nothing else occupies `3001` |
| Port 18384 busy | kill the stale process or change the port in `vite.config.ts` (web) — the panel frontend uses 18384 |
| "Agent is already processing" | the shared pi session is busy (another tool may be using it); wait or send as steer/follow-up |
| "This session has not been saved yet" | pi requires the session to have an assistant response before cloning |
| Model dropdown empty | check `models.json` / provider configuration in pi |
| Remote device gets 403 | the pairing code is missing/expired, or the capability switch for that action is off — check **Settings → Access** |
| Dev changes not visible | run the dev server with polling watchers (see `scripts/dev.mjs`, `CHOKIDAR_USEPOLLING`) |
| A tab shows an old conversation | the session was switched by another tab — activate the tab again; each tab reloads its own session on activation |

---

## 14. Development

```bash
npm run dev          # parallel: vite (18384) + tsx watch server (3001)
npm run dev:web      # vite only
npm run dev:server   # tsx watch server only
npm run typecheck
npm run lint
npm test             # vitest — shared zod schemas + server session parsing
npm run build        # typecheck + lint + bundle to dist/
npm run showcase:record  # render the demo walkthrough video (see README)
```

Layout: `src/` (React SPA) · `server/` (RPC bridge, REST, SSE) · `shared/`
(zod boundary schemas) · `public/` (PWA manifest, icon, service worker).

The panel also ships a headless smoke script for the multi-tab workspace:
`node scripts/smoke-tabs.mjs` (requires Google Chrome / `CHROME_PATH`; it
reads the backend control token from the production page automatically).

### Contributing
Open issues/PRs against the repository. The project is Apache-2.0, an
independent clean-room implementation written from scratch.

---

*PiHub — Apache License 2.0. Fonts: HarmonyOS Sans SC (Huawei) and IBM Plex
(SIL OFL); HM Symbols subset from the `hm_symbol` package.*
