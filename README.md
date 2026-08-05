# pi-panel

Local web panel for the [pi coding agent](https://pi.dev) —
`@earendil-works/pi-coding-agent`.

A clean-room implementation of a full chat panel (streaming / steer / interrupt),
historical session browsing, and model/cost statistics for pi's local agent data.
It is an independent, clean-room implementation — written from scratch,
no external UI source is reused.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

Third-party assets:
- HarmonyOS Sans SC fonts embedded under the [HarmonyOS Sans Fonts License
  Agreement](src/assets/fonts/LICENSE-HarmonyOS-Sans.txt) (Huawei Device Co., Ltd.)
- HM Symbols icon font subset from the `hm_symbol` pub.dev package
  (HarmonyOS Symbols; see its package license)

## Stack

- React 19 + TypeScript (strict mode, zero `any`) + Vite 7
- Node backend (Express + SSE) spawning `pi --mode rpc` over JSONL stdio
- Swiss International Style × IBM design: IBM Plex fonts, primary `#005fb8`,
  8px grid, light-first with dark variant

## Layout

```
src/       React SPA
server/    Node backend (RPC bridge, REST, SSE)
shared/    Shared types + zod boundary schemas
scripts/   Helper scripts
```

## Quick Start

```bash
npm install
npm run dev        # frontend :5173 (proxies /api to backend)
npm run build      # typecheck + eslint + vite build
npm test           # vitest (shared schema + server parsing)
```

## Boundaries

- Localhost-only (`127.0.0.1`); never reads `~/.pi/agent/auth.json`
- Read-only over `~/.pi/agent/` except sessions initiated via pi RPC
- Phase 2 (not claimed): embedded terminal, settings editing, remote deploy
