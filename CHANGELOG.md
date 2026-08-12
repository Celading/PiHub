# Changelog

All notable changes to PiHub are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-08-12

### Added

- **Codex as a first-class console**: switch the panel between pi and Codex
  (header agent switch; Codex sessions open from the sidebar). Every prompt
  runs an isolated `codex exec` process, resumes the same thread so context
  carries over, and streams replies with usage cards. Session sync keeps the
  full conversation visible across agent switches and reloads.
- **Multi-agent sidebar**: pi / Codex / AtomCode / ZCode / Claude records
  converge in one list — folder grouping by workspace, per-agent outline
  badges, a status light per row, an agent filter next to 会话, and a
  "录入" action on the history page that pins a record into the sidebar.
  Claude Code transcripts are readable read-only. Session rows follow the
  `[icon] alias · indicator / n messages · time · light` two-line layout and
  the active session can be renamed inline (context menu → 重命名).
- **Right workbench sidebar** (dockable or floating at the top-right, both
  resizable from the left edge):
  - **Files** — a read-only workspace file browser bound to the active
    session (lazy directory tree, breadcrumb, recent file operations, inline
    diff-aware preview).
  - **Changes** — read-only git worktree inspection (staged / unstaged
    groups, per-file diffs) with a light auto-refresh.
  - **Session tree** — the active pi session's branch DAG with a compact
    lazy tree, mainline highlighting, one-click fork and jump-to-prompt.
- **Prompt timeline**: a narrow rail on the left of the chat stream marks
  every user prompt; hovering shows the prompt summary and its working time,
  clicking scrolls the stream to it. A universal prompt index
  (`/api/prompts`) is shared by every agent adapter.
- **Fog theme & motion**: a third theme (fog) keeps the light body and adds
  gaussian-blur scattering/condensing loading motion across session switches
  and the history page; long messages cap with a fog blur that sweeps down
  like a typewriter (blur 15px → 0), only when content overflows, and the
  expand button is a persistent 展开/收起 toggle.
- **Dedicated config & data home**: `$PIHUB_HOME` → `~/.pihub` →
  `./itData` (runtime fallback when the home has no permission). Server
  options (port / host / url) live in `<home>/config.toml`; `PIHUB_PORT`
  env overrides the file, generic `PORT` still works, default port 3001
  (18384 stays the Vite dev port). The About section shows the resolved
  home, config file and actual URL.
- **Typewriter output** (Lab on by default): assistant text reveals
  character-by-character with a primary-color caret. Only rendering is
  animated — the message data stays complete, so copy / resend / export
  always carry the full text; growing stream deltas continue the reveal
  instead of re-typing, long replies throttle to a 12s cap, and settling
  finishes the reveal.
- **Settle-collapse** (Lab on by default): when a run settles, the whole
  tool chain folds into one block (grid-rows transition) and a **Final
  summary** line fades in, followed by the `.....` folded marker. Clicking
  the summary expands the block — nothing is trimmed.
- **Demo showcase movie**: demo mode auto-plays a scripted conversation
  (pretend-send, thinking, a three-tool chain, typewriter text, settle) over
  the standard SSE event stream — all production components reacting to
  ordinary events. `docs/showcase-director-script.md` is the 8-scene
  storyboard; the headless check lives in `scripts/smoke-showcase.mjs`.
- **PWA mobile polish**: iOS standalone metadata, safe-area insets, ≥44px
  touch targets, hashed assets cached offline by the service worker, and an
  install hint in Settings → About.
- **About section**: live version from the server, install / custom-port
  instructions, data home and config file paths, PWA hint.

### Fixed

- **Config home resolution race**: concurrent startup resolution could
  intermittently ignore `config.toml` (bound port 3001 instead of the
  configured one) — one shared resolution promise with unique probe files
  makes it deterministic (verified on arm64 Linux).
- **Prompt timeline tooltip** clipped by the rail and covered by the chat
  stream — now anchored with fixed positioning.
- Light-mode inline code inside user bubbles was white-on-white — chips now
  use a translucent white background.

_No new security surface beyond 0.2.0; all new file/git surfaces are
read-only with workspace containment._

## [0.2.0] - 2026-08-09

### Added

- **Multi-tab chat workspace**: sessions open in parallel tabs
  (sidebar click opens or switches a tab; tabs can be closed and fall back
  to a fresh draft tab). Each tab keeps its own message flow — activating a
  tab whose session differs from the RPC's current one switches sessions
  first, then reloads that session's chat. Draft tabs follow whatever
  session the RPC currently holds.
