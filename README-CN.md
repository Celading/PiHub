<p align="center">
  <img src="https://img.shields.io/badge/pi%20agent-web%20panel-005fb8?style=for-the-badge&labelColor=161616" alt="pi agent web panel" />
  <img src="https://img.shields.io/badge/stack-react%2019%20%2B%20TS%20strict-005fb8?style=for-the-badge&labelColor=161616" alt="React 19 + TypeScript strict" />
  <img src="https://img.shields.io/badge/design-Swiss%20%C3%97%20IBM-005fb8?style=for-the-badge&labelColor=161616" alt="Swiss × IBM design" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-005fb8?style=for-the-badge&labelColor=161616" alt="Apache-2.0" />
</p>
<div align="center">
<span style="font-weight:600;font-size:40px">PiHub</span><br/>
<span style="font-weight:300;font-size:22px">你的π，由此汇聚</span>
<p align="center">
  <strong>pi coding agent 的本地 Web 面板。</strong><br/>
  <sub>流式对话 · 会话树 · 模型与成本 · 扩展与技能 — 全在本机浏览器里</sub>
</p>
<p align="center">
  <a href="README.md">English</a> · <strong><a href="README-CN.md">中文</a></strong> · <a href="docs/README.ru-RU.md">Русский</a>
</p>
</div>

## 代码仓库

PiHub 在以下两个同步镜像中开放开发：

- **GitHub**：<https://github.com/HapPub/PiHub>
- **AtomGit**：<https://atomgit.com/HapPub/PiHub>

欢迎在两个镜像上提交 issue 与 PR；两仓保持同步。

## PiHub 是什么

PiHub 是为 [`pi`](https://pi.dev)（`@earendil-works/pi-coding-agent`）打造的
浏览器工作台，完全运行在你的机器上。它通过一个轻量 Node 桥与本地
`pi --mode rpc` 进程通信——无云端、无账号、数据不出本机。

本项目为独立编写的 clean-room 实现——全部从零写出，
不复用任何外部 UI 源码。

## 功能

### 对话
- 实时流式输出，支持引导（steer）/ 中断 / 跟进队列
- 推理界面：icon 化思考状态、单次运行耗时、工作流折叠（`>`）、
  可选的简化输出模式
- 内联模型与思考档位选择（选择立即生效）
- 发送方式偏好：`Enter` / `⌘+Enter` / `Ctrl+Enter`
- `/` 唤起扩展、技能与提示词模板建议
- 图片粘贴

### 会话
- 会话列表实时状态灯（已完成 / 进行中 / 已中断）
- 集合（分组 / 项目）：拖拽入组、自定义集合名
- 归档（设置页可恢复）与受保护的删除
- 右键菜单：打开 · 新建分支（克隆）· 归档 · 删除
- 详情页树过滤：全部 / 主线 / 无工具 / 仅用户
- 键盘导航：`⌘`/`Ctrl` + `↑`/`↓` 切换会话

### 模型与渠道
- 模型与思考档位切换，模型循环（`Ctrl+Shift+L`）
- 自定义 API 渠道编辑器，写入 `~/.pi/agent/models.json`
  （Base URL、Token、API 类型、最大上下文、最大输出、思考、输入类型）
- 全局与会话内 token / 成本统计

### 设置（七大区）
通用设置 · 个性化设置 · 模型渠道 · 会话管理 · 权限管理 ·
提示词收藏夹 · 实验室能力

### 自动化 · 技能 · 工程流
- 命令中心：`get_commands` 全量目录（技能 / 提示词模板 / 扩展命令），搜索与一键运行
- 自动化概览：常用开关状态（自动压缩 / 自动重试 / 模式）
- **工程流（Pipelines）**：PiHub 独家多步编排——prompt / steer / approval /
  setModel / setThinking 步骤序列在同一 pi 会话上执行，支持匹配分支、
  错误策略、人工确认闸门与实时运行时间线。隶属于 HaomoKit 泛化能力。
- 技能导入：将任意技能转换为工程流——算法转换（零 token）或 agent 辅助转换
  （消耗 token，操作前确认）

## 快速开始

需要 [pi](https://pi.dev)（`pi --version` ≥ 0.83）与 Node.js ≥ 20。

```bash
git clone <your-fork-or-local-root>/pi-panel
cd pi-panel
npm install
npm run dev        # Web UI: http://localhost:18384（后端 127.0.0.1:3001）
```

生产构建：

```bash
npm run build      # typecheck + lint + 打包到 dist/
npm test           # schema 与会话解析测试
```

然后打开 **http://localhost:18384**。面板仅监听本机回环地址。

## 快捷键

| 快捷键 | 动作 |
| --- | --- |
| `Esc` | 中断运行中的 agent |
| `Ctrl+Shift+M` | 自动化 / 技能 / 工程流面板 |
| `Ctrl+Shift+L` | 循环切换模型 |
| `⌘`/`Ctrl` + `↑`/`↓` | 切换会话 |
| `Alt+1..4` | 对话 / 会话 / 统计 / 设置 |

## 目录结构

```
src/       React SPA（严格 TypeScript，零 any）
server/    Node 后端 — pi RPC 桥、REST、SSE
shared/    共享类型 + zod 边界 schema
scripts/   Dev 启动器
public/    PWA manifest、图标、Service Worker
```

## 边界

- **仅本机访问**：面板只监听 `127.0.0.1` / `localhost`。
- **绝不读取凭据**：面板从不读取或暴露 `~/.pi/agent/auth.json`。
- **最小写入**：面板只写你让它写的东西——经 pi RPC 发起的新对话、
  自定义渠道（`models.json`）、以及浏览器 localStorage 中的面板偏好。
- **Clean-room**：独立实现，全部代码从零编写。

## 许可证

Apache License 2.0 — 见 [LICENSE](LICENSE)。

第三方资源：
- [HarmonyOS Sans SC](src/assets/fonts/LICENSE-HarmonyOS-Sans.txt) —
  华为终端有限公司（内嵌字体，许可证随附）
- HM Symbols 图标字体 — 来自 pub.dev `hm_symbol` 包（HarmonyOS Symbols，
  见其包许可证）
- [IBM Plex](https://github.com/IBM/plex) — SIL Open Font License

## 文档

- [Manual（中文）](MANUAL.zh-CN.md) · [Manual（English）](MANUAL.md)
- [README（English）](README.md)
- [README на русском](docs/README.ru-RU.md)
