# Changelog

All notable changes to PiHub are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

_No unreleased changes yet._

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
