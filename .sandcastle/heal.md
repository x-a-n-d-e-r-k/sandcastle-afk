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

# Task

1. **Understand** each requested change and any CI pipeline failure shown above. For a pipeline failure, evaluate whether it's a real defect or residual flakiness and fix the root cause — pure flakes were already retried before this point, so a failure reaching you is likely real. If feedback conflicts with the issue's acceptance criteria, prefer the criteria and note it in your commit.
2. **Fix** on this branch, using TDD where it applies. Keep changes minimal and focused on the feedback.
3. **Preflight (MUST pass before committing)** — run `bash .sandcastle/preflight.sh` and fix until it exits 0.
4. **Commit** — referencing the issue, e.g. `fix(#{{ISSUE_NUMBER}}): address review feedback`.
5. **Push** — `git push`.
6. Output `<promise>COMPLETE</promise>` and stop. (A fresh review will run automatically.)

## Rules

- Do NOT merge the PR, close the issue, or approve your own PR.
- Address the feedback; do not make unrelated changes.
