# Changelog

All notable changes to PiHub are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- DSH Web discovery, session continuity, streamed events, approvals and model
  catalog support through the local PiHub server.
- Persistent private workspaces with pre-session Files and Changes views, plus
  a bounded snapshot fallback when Git is unavailable.
- Dedicated Pi runtime settings, capability reporting, terminal result fallback
  and remote-browser pairing/navigation.
- Standard-input JSON-RPC access to the pipeline runtime through `pihub --mcp`.

### Fixed

- Git status no longer passes diff-only flags that make valid repositories fail.
- Runtime restart waits for a real response and ignores output from retired
  child processes.
- Settings no longer mounts the chat-only right workbench or relies on a native
  window bridge for remote navigation.

### Security

- Updated the transitive `nanoid` dependency to `3.3.18`; production and full
  dependency audits report zero known vulnerabilities.

## [0.3.2] - 2026-08-17

### Added

- **Pipeline run kernel v1**: runs are serialized (a busy engine returns a clear
  conflict instead of interleaving), an uncertain settle is terminal (no later
  steps execute), abort races are closed, and match steps without explicit
  targets continue linearly instead of silently truncating.
- **Durable run ledger**: per-run journals are append-only, terminal runs emit
  typed receipts with step digests / attempts / timing, and a restart recovery
  pass resumes interrupted runs idempotently without re-sending completed steps.
- **Cross-process lease gate**: an exclusive execution lease prevents two PiHub
  processes from running pipelines at the same time; crashed owners are
  reclaimed and the same owner can take over after restart.
- **Pipeline visual editor**: steps are edited in an execution band with
  per-step inspector (variables, streaming, provider/model, thinking, output
  match, retries) and a failure policy; the JSON source view remains available.
- **Active run header**: a stable status line above the chat shows project /
  model / run state with a live clock, changed-file count and pending-approval
  chip, plus pause / rerun / branch actions when available.
- **Run ledger**: tool, bash, thinking and extra assistant frames render as
  compact event rows with expandable raw blocks; only the final answer keeps
  full layout.
- **Sidebar task-ification**: project groups collapse to one summary line,
  session rows gain run-state filtering, and agent filter glyphs have tooltips.
- **Codex console depth**: aborted/error frames render as centered notices,
  hash routing preserves the selected view and session across refreshes, and a
  System Prompt setting persists a prompt file and restarts the runtime with it.
- **Published bin runs from any directory**: the frontend build is resolved
  relative to the package itself, so `npx pihub` / global installs work from
  any cwd.

### Fixed

- **Remote capability gate**: every non-read API route is classified and remote
  peers are fail-closed for unclassified writes; remote writes remain off by
  default and are independently toggleable.
- **Codex thread dedup**: resumed threads with multiple rollout files now
  resolve to one authoritative record (newest file, deduplicated by embedded
  id), fixing duplicate sidebar rows.
- **Event correlation**: streamed RPC events now carry the active session id so
  concurrent runs from other sessions cannot steal settle/output events.
- **Sensitive-read token coverage**: full-content reads (session detail, adapter
  history, prompts, git diff, files) now require the control token.
- **Host-header LAN bypass**: remote-ness is judged from the socket address
  instead of the forgeable `Host` header; IPv4-mapped IPv6 loopback is handled.
- **SSRF guard**: model catalog fetches reject loopback / private / link-local /
  metadata addresses.
- **Git inspection hardening**: `git status` / `git diff` run with
  `--no-ext-diff --no-textconv` and a cleared external diff env, so
  repository-owned executables are never run.
- **Pairing hardening**: pairing codes use 128-bit entropy with a per-peer
  failed-pairing throttle.
- **RPC bridge robustness**: stdout framing is bounded (1 MiB), runaway
  processes are restarted on a sliding 60-second budget, and SSE broadcast
  write failures no longer break the broadcast loop.
- **Sessions page scroll**: the session history page now scrolls correctly
  instead of compressing its groups.

### Security

- No new external network surface. The panel remains loopback-only by default;
  all new write surfaces are token-gated and demo routes stay 503 in
  non-demo modes.

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
