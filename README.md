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
</div>

## What is PiHub

PiHub is a browser-based workspace for [`pi`](https://pi.dev)
(`@earendil-works/pi-coding-agent`) that runs entirely on your machine. It
talks to a local `pi --mode rpc` process through a small Node bridge — no
cloud, no accounts, no data leaves your computer.

It is an independent, clean-room implementation — written from scratch,
no external UI source is reused.

## Features

### Chat
- Real-time streaming with steer / interrupt / follow-up queue
- Reasoning UI: thinking states with icons, per-run elapsed time, workflow
  collapse (`>`), and an optional simplified-output mode
- Inline model &amp; thinking-level selectors (selection takes effect immediately)
- Send mode preference: `Enter`, `⌘+Enter` or `Ctrl+Enter`
- Slash suggestions (`/`) for extensions, skills and prompt templates
- Image paste

### Sessions
- Session list with live status lights (done / running / interrupted)
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

## Quick Start

Requires [pi](https://pi.dev) (`pi --version` ≥ 0.83) and Node.js ≥ 20.

```bash
git clone <your-fork-or-local-root>/pi-panel
cd pi-panel
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

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Esc` | interrupt the running agent |
| `Ctrl+Shift+M` | automation / skills / workflows palette |
| `Ctrl+Shift+L` | cycle model |
| `⌘`/`Ctrl` + `↑`/`↓` | switch session |
| `Alt+1..4` | chat / sessions / stats / settings |

## Layout

```
src/       React SPA (strict TypeScript, zero `any`)
server/    Node backend — pi RPC bridge, REST, SSE
shared/    Shared types + zod boundary schemas
scripts/   Dev runner
public/    PWA manifest, icon, service worker
```

## Boundaries

- **Localhost-only**: the panel listens on `127.0.0.1` / `localhost` only.
- **Never reads credentials**: `~/.pi/agent/auth.json` is never read or
  exposed by the panel.
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
- [README 中文](docs/README.zh-CN.md)
- [README на русском](docs/README.ru-RU.md)
