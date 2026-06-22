# sandcastle-afk

An opinionated, **forge-agnostic AFK-developer loop** on top of [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle).

You file an **agent-ready** issue. An agent implements it with TDD in an isolated Docker sandbox, runs your preflight, pushes a branch, and opens a PR/MR. A **second, independent agent** (different model + identity) re-runs the preflight from scratch and approves or requests changes. On approval it merges; on changes it heals and re-reviews. One issue at a time, forever. Works with **GitHub or GitLab**.

> This is a layer *on top of* Sandcastle, not a fork. Sandcastle is an npm dependency.

## How it works

```
agent-ready issue ──▶ implement (TDD + preflight) ──▶ PR/MR (Closes #N)
                                                          │
                                   independent reviewer ◀─┘
                                   (re-runs preflight = the trust anchor)
                                          │
                         approve ─────────┼───────── request changes
                            │                              │
                         merge ◀── (branch protection)   heal ──▶ re-review
```

There is **no CI gate** by default — the reviewer's independent preflight re-run *is* the gate. (On GitLab you can swap in the pipeline; see `playbook.md`.)

## Quickstart

```bash
# 1. From the root of YOUR repo, drop the tooling in (one command):
curl -fsSL https://raw.githubusercontent.com/x-a-n-d-e-r-k/sandcastle-afk/main/bootstrap.sh | bash
npm install   # (or pnpm / yarn)

# 2. Detect the stack, render the Dockerfile, install the skill
npm run afk:init           # review afk.config.json — especially `preflight`
npm run afk:init -- --build --labels

# 3. Identities, tokens, branch protection — see playbook.md
cp .sandcastle/.env.example .sandcastle/.env   # then fill it in

# 4. Smoke test, then go hands-off
npm run afk            # implement the next agent-ready issue -> PR
npm run afk:review 42  # independently review PR #42
npm run afk:loop       # the daemon: dispatch -> review -> heal -> merge, forever
```

## Commands

| Command | What it does |
|---|---|
| `afk:init [--build] [--labels]` | Detect stack, write `afk.config.json`, render Dockerfile + preflight, install the skill |
| `afk` | Single dispatch: implement the next `agent-ready` issue → PR/MR |
| `afk:review <n>` | Independently review one PR/MR (different model + reviewer identity) |
| `afk:loop` | The orchestrator daemon (concurrency 1) — dispatch, review, heal, merge |
| `afk:sentinel` | Out-of-band e2e regression sentinel (files agent-ready issues for genuine failures) |

## The `forge` adapter

Everything talks to the host through `bin/forge` — a thin shim over `gh` (GitHub) and `glab` (GitLab) exposing normalized verbs (`issue-list`, `pr-create`, `pr-approve --as-reviewer`, `pr-merge`, …). Swap platforms by setting `platform` in `afk.config.json`. Adding a third forge = one new backend in `bin/forge`.

## Configuration (`afk.config.json`)

`platform`, `defaultBranch`, `packageManager` (+version), `dockerBaseImage`, `install`, **`preflight`** (the gate — the command list that defines "green"), `e2e`, `models`, `labels`, `maxHeal`, `pollMinutes`. The `preflight` list is the single source of truth — the skill writes it into issues, the implementer must pass it, the reviewer re-runs it.

## Review modes

`reviewMode` in `afk.config.json`:

- **`internal`** (default) — the loop runs its own independent AI reviewer (different model + identity) and merges on approval. Fully self-contained.
- **`external`** — an outside process (your own review pipeline, a human, a team) owns review and merge. The loop dispatches, opens the PR/MR, then **waits**: it never runs its own reviewer and never merges. It only reacts to a structured signal:
  - **changes requested** (a GitHub *Request changes* review, or the `changes-requested` label on GitLab) → the loop **heals**: it reads *all* the review feedback (summaries, inline threads, comments), fixes on the branch, pushes, and clears the signal so your process re-reviews. Capped at `maxHeal`, then parked as `needs-human`.
  - **approved** → the loop does nothing and waits for your process to merge.
  - on merge (by anyone) → the PR leaves the open list and the loop dispatches the next issue.

  Plain comments alone are **not** a trigger — your process must emit the changes-requested signal. A PR closed *without* merging parks its issue (the loop won't re-dispatch it).

The loop is stateless across cycles — it re-derives everything from open PRs + ready issues each poll — so an external merge is detected automatically with no special handling.

## File map

```
bin/forge                     the GitHub/GitLab adapter (the seam)
afk.config.example.json       config schema
.sandcastle/
  config.ts                   loads config, exposes forge() + helpers
  implement.md review.md heal.md   the agent prompts (forge-routed)
  main.ts review.ts loop.ts sentinel.ts   the runners
  Dockerfile.template         rendered by init
scripts/init.ts               the wizard
skills/agent-ready-issue/     the issue-authoring skill (templated)
playbook.md                   the manual setup (identities, protection, the preflight spike)
```

## Status & honest caveats

- **GitHub path is validated.** The **GitLab path is best-effort** — the `glab` JSON shapes, the "request changes" emulation (GitLab has no native equivalent; we use a `changes-requested` label + marker comment), and the approval-rule setup need validation on your instance. Verify-points are marked in `bin/forge`.
- **Preflight is irreducibly per-repo.** Getting `preflight` to run green inside the sandbox is a per-repo spike (see `playbook.md`).
- **Tests that need real services** (Postgres, etc.) make the sandbox much harder — you'll need docker-in-docker or service containers in the Dockerfile.
- **The usage-limit detection regexes** in `loop.ts` are best-effort; tune them the first time a real limit fires.

Built on [Sandcastle](https://github.com/mattpocock/sandcastle) by Matt Pocock.
