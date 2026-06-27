# Context

You are resolving merge conflicts on a pull-request branch so it can merge into
`{{BASE_BRANCH}}`. You are checked out on the PR branch. `{{BASE_BRANCH}}` has
advanced since this branch was created and now conflicts with it.

## Pull request

!`forge pr-view {{PR_NUMBER}}`

## Linked issue (acceptance criteria — preserve this branch's intent)

!`forge issue-view {{ISSUE_NUMBER}}`

{{AGENT_RULES}}

# Task

1. **Merge the base branch in:** `git fetch origin {{BASE_BRANCH}} && git merge origin/{{BASE_BRANCH}}`.
2. **Resolve every conflict.** `git status` lists the conflicted files. For each
   `<<<<<<< / ======= / >>>>>>>` block, **keep BOTH sides' intent** — your branch's
   change *and* the change that landed on `{{BASE_BRANCH}}` are both wanted.
   Integrate them; do not delete one side to make the conflict go away. Only if two
   changes are genuinely mutually exclusive, prefer the linked issue's acceptance
   criteria and say so in the merge commit.
3. **Verify no markers remain:** `git diff --check` is clean and `git status` shows
   no unmerged paths.
4. **Preflight (MUST pass before committing)** — run `bash .sandcastle/preflight.sh`
   and fix until it exits 0. A merge can break code even with every marker removed.
5. **Commit the merge** — `git commit` (note any judgment call in the message).
6. **Push** — `git push`.
7. Output `<promise>COMPLETE</promise>` and stop. (A fresh review runs automatically.)

## Rules

- Do NOT merge the PR, close the issue, or approve your own PR.
- Resolve ONLY the conflicts; make no unrelated changes.
- Both sides' work matters — integrate, don't discard.
