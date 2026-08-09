# PiHub — 30-second demo video script

> **How to use this file**
> Two lanes, one goal:
> 1. **Record**: the "Shot" column maps 1:1 to steps in
>    `scripts/record-showcase.mjs` (DSL: `clickSel` / `type` / `press` /
>    `wait` / `shot`). `npm run showcase:record` renders an mp4 of the demo
>    panel (synthetic data only, writes return 503, real pi is never
>    spawned), so the shots below can be recorded automatically and then
>    edited with a voiceover.
> 2. **Edit**: keep the total at ~30 seconds. Timings below are guides, not
>    rules — cut the longest shot to make room.
>
> Voiceover (EN) is drafted under each shot; a CN variant is provided at the
> end. Subtitles should be 2-6 words per line.

## Structure at a glance

| Time | Shot | What the viewer sees |
| --- | --- | --- |
| 0:00–0:04 | Open | Logo, tagline, panel booting into a chat |
| 0:04–0:12 | Chat | Streaming reply, thinking states, tool cards |
| 0:12–0:18 | Tabs | A second session opens in a parallel tab |
| 0:18–0:24 | Insights | Cost trends + session tree with a fork |
| 0:24–0:30 | Close | "Local-first" card + link to the repo |

## Shots

### 1. Open (0:00–0:04) — 4s

- **Script step**: `wait` 1200ms (demo chat loads), then a fade-in on edit.
- **Frame**: PiHub wordmark, tagline "Where π connects everything", the
  chat view with one draft tab.
- **Voiceover**: "Meet PiHub — the local web console for the pi coding
  agent. No cloud account. No setup beyond a local install."

### 2. Streaming chat (0:04–0:12) — 8s

- **Script steps**: open & close the model picker (`clickSel`
  `.composer-model-fields`, `press Escape`), fold & expand the assistant
  process toggle (`clickSel` `.assistant-process-toggle` ×2).
- **Frame**: messages with thinking states, tool cards, process folds.
- **Voiceover**: "Real-time streaming, steer and interrupt, thinking states
  and tool cards — everything that happens in your agent, visible and
  controllable."

### 3. Multi-session tabs (0:12–0:18) — 6s

- **Script step** (P1-06): click a second session in the sidebar — a new
  tab opens beside the first; click between tabs.
- **Note on recording**: session switching is a write operation, so the
  auto-recorder's demo stack (writes return 503 by design) cannot perform
  this shot. Record it against a local real-mode instance (`npm run dev`)
  on a scratch workspace, or show the tab strip with two already-open tabs
  and just click between them.
- **Frame**: the tab strip with two sessions; switching tabs swaps the
  conversation.
- **Voiceover**: "Keep several conversations open in parallel tabs and jump
  between them — each session streams independently."

### 4. Insights & tree (0:18–0:24) — 6s

- **Script steps**: `clickSel button[aria-label="统计"]` (stats), then the
  sessions history (`button[aria-label="历史"]`) and the tree view.
- **Frame**: cost charts, then a session tree with a branch fork.
- **Voiceover**: "Cost and token trends per session and directory. Session
  trees show every branch — and fork a new one in one click."

### 5. Close (0:24–0:30) — 6s

- **Frame**: a clean card (added on edit): "127.0.0.1 only · never reads
  your credentials · no cloud service of its own" + repository link.
- **Voiceover**: "Local-first by design — your conversations never leave
  your machine. Star it on GitHub and try it today."

## CN voiceover variant

1. 「认识 PiHub —— pi coding agent 的本地网页控制台。无需云端账号，装好即用。」
2. 「实时流式对话、引导与打断、思考过程与工具卡片 —— agent 的一切，看得见、控得住。」
3. 「多个会话以标签页并行打开，随时切换 —— 每个会话独立流转。」
4. 「按会话、按目录的成本与用量趋势；会话树展示全部分支，一键分叉。」
5. 「本地优先：仅监听 127.0.0.1、绝不读取你的凭证、没有任何自有云服务。欢迎 Star 试用。」

## Recording checklist

- [ ] Run against the **demo** stack only (`npm run showcase:record`
      spawns its own demo backend on a separate port)
- [ ] Verify the anchor diff output — every key frame should print changed
      anchors (component motion is the evidence; no decode step needed)
- [ ] Concatenate with ffmpeg, add voiceover + subtitles, export ≤ 30s
- [ ] Attach the mp4 to the release / community post
