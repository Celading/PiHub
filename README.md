<p align="center">
  <img src="https://img.shields.io/badge/pi%20agent-web%20panel-005fb8?style=for-the-badge&labelColor=161616" alt="pi agent web panel" />
  <img src="https://img.shields.io/badge/stack-react%2019%20%2B%20TS%20strict-005fb8?style=for-the-badge&labelColor=161616" alt="React 19 + TypeScript strict" />
  <img src="https://img.shields.io/badge/design-Swiss%20%C3%97%20IBM-005fb8?style=for-the-badge&labelColor=161616" alt="Swiss × IBM design" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-005fb8?style=for-the-badge&labelColor=161616" alt="Apache-2.0" />
</p>
<div align="center">
<span style="font-weight:600;font-size:40px">PiHub</span><br/>
<span style="font-weight:300;font-size:22px">你的π，由此汇聚 — Where π connects everything.</span>
<p align="center">
  <strong>A local web panel for the <a href="https://pi.dev">pi coding agent</a>.</strong><br/>
  <sub>streaming chat · session trees · models &amp; costs · extensions &amp; skills — in your browser, on your machine</sub>
</p>
<p align="center">
  <strong><a href="README.md">English</a></strong> · <a href="README-CN.md">中文</a> · <a href="docs/README.ru-RU.md">Русский</a>
</p>
</div>

## Repository

PiHub is developed in the open under two synchronized mirrors:

- **GitHub**: <https://github.com/HapPub/PiHub>
- **AtomGit**: <https://atomgit.com/HapPub/PiHub>

Issues and pull requests are welcome on either mirror; both stay in sync.

## What is PiHub

