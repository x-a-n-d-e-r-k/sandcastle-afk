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

The reviewer's independent preflight is a fast pre-merge check. **On a forge with CI, the loop also gates the merge on the pipeline** — it waits for a running pipeline, retries flaky failures (`maxPipelineRetry`), and routes real failures (with the failed-job logs) to the heal agent before merging. If there's no pipeline, the reviewer's preflight is the gate.

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
| `afk:update [--dry-run] [--base-latest] [--from <src>] [--force]` | Pull layer updates into this project (preserves config/secrets); optionally bump the `@ai-hero/sandcastle` base |
| `afk` | Single dispatch: implement the next `agent-ready` issue → PR/MR |
| `afk:review <n>` | Independently review one PR/MR (different model + reviewer identity) |
| `afk:loop` | The orchestrator daemon (concurrency 1) — dispatch, review, heal, merge |
| `afk:sentinel` | Out-of-band e2e regression sentinel (files agent-ready issues for genuine failures) |

## Staying up to date (`afk:update`)

The loop's tooling is a **layer** you copy into your project (via `bootstrap.sh`). When the layer ships fixes or new commands, `pnpm afk:update` pulls them in **without clobbering your local config or secrets**:

```bash
pnpm afk:update --dry-run      # show what WOULD change; writes nothing
pnpm afk:update                # apply layer updates
pnpm afk:update --base-latest  # also bump @ai-hero/sandcastle to npm's latest
pnpm afk:update --from ../sandcastle-afk   # sync from a local checkout instead of the default repo
```

**Managed vs preserved.** `afk:update` overwrites the files the layer *tracks* under `bin/`, `.sandcastle/`, `skills/`, and `scripts/`, and merges the layer's `afk:*` scripts into your `package.json`. It **never** touches your `afk.config.json`, `.sandcastle/.env*`, the generated `Dockerfile`/`preflight.sh`, or project-only files the layer doesn't ship (e.g. your `.sandcastle/house-rules.md`) — they survive untouched (it does not mirror-delete).

**Source.** By default it syncs from `https://github.com/x-a-n-d-e-r-k/sandcastle-afk`. Pin a different source with the `layerRepo` field in `afk.config.json`, or override per-run with `--from <git-url|path>`. URLs are shallow-cloned to a temp dir; the synced layer SHA is recorded in `.sandcastle/.layer-sync.json` (gitignored local state).

**Base bump caveat.** With `--base-latest` (or when the layer's pin moves), the `@ai-hero/sandcastle` version in your `package.json` changes — you must then run `pnpm install --frozen-lockfile` **while the loop is stopped** (don't reinstall mid-run). `afk:update` refuses to run while a loop process is detected and on a dirty tree (override either with `--force`). After updating: review `git diff`, install if the base changed, then `pnpm afk:stop && pnpm afk:loop`.

## The `forge` adapter

Everything talks to the host through `bin/forge` — a thin shim over `gh` (GitHub) and `glab` (GitLab) exposing normalized verbs (`issue-list`, `pr-create`, `pr-approve --as-reviewer`, `pr-merge`, …). Swap platforms by setting `platform` in `afk.config.json`. Adding a third forge = one new backend in `bin/forge`.

## Configuration (`afk.config.json`)

`layerRepo` (optional — the sandcastle-afk source `pnpm afk:update` pulls from; defaults to this repo), `platform`, `reviewMode`, `defaultBranch`, `packageManager` (+version), `dockerBaseImage`, `install`, **`preflight`** (the gate — the command list that defines "green"), `e2e`, `models`, `labels`, `maxHeal`, `maxPipelineRetry` (flake-retry budget before a CI failure is treated as real), `flakyJobs` (optional allowlist — only retry when the failed jobs are all in this list; empty = retry on any failure), **`priorityLabels`** (ordered most-urgent-first, default `["highest","high","low","lowest"]`), `pollMinutes`. The `preflight` list is the single source of truth — the skill writes it into issues, the implementer must pass it, the reviewer re-runs it.

**Prioritizing issues:** the loop dispatches by **priority label first**, then `fix:`-titled before others, then oldest issue number. Add a `priorityLabels` label (e.g. `highest`/`high`/`low`/`lowest`) to bump or sink an issue; an `agent-ready` issue with **no** priority label sits in the middle (between `high` and `low`). `pnpm afk:init --labels` creates the priority labels. (Since the loop only pulls `agent-ready` and works one at a time, applying/withholding `agent-ready` is itself a coarse queue control.)

## Review modes

`reviewMode` in `afk.config.json`:

