# Context

## Issue to implement

!`forge issue-view {{ISSUE_NUMBER}}`

{{AGENT_RULES}}

# Task

You are an autonomous coding agent. Implement the single issue above, end to end, on the current git branch, using test-driven development.

## Workflow

1. **Explore** — read the issue, including its Placement section. Read the relevant files and the nearby existing tests to learn the conventions (layout, export style, test style) before writing code.
2. **Red** — write a failing test that encodes the acceptance criteria.
3. **Green** — implement the minimal code to pass; export/wire it appropriately.
4. **Refactor** — tidy up while keeping the test green.
5. **Preflight (MUST pass before committing)** — run `bash .sandcastle/preflight.sh` and fix until it exits 0.
6. **Commit** — one focused commit referencing the issue number.
7. **Push** — `git push -u origin HEAD`.
8. **Open a PR** — target `{{BASE_BRANCH}}`. The body MUST contain `Closes #{{ISSUE_NUMBER}}` so the issue closes on merge:
   `forge pr-create --base {{BASE_BRANCH}} --title "<concise conventional title>" --body "Closes #{{ISSUE_NUMBER}}"`
9. When the PR is open, output `<promise>COMPLETE</promise>` and stop.

## Rules

- Implement only this one issue. Keep the change minimal and focused; do not touch unrelated files.
- Do NOT merge the PR and do NOT close the issue — leave it open for review.
- If preflight cannot be made green, do not push; explain the blocker and stop.
