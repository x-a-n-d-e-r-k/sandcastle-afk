# Context

You are resolving merge conflicts on a pull-request branch so it can merge into
`{{BASE_BRANCH}}`. You are checked out on the PR branch. `{{BASE_BRANCH}}` has
advanced since this branch was created and now conflicts with it.

## Pull request

!`forge pr-view {{PR_NUMBER}}`

## Linked issue (acceptance criteria — preserve this branch's intent)

!`forge issue-view {{ISSUE_NUMBER}}`

## Issue discussion (comments on the issue — read them; they often refine or amend the body)

!`forge issue-discussion {{ISSUE_NUMBER}} || echo "(Could not load the issue's comments. Run: forge issue-discussion {{ISSUE_NUMBER}} — yourself, before relying on the body alone.)"`

Comments can clarify, extend or change the requirements above. Where a later comment conflicts with the body, follow the comment and say so in your PR/review.

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
4. **Preflight (MUST pass before committing)** — run the preflight commands below
   and fix until they exit 0. A merge can break code even with every marker removed.

{{PREFLIGHT}}
5. **Commit the merge** — `git commit` (note any judgment call in the message).
6. **Push** — `git push`.
7. Output `<promise>COMPLETE</promise>` and stop. (A fresh review runs automatically.)

{{UI_VERIFICATION}}

## Rules

- Do NOT merge the PR, close the issue, or approve your own PR.
- Resolve ONLY the conflicts; make no unrelated changes.
- Both sides' work matters — integrate, don't discard.
