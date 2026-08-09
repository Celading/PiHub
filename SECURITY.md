# Security Policy

PiHub is a local-first control plane for coding agents. It is designed so
that **no data leaves your machine** unless you explicitly configure a model
provider to send prompts to.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ (latest) |
| < 0.1 | ❌ |

## Reporting a vulnerability

PiHub is a local tool, but its control plane can perform privileged actions
(execute commands in your workspace, read files, manage model credentials).
Please treat any way to reach those endpoints **without authorization** as a
security issue.

- **Do not** open a public issue for security findings.
- **Do** email the maintainers privately via the repository owner contact, or
  open a GitHub Security Advisory (`Security → Report a vulnerability`) on
  the canonical repository.
- Include: affected version, steps to reproduce, and the impact.

We aim to acknowledge reports within 48 hours and to ship a fix in the next
sprint.

## Security boundary

- The panel binds **127.0.0.1 only** and refuses non-loopback hosts.
- A **random per-process control token** guards every write route and every
  sensitive read route (model configs containing API keys, file preview,
  session/message state, the SSE event stream). The token is injected into
  the served `index.html`, never persisted, never logged.
- `~/.pi/agent/auth.json` is **never read or exposed**.
- The service worker **never caches** `/api/**` responses; API responses send
  `Cache-Control: no-store`.
- File preview verifies the **real** (symlink-resolved) path stays inside the
  active session's working directory.
- Demo mode uses synthetic data only; write routes return 503 and real pi is
  never spawned.

## What is out of scope

- Remote binding (`0.0.0.0`) is not supported by design. For LAN access,
  tunnel through a trusted reverse proxy (e.g. Tailscale) at your own risk —
  the control token still applies.
- Multi-user authentication is not implemented; the panel is a single-operator
  local tool.
