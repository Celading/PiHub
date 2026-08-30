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

- The panel is **loopback-first** and refuses non-allowlisted Host values.
  Non-loopback listening is an explicit compatibility option, not the
  default security boundary.
- A **random per-process control token** guards every write route and every
  sensitive read route (model configs containing API keys, file preview,
  session/message state, the SSE event stream). Local fetch calls use the
  injected header; local EventSource uses a same-origin HttpOnly cookie.
  Neither transport puts the token in an SSE URL or application storage, and
  the server never logs it.
- Optional LAN compatibility access exchanges a 256-bit, one-use bootstrap
  (valid for at most 60 seconds) for a separate short-lived HttpOnly session
  cookie (at most 15 minutes). The bootstrap is shown only once in the local
  creation response and is never returned by the remote exchange; the session
  credential is never returned in JSON. Neither credential is put in URLs,
  JavaScript-readable Web Storage, referrers, or logs. Remote access is
  read-only unless an individual prompt, shell, or approval capability is
  enabled; unclassified writes remain denied.
- `~/.pi/agent/auth.json` is **never read or exposed**.
- The service worker **never caches** `/api/**` responses or HTML/navigation
  responses. Dynamic local HTML can contain the per-process control token, so
  only non-HTML static assets are eligible for CacheStorage; API and HTML
  responses also send `Cache-Control: no-store`.
- File preview verifies the **real** (symlink-resolved) path stays inside the
  active session's working directory.
- Demo mode uses synthetic data only; write routes return 503 and real pi is
  never spawned.

## What is out of scope

- Plain HTTP LAN access is a **non-E2E compatibility path**. Anyone able to
  observe that network may capture the session cookie; do not expose it to
  the public Internet or describe it as production-safe remote access.
- Reverse proxies or TLS terminators that hide the peer address, rewrite the
  Host to loopback, or rely on forwarded headers are not a supported trusted
  deployment boundary. Use the default direct loopback path unless you can
  preserve PiHub's request identity checks end to end.
- Revocation blocks future requests and closes SSE streams bound to the
  revoked session. It does not cancel an operation that was already accepted
  and is in flight.
- One-use bootstrap consumption is guaranteed by the current single-process,
  in-memory server design; clustered or multi-process deployment is not
  supported by this guarantee.
- Multi-user authentication is not implemented; the panel is a single-operator
  local tool.