PiHub is a browser-based workspace for [`pi`](https://pi.dev)
(`@earendil-works/pi-coding-agent`) that runs entirely on your machine. It
talks to a local `pi --mode rpc` process through a small Node bridge — no
cloud accounts required. PiHub does not use its own cloud service; the only
outbound requests happen on explicit feature paths (model catalog lookups to
pi.dev, and prompts sent to the model provider you configure).

It is an independent, clean-room implementation — written from scratch,
no external UI source is reused.

### Local-first by design

Your conversations stay on your machine. The panel binds to the loopback
interface only, never reads your agent credentials, and operates no cloud
service of its own — the only outbound requests are the ones you explicitly
configure (model catalog lookups and prompts to your chosen provider). See
[`SECURITY.md`](SECURITY.md) for the exact boundary.

## Features

### Chat
- Real-time streaming with steer / interrupt / follow-up queue
- Reasoning UI: thinking states with icons, per-run elapsed time, workflow
  collapse (`>`), and an optional simplified-output mode
- Inline model &amp; thinking-level selectors (selection takes effect immediately)
- Send mode preference: `Enter`, `⌘+Enter` or `Ctrl+Enter`
- Slash suggestions (`/`) for extensions, skills and prompt templates
- Image paste

### File workbench
- Read-only preview of any file touched during the session (workspace-whitelisted)
- Inline unified-diff highlighting on changed files
- Recent-files strip: read / write / edit / patch calls, one click to preview

### Sessions
- Session list with live status lights (done / running / interrupted)
- **Multi-tab workspace**: open several sessions in parallel tabs — clicking
  a session opens or switches a tab; tabs close independently and fall back
  to a fresh chat tab
- **Session trees**: branch timeline with node labels and one-click fork of
  mainline user messages
- Collections (groups &amp; projects) with drag-and-drop and custom names
- Archive to settings (restorable) and guarded deletion
- Right-click menu: open · new branch (clone) · archive · delete
- Tree filters in session details: all / mainline / no tools / user
- Keyboard navigation: `⌘`/`Ctrl` + `↑`/`↓` to switch sessions

### Models &amp; channels
- Model and thinking-level switching, model cycling (`Ctrl+Shift+L`)
- Custom API channels editor writing `~/.pi/agent/models.json`
  (base URL, token, API type, context window, max tokens, reasoning, inputs)
- Global and per-session token/cost statistics

### Settings (seven areas)
General · Personalization · Models &amp; Channels · Session Management ·
Permissions · Prompt Favorites · Lab

### Automation · Skills · Pipelines
- Command center: the full `get_commands` directory (skills / prompt
  templates / extensions) with search and one-click run
- Automation overview of live switches (auto-compaction, auto-retry, modes)
- **Pipelines**: PiHub-exclusive multi-step orchestration — a sequence of
  prompt / steer / approval / model / thinking steps executed on one pi
  session, with match branching, error strategies, human approval gates and
  a live run timeline. Part of the built-in workflow surface.
- Skill import: convert any skill into a pipeline — algorithmic conversion
  (zero tokens) or agent-assisted conversion (token-gated, confirmed first)

### Multi-agent visibility
- Read-only session views for other agent CLIs on the same machine — Codex
  rollout history, AtomCode history and ZCode model-I/O records — each with
  its own accent color (overridable in **Settings → Appearance**)
- Codex is never spawned by default; the opt-in `exec` integration streams
  its JSONL events and never touches a running Codex

## Quick Start

Requires [pi](https://pi.dev) (`pi --version` ≥ 0.83) and Node.js ≥ 20.

### Install & run (via npm)

```bash
npm install -g @celading/pihub
pihub
```

Then open **http://127.0.0.1:3001** in your browser. `pihub` spawns
`pi --mode rpc` itself — no terminal window needed afterwards. The panel
binds to the loopback interface only.

- To keep it always available, run `pihub` in a terminal tab or as a
  background service (e.g. `pihub &` / launchd).
- Change the port with `PORT=4000 pihub`.
- Full usage, features and troubleshooting: the [manual](MANUAL.md)
  (中文版 [使用手册](MANUAL.zh-CN.md)).

### From source (development)

```bash
git clone https://github.com/HapPub/PiHub.git
cd PiHub
npm install
npm run dev        # web UI on http://localhost:18384 (backend on 127.0.0.1:3001)
```

Production build:

```bash
npm run build      # typecheck + lint + bundle to dist/
npm test           # schema & session-parsing tests
```

Then open **http://localhost:18384**. The panel binds to the loopback
interface only.

## Screenshots

A peek at the panel in showcase mode (synthetic, desensitized data):

| | |
|---|---|
| ![Chat](docs/screenshots/demo-chat.png) | ![Sessions](docs/screenshots/demo-sessions.png) |
| Chat stream with reasoning, tool-cluster collapse, live elapsed timer and per-reply branch/copy | Session list with collections and status lights |
| ![Stats](docs/screenshots/demo-stats.png) | ![Settings](docs/screenshots/demo-settings.png) |
| Token & cost analytics by model / provider / directory | Seven-area settings with session restore & delete |
| ![Pipelines](docs/screenshots/demo-pipelines.png) | |
| PiHub-exclusive Pipelines: skill import (hard/soft convert) and run timeline | |

## Interactive showcase video

Instead of screen-recording, PiHub can render a walkthrough video of the
showcase (demo) mode directly: a script drives the real panel in headless
Chrome, clicks land at absolute viewport coordinates with a ripple wave at the
touch point, and a single mp4 is exported ready for editing.

Requirements: Google Chrome (or `CHROME_PATH`) and `ffmpeg` on PATH.

```sh
npm run showcase:record
# output: out/showcase-<timestamp>.mp4 (h264, 1920×1080, 30fps)

# the showcase movie: demo auto-play + typewriter + settle collapse
# (see docs/showcase-director-script.md for the storyboard)
npm run showcase:record -- --movie
```

How it works:

- **Component anchors** — key views carry `data-shot` identifiers; the
  recorder reads each anchor's dynamic state (visibility, absolute rect, text)
  after every step.
- **Change-driven key frames** — a frame is captured only when the tracked
  components actually changed (view switch, folding, layout shift); identical
  holds just extend the previous key frame's duration. The run prints the
  per-frame anchor diff, so every UI change is verified without decoding the
  video (a typical walkthrough records ~12 key frames instead of hundreds of
  redundant screenshots).
- **Absolute-position clicks with ripples** — the click lands at the exact
  viewport coordinates of the target component (resolved from its current
  rect), and a ripple wave animates at that point, so the video reads as a
  real interaction.
- **Demo-only** — recording always runs the synthetic demo dataset (write
  routes 503); it never touches real sessions or credentials.

The walkthrough steps live in `scripts/record-showcase.mjs` as a declarative
timeline (`clickSel` / `type` / `press` / `wait` / `shot`) — edit the steps to
produce a different demo.

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Esc` | interrupt the running agent |
| `Ctrl+Shift+M` | automation / skills / workflows palette |
| `Ctrl+Shift+L` | cycle model |
| `⌘`/`Ctrl` + `↑`/`↓` | switch session |
| `Alt+1..5` | chat / sessions / stats / settings / automation |

## Layout

```
src/       React SPA (strict TypeScript, zero `any`)
server/    Node backend — pi RPC bridge, REST, SSE
shared/    Shared types + zod boundary schemas
scripts/   Dev runner
public/    PWA manifest, icon, service worker
```

## Boundaries

- **Localhost-only**: the panel listens on `127.0.0.1` / `localhost` only and
  refuses other Host headers. Optional LAN access (`PIHUB_NET=pair` / `lan`)
  is **off by default**; enabling it requires a one-time pairing code per
  peer, and every remote capability (prompt / steer / delete / shell /
  approval) has its own switch, all defaulting to off.
- **Control token**: every write route and every sensitive read route
  (model config, file preview, session state, SSE) requires a random
  per-process token that the served page receives automatically.
- **Never reads credentials**: `~/.pi/agent/auth.json` is never read or
  exposed by the panel. Custom channel API keys are stored only in your
  local `~/.pi/agent/models.json` and sent only to the provider you
  configured.
- **Outbound traffic is explicit**: no cloud service is used; requests to
  pi.dev's public model catalog and to your configured model provider happen
  only on those explicit feature paths.
- **Minimal writes**: the panel writes only what you ask it to — new
  conversations via pi RPC, custom channels into `models.json`, and your
  panel preferences in the browser's local storage.
- **Clean-room**: independent implementation, written from scratch.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

Third-party assets:
- [HarmonyOS Sans SC](src/assets/fonts/LICENSE-HarmonyOS-Sans.txt) — Huawei
  Device Co., Ltd. (embedded font, license on file)
- HM Symbols icon font — subset from the `hm_symbol` pub.dev package
  (HarmonyOS Symbols; see the package license)
- [IBM Plex](https://github.com/IBM/plex) — SIL Open Font License

## Documentation

- [Manual (English)](MANUAL.md)
- [README 中文](README-CN.md)
- [README на русском](docs/README.ru-RU.md)
