# Context

You are fixing a pull request that a reviewer **requested changes** on. You are checked out on the PR branch. Address every point raised.

## Pull request

!`forge pr-view {{PR_NUMBER}}`

## Reviewer feedback (address ALL of it)

!`forge pr-feedback {{PR_NUMBER}}`

## CI pipeline failures (if the merge pipeline failed)

!`forge pr-pipeline-failures {{PR_NUMBER}}`

## Diff so far

!`forge pr-diff {{PR_NUMBER}}`

## Linked issue (acceptance criteria)

!`forge issue-view {{ISSUE_NUMBER}}`

{{AGENT_RULES}}

{{HEAL_NOTE}}

# Task

1. **Understand** each requested change and any CI pipeline failure shown above. For a pipeline failure, evaluate whether it's a real defect or residual flakiness and fix the root cause — pure flakes were already retried before this point, so a failure reaching you is likely real. If feedback conflicts with the issue's acceptance criteria, prefer the criteria and note it in your commit.
2. **Fix** on this branch, using TDD where it applies. Keep changes minimal and focused on the feedback.
3. **Preflight (MUST pass before committing)** — run the preflight commands below and fix until they exit 0:

{{PREFLIGHT}}
4. **Commit** — referencing the issue, e.g. `fix(#{{ISSUE_NUMBER}}): address review feedback`.
5. **Push** — `git push`.
6. Output `<promise>COMPLETE</promise>` and stop. (A fresh review runs automatically — but ONLY once a new commit is on the branch.)

**If you are confident a blocking finding is wrong**, don't change code just to satisfy it. Verify first: run the code, reproduce the reviewer's claim. If it's still wrong, post a rebuttal the next reviewer must answer, then stop:
`forge pr-comment {{PR_NUMBER}} --body "[afk:rebuttal] <the finding, quoted> — <why it is wrong, with the evidence you ran>"`
A heal that neither pushes a commit nor posts a rebuttal does not reach review: it is retried, and it counts against the heal budget.

{{UI_VERIFICATION}}

## Rules

- Do NOT merge the PR, close the issue, or approve your own PR.
- Address the feedback; do not make unrelated changes.