- **Agent adapter surface**: a protocol-neutral
  `AgentAdapter` interface (commands / events / meta) with pi as the first
  adapter; read-only visibility into sessions recorded by other agent CLIs —
  Codex rollout history (`~/.codex/sessions`), AtomCode history and ZCode
  model-I/O records, each with its own accent color overridable in
  **Settings → Appearance**. An opt-in Codex `exec` adapter
  (JSONL event stream) is available and never touches a running Codex.
- **LAN access modes**: optional `PIHUB_NET` mode (`local` default,
  `pair` / `lan`) with one-time pairing codes (short TTL, revocable) and
  per-capability switches for remote writes — all remote capabilities are
  **off by default**; loopback access is unchanged.
- **Session tree visualization**: branch timeline in session details
  with node labels and one-click fork of mainline user messages.
- **Release kit**: `docs/release-notes-template.md` (user-facing
  release notes template with a tagging checklist), `docs/demo-script.md`
  (30-second demo video script mapped 1:1 to the showcase recorder DSL),
  `docs/community-post.md` (EN/中文 community post kits with exact security
  claims), and a "Local-first by design" trust section on the README
  (EN/中文).
- **Event envelope**: every streamed RPC event now carries a per-process
  monotonic `sequence` plus optional `sessionId` / `runId`, laying the
  groundwork for run isolation and replay tooling (original payload kept
  untouched).

### Security

- **Local control-plane gate**: strict Host allowlist (127.0.0.1 / localhost
  by default, extendable via `PIHUB_ALLOWED_HOSTS`), same-origin check for
  state-changing requests carrying an `Origin` header, and a random
  per-process control token required on every write route and sensitive read
  route (model config, file preview, session/message state, SSE event
  stream). The SPA receives the token from the served index.html and sends it
  as `X-PiHub-Token`; EventSource carries it as `?token=`. Token is never
  persisted or logged.
- **Remote peers need a valid pair**: any non-loopback API request must
  present a validated pairing code; capability switches gate each remote
  write class independently (all off by default).
- **Service worker no longer caches API responses** (`/api/**`), and all API
  responses send `Cache-Control: no-store` — session content, file previews
  and credential-bearing model configs never touch the cache.
- **File preview symlink containment**: the preview path is re-verified with
  `realpath` against the real workspace root before reading, so a symlink
  inside the workspace pointing outside is rejected (400).
- **RpcBridge restart race fixed**: a deliberately restarted pi process no
  longer has its new child reference cleared by the old process's late exit
  event (no orphans / duplicate pi).

### Fixed

- **Pipeline `requiresApproval` prompt now executes**: previously a
  prompt/steer step with `requiresApproval: true` completed immediately after
  approval without ever sending the prompt to pi.
- **Settle timeouts are honest**: a pipeline step that times out waiting for
  `agent_settled` now marks the run `uncertain` instead of pretending it
  settled successfully.
- **Pipeline abort cancels pi**: aborting a running pipeline now sends the pi
  `abort` command instead of only releasing the in-memory waiter.

## [0.1.0] - 2026-08-08

### Added

- Interactive showcase video export: `npm run showcase:record` drives the
  demo panel in headless Chrome (component anchors + change-driven key
  frames + absolute-coordinate click ripples) and renders an mp4 ready for
  editing.
- File workbench: read-only file preview (session-cwd whitelist), clickable
  paths in tool output, inline diff highlighting, recent-files strip.
- Cost insights: daily usage trend, top-cost sessions, zero-dependency SVG
  charts (cost share by provider / directory), token totals per directory.
- Session tree visualization: branch timeline, node labels, one-click fork.
- Pipelines (automation · skills · pipelines center): declarative DSL,
  state-machine engine, approval gates, branching, SSE timeline.
- Session deletion fix: sidebar deletion now sends the bare file name
  (server guard) and refreshes the list; collection keys unified to session
  ids with legacy fallback and dedupe.

### Security

- Panel binds 127.0.0.1 only; `~/.pi/agent/auth.json` is never read.

[0.2.0]: https://github.com/HapPub/PiHub/releases/tag/v0.2.0
[0.1.0]: https://github.com/HapPub/PiHub/releases/tag/v0.1.0
