# PiHub Release Notes — template (v0.x)

> **How to use this file**
> Copy the section below into the release body / GitHub Release when tagging a
> version, fill in the checked boxes, delete what does not apply, and delete
> this note. Write for users, not contributors: lead with the value, keep the
> tone short, and never reference internal project details. The full technical
> change ledger lives in [`CHANGELOG.md`](../CHANGELOG.md) — the release notes
> are the curated, user-facing edition.
>
> Tagging flow: bump the version in `package.json`, add a `[x.y.z]` section to
> `CHANGELOG.md` (Keep a Changelog format), then `git tag vX.Y.Z` on the
> release commit and push the tag.

---

# PiHub v0.x.0

PiHub is a local-first web console for the [pi coding agent](https://pi.dev):
a streaming chat workspace, session trees, model & cost insights, file
previews, and an automation center — all in your browser, all on your
machine.

## Highlights

- [ ] **Multi-session tabs** — keep several conversations open side by side
      and switch between them without losing state; each tab streams its own
      run.
- [ ] **Cost & usage insights** — daily trends, top sessions, per-directory
      token and cost totals, rendered as clean charts.
- [ ] **Session trees** — browse every branch of a conversation, spot fork
      points, and start a new branch with one click.
- [ ] **Automation center** — skills, prompt templates, and declarative
      pipelines with approval gates and live timelines.
- [ ] **Multi-agent views** — read-only visibility into sessions recorded by
      other agent CLIs (Codex / AtomCode), each with its own accent color.

## What's new

- [ ] _(user-facing feature bullets, one line each; value first)_

## Fixed

- [ ] _(bugs users would have noticed; skip internals)_

## Security

- [ ] _(only when this release changes the security boundary — see
      `SECURITY.md`)_

PiHub stays local-first: the panel binds to `127.0.0.1` only, never reads
your agent credentials, and has no cloud service of its own.

## Upgrading

```bash
# pull the new release, then:
npm install && npm run build && npm start   # open http://127.0.0.1:18384
# (npm distribution, when published, replaces the clone step)
```

## Changelog

Full change history: [`CHANGELOG.md`](../CHANGELOG.md).

---

## Release checklist

- [ ] Version bumped in `package.json` (+ `package-lock.json`)
- [ ] `CHANGELOG.md` carries the new `[x.y.z]` section
- [ ] `npm run build` green (typecheck + lint + frontend + server)
- [ ] `npm test` green
- [ ] Demo smoke on the tagged commit (see `docs/demo-script.md`)
- [ ] Release notes pasted into the GitHub / AtomGit release body
- [ ] Demo video attached or linked (rendered via `npm run showcase:record`)
- [ ] Tag pushed: `git push origin vX.Y.Z`
