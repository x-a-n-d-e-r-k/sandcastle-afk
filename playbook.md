# Playbook: from a fresh clone to a working AFK developer

`afk:init` automates the mechanical scaffolding. This covers the parts that need *you* — identities, protection rules, and the one genuinely per-repo spike (preflight). Budget ~30–60 min for a well-behaved repo; longer if your tests need real services.

## 0. Prerequisites

- Docker Desktop (running), Node, git, `jq`.
- `gh` (GitHub) **or** `glab` (GitLab) installed and authenticated as **yourself** on the host.
- Claude access: a Claude subscription (`claude setup-token`) or an Anthropic API key.

## 1. Get the tooling into your repo

The loop runs *inside* the target repo (Sandcastle operates on the current git repo). Copy `.sandcastle/`, `bin/`, `skills/`, `scripts/` into your repo, and merge this repo's `package.json` `dependencies` (`@ai-hero/sandcastle`) + `devDependencies` (`tsx`, `typescript`) + the `afk:*` scripts into yours. Then `npm install` (or pnpm/yarn).

## 2. Configure

```bash
npm run afk:init      # detects stack -> writes afk.config.json
```

**Review `afk.config.json` carefully — especially `preflight`.** That list defines "green" for the whole system. The detector guesses from your `package.json` scripts; fix it so it's the exact set you'd require before a merge (lint, types, unit, integration). Keep e2e OUT of preflight — that's the sentinel's job.

## 3. The preflight spike (the one unavoidable per-repo step)

Confirm your preflight actually runs **green inside the sandbox**, because the agent and reviewer both depend on it. Build the image and run your install + preflight in a throwaway container:

```bash
npm run afk:init -- --build
docker run --rm -v "$PWD":/work -w /work --entrypoint bash <imageName> -lc \
  '<your install cmd> && bash .sandcastle/preflight.sh'
```

Common fixes you may hit (we did): package-manager version pinning (corepack pre-bake — init handles pnpm/yarn), and **tests that need services**. If integration tests need Postgres/etc., either point them at an in-memory/sqlite mode for the sandbox, add the service to the Dockerfile, or move them out of preflight and let CI/sentinel cover them. This step is the equivalent of "Spike B" and is where most of the real work is.

## 4. Two bot identities (implementer ≠ reviewer)

The reviewer must be a **different account** than the implementer so its approval counts (neither platform lets an author approve their own request).

**GitHub:** create two bot accounts, add both as **write collaborators**. Make fine-grained PATs (Contents RW, Pull requests RW, Issues RW, Metadata R). In `.sandcastle/.env`: `GH_TOKEN` = implementer, `FORGE_REVIEW_TOKEN` = reviewer. `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.

**GitLab:** create two **project access tokens** (or bot users) with `api` + `write_repository`, roles Developer/Maintainer. In `.sandcastle/.env`: `GITLAB_TOKEN` = implementer, `FORGE_REVIEW_TOKEN` = reviewer.

## 5. Protection / approval rules (the merge gate)

**GitHub:** branch protection on the default branch → **require 1 approval**, **no required status checks** (preflight-only design). Optionally enable auto-merge. The reviewer's approval (different account) satisfies it.

**GitLab:** protect the default branch; add an **MR approval rule requiring 1 approval** and enable **"Prevent approval by the author"** (and ideally "prevent committers from approving"). Note the gap: GitLab has **no native "request changes"** — the loop emulates it with a `changes-requested` label + a marker comment (see `bin/forge`), and the heal step keys off that. If you'd rather use your **pipeline as the gate**, require the pipeline to pass for merge and simplify the reviewer to approve-only.

## 6. Labels

```bash
npm run afk:init -- --labels    # creates agent-ready, needs-feedback, epic, idea, needs-human, e2e-regression
```

## 7. Smoke test (one throwaway issue)

Use the skill (or `bash .claude/skills/agent-ready-issue/create-issue.sh "<title>" body.md`) to file ONE small, well-scoped agent-ready issue. Then:

```bash
npm run afk            # implements it -> opens a PR/MR
npm run afk:review <n> # independent review -> approve
# merge it (or let auto-merge); confirm the issue closes and the branch line advances
```

If that round-trips cleanly, you're done.

## 8. Go hands-off

```bash
caffeinate -i npm run afk:loop   # keep the machine awake; Ctrl-C to stop
```

Feed it `agent-ready` issues; it works one at a time. A PR that fails to converge after `maxHeal` heals gets the `needs-human` label and is parked.

## External review mode (`reviewMode: "external"`)

Use this when an outside process or team owns review and merge. The loop dispatches and opens the MR, then **waits** — it never reviews or merges itself. The contract:

- **Request changes:** your process submits a GitHub *Request changes* review, or applies the **`changes-requested`** label on GitLab. The loop reads *all* feedback (review summaries, inline threads, comments — via `forge pr-feedback`), heals on the branch, pushes, and clears the signal so you re-review the new commits. Capped at `maxHeal`, then parked `needs-human`.
- **Approve:** the loop waits; **your process merges**. On merge, the loop dispatches the next issue automatically.
- **Plain comments are not a trigger** — you must emit the changes-requested signal. Closing an MR without merging parks its issue (no re-dispatch).

## GitLab — verify these before trusting it (⚠️ untested)

The GitLab backend in `bin/forge` is written from docs and **not validated against a real instance**. On yours, confirm:

- `glab issue list -F json` / `glab mr list -F json` field names (`iid`, `source_branch`, `labels`, `state`, approval fields);
- `pr-list`'s review-state derivation matches your approval setup (the `approved` / `approvals_left` fields);
- the **`changes-requested` label round-trip** for external mode (apply → loop detects `CHANGES_REQUESTED` → heal → `pr-clear-changes` removes it);
- `pr-feedback` note/thread JSON shape (`glab mr note list -F json`) so heal sees the real feedback;
- `pr-changes-count` (heal cap) — on GitLab it counts marker comments; confirm it increments as you expect.

All of these are marked `# VERIFY` in `bin/forge`.

## The honest leaks (don't expect to automate these away)

1. **Preflight is per-repo** — step 3 is real work every time.
2. **Service-dependent tests** are the hardest portability problem, not the forge.
3. **Corporate policy** — your org may forbid bot-merges to protected branches, gate token creation behind SSO, or restrict AI tooling on work repos. Check before relying on this at work.