- **`internal`** (default) — the loop runs its own independent AI reviewer (different model + identity) and merges on approval. Fully self-contained.
- **`external`** — an outside process (your own review pipeline, a human, a team) owns review and merge. The loop dispatches, opens the PR/MR, then **waits**: it never runs its own reviewer and never merges. It only reacts to a structured signal:
  - **changes requested** (a GitHub *Request changes* review, or the `changes-requested` label on GitLab) → the loop **heals**: it reads *all* the review feedback (summaries, inline threads, comments), fixes on the branch, pushes, and clears the signal so your process re-reviews. Capped at `maxHeal`, then parked as `needs-human`.
  - **approved** → the loop does nothing and waits for your process to merge.
  - on merge (by anyone) → the PR leaves the open list and the loop dispatches the next issue.

  Plain comments alone are **not** a trigger — your process must emit the changes-requested signal. A PR closed *without* merging parks its issue (the loop won't re-dispatch it).

The loop is stateless across cycles — it re-derives everything from open PRs + ready issues each poll — so an external merge is detected automatically with no special handling.

## Agent rules (house rules)

`agentRules` injects a shared ruleset into **every agent prompt** — the implementer, the healer, *and* the reviewer all see it. It's a list of **sources**, each a local file path or a URL. `pnpm afk:rules` (also run by `afk:init`) fetches/reads them, concatenates to `.sandcastle/agent-rules.md` (gitignored), and the runners inline it. No network at run time; re-run `afk:rules` to refresh.

```jsonc
"agentRules": [
  "https://raw.githubusercontent.com/DietrichGebert/ponytail/main/AGENTS.md",  // a URL
  ".sandcastle/house-rules.md"                                                 // a local file
]
```

### Use cases

**1. Make agents write less code.** Point at [ponytail](https://github.com/DietrichGebert/ponytail)'s ruleset (a YAGNI "laziness ladder" — reach for stdlib / native / a one-liner before building). One line:

```json
"agentRules": ["https://raw.githubusercontent.com/DietrichGebert/ponytail/main/AGENTS.md"]
```

Now the implementer stops over-building and the reviewer flags over-engineering — without you running ponytail's plugin in the headless sandbox.

**2. Your own conventions.** Write a local file and reference it:

```json
"agentRules": [".sandcastle/house-rules.md"]
```
```md
<!-- .sandcastle/house-rules.md -->
- Use the existing `logger` wrapper; never `console.log`.
- No new runtime dependencies without a note in the PR body.
- Match the error-handling pattern in `src/errors.ts`.
- Reuse the test factories in `test/factories/`; don't invent new ones.
```

**3. Combine them.** ponytail for terseness *and* your conventions for consistency — list both; they're concatenated in order.

### Notes

- Applies to **implement, heal, and review** (the reviewer enforces the same rules it was written under).
- It's guidance layered onto the prompt, **not** a hard constraint — the gates (preflight, reviewer, pipeline) still decide what merges, so "write less code" can never bypass correctness, validation, or tests.
- Empty list (default) = no-op.

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

## Validation status — read before relying on this

This is a v0.1. Be precise about what has actually been exercised:

- **✅ Validated** — run end-to-end and observed working.
- **🧪 Built** — code-complete, type-checked / syntax-checked, but **not yet run end-to-end**.
- **⚠️ Best-effort** — **GitLab**: written from docs, **not tested against a real instance**; marked `# VERIFY` in `bin/forge`.

| Component | GitHub | GitLab |
|---|---|---|
| `bootstrap.sh` (curl-pipe install + package.json merge) | ✅ | ✅ (platform-agnostic) |
| `afk:init` (stack detect, Dockerfile/preflight/skill render) | ✅ | ✅¹ |
| `forge` read verbs (issue/pr list, view, diff) | ✅ | ✅¹ |
| `forge` write verbs (create, approve, merge, label, comment) | 🧪 (map to verbs proven in the source project) | ✅¹ |
| **Internal** review mode (loop reviews + merges) | ✅ (implement → PR → independent review → merge) | ✅¹ (self-hosted) |
| **External** review mode (request-changes → heal, aggregated feedback, wait-for-external-merge) | 🧪 | ⚠️ |
| Heal step / `maxHeal` escalation | 🧪 | ⚠️ |
| Pipeline-aware merge gate (wait / flake-retry / heal real CI failures) | 🧪 | 🧪² |
| e2e sentinel | 🧪 (needs `playwright install` + a validation run) | 🧪 |
| Usage-limit guard | 🧪 — **detection regexes are guesses; tune on the first real limit** | 🧪 |

> ¹ Validated end-to-end against a **live self-hosted GitLab** instance, internal mode, in [issue #1](https://github.com/x-a-n-d-e-r-k/sandcastle-afk/issues/1) — which surfaced the `forge`/`init` fixes now applied. The GitHub single-issue happy path was validated in the project this was extracted from. **Still untested: GitLab *external* mode and the heal/changes-requested path** — treat those as a debugging session, not a clean install. `playbook.md` lists the remaining verify-points.
>
> ² The merge-stall this fixes (glab arming merge-when-pipeline-succeeds, then a flaky job canceling it) was observed live on self-hosted GitLab in [issue #2](https://github.com/x-a-n-d-e-r-k/sandcastle-afk/issues/2). The wait/retry/heal **fix** and the new pipeline `forge` verbs are built and type-checked but **not yet validated end-to-end**.

### Caveats that aren't about validation (they're inherent)

- **Preflight is irreducibly per-repo.** Getting `preflight` green inside the sandbox is a per-repo spike (see `playbook.md`).
- **Tests that need real services** (Postgres, etc.) make the sandbox much harder — docker-in-docker or service containers in the Dockerfile.
- **Corporate policy** may forbid bot-merges to protected branches, gate token creation behind SSO, or restrict AI tooling — check before relying on this at work.

Built on [Sandcastle](https://github.com/mattpocock/sandcastle) by Matt Pocock.
