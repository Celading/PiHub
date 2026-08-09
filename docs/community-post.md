# PiHub — community post kit

> **How to use this file**
> Copy one title + the matching body into your post, pick 3-5 tags, attach
> the demo video (`docs/demo-script.md`, rendered via `npm run
> showcase:record`), and post. Two full variants below (EN / 中文). Keep the
> wording — every security claim here is exact and must not be exaggerated.

---

## English variant

### Title options

1. PiHub: a local-first web console for the pi coding agent
2. Your pi agent, in a browser — tabs, trees, costs, all on your machine
3. I built a local web panel for the pi coding agent (no cloud, no accounts)

### Body

> Meet **PiHub** — an open-source web console for the
> [pi coding agent](https://pi.dev). It runs entirely on your machine and
> turns the CLI into a full workspace:
>
> - **Streaming chat** with steer, interrupt, thinking states and tool cards
> - **Multi-session tabs** — keep several conversations open in parallel
> - **Session trees** — browse branches and fork a new one in one click
> - **Cost & usage insights** — per-session and per-directory trends
> - **File previews, diffs and an automation center** (skills + pipelines)
>
> Local-first is the design, not a footnote:
> - Binds to `127.0.0.1` only
> - Never reads your agent credentials (`auth.json` is never touched)
> - No cloud service of its own — the only outbound calls are the ones you
>   explicitly configure (your model provider)
> - Independent clean-room implementation, Apache-2.0
>
> ```bash
> git clone https://github.com/HapPub/PiHub.git
> cd PiHub && npm install && npm run dev
> # then open http://localhost:18384 (backend on 127.0.0.1:3001)
> ```
>
> Demo video attached. Docs, manual and i18n (EN/中文/Русский) in the repo.

### Tags

`#picodeagent` `#ai` `#opensource` `#localai` `#developer-tools`
`#react` `#privacy-first`

---

## 中文 variant

### Title options

1. PiHub：pi coding agent 的本地网页控制台
2. 给 pi agent 装一个浏览器工作台 —— 标签页、会话树、成本洞察，全在本机
3. 开源：一个纯本地的 pi agent Web 面板（无云端、无账号）

### Body

> 认识 **PiHub** —— 面向 [pi coding agent](https://pi.dev) 的开源网页控制台，
> 完全运行在你的机器上，把 CLI 变成完整工作台：
>
> - **流式对话**：引导、打断、思考状态、工具卡片
> - **多会话标签页**：多个会话并行打开、随时切换
> - **会话树**：浏览所有分支，一键 fork 新分支
> - **成本与用量洞察**：按会话、按目录的趋势图表
> - **文件预览 / Diff / 自动化中心**（技能 + 工程流）
>
> 本地优先是设计，不是一句口号：
> - 仅监听 `127.0.0.1`
> - 绝不读取你的 agent 凭证（`auth.json` 从不触碰）
> - 没有自有云服务——唯一的出站请求是你显式配置的模型提供方
> - 独立 clean-room 实现，Apache-2.0
>
> ```bash
> git clone https://github.com/HapPub/PiHub.git
> cd PiHub && npm install && npm run dev
> # 打开 http://localhost:18384（后端在 127.0.0.1:3001）
> ```
>
> 演示视频见附件；文档、手册与多语言（EN/中文/Русский）都在仓库里。

### Tags

`#pi` `#AI编程` `#本地优先` `#开源` `#开发者工具` `#隐私保护`

---

## Release-day checklist

- [ ] Demo mp4 rendered and attached (synthetic demo data only)
- [ ] Release published on GitHub + AtomGit mirrors (see
      `docs/release-notes-template.md`)
- [ ] Post links to the canonical repository (not to internal mirrors)
- [ ] Security claims reviewed against `SECURITY.md` word by word
