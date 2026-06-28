// @ts-ignore — plain .mjs helper, reused verbatim (do NOT reimplement parsing).
import { parseBlockers } from "../scripts/auto-unblock/parse-blockers.mjs";

// Shared idempotency marker: the sweep and the follow-up needs-feedback agent both
// prefix their audit comment with this so neither re-comments on the other's work.
export const TRIAGE_MARKER = "[afk-triage]";

// Confidence gate for the needs-feedback re-evaluation agent. The LLM scores each
// parked question 0–10; this maps that to an action. Both thresholds are inclusive of
// the higher tier: `>= high` promotes, `>= med` proposes, anything lower is left alone.
export function triageAction(
  confidence: number,
  t: { high: number; med: number },
): "promote" | "propose" | "skip" {
  if (confidence >= t.high) return "promote";
  if (confidence >= t.med) return "propose";
  return "skip";
}

type BlockedIssue = { number: number; body?: string; labels: string[] };

// The blocker-sweep's closed-check, as a pure function over an issue detail so the REAL
// wiring (not a test mock) is covered. `state` comes from `forge issue-view`; if forge
// ever omits it again (the bug this fixes), `d.state` is undefined and this is false —
// the regression the triage test locks. Compares against forge's lowercased vocabulary.
export const isIssueClosed = (d: { state?: string }): boolean => d.state === "closed";

// Cadence guard: true on the first idle pass (lastTriageAtMs === null) or once the
// interval has fully elapsed. `>=` makes the interval boundary inclusive.
export function shouldRunTriage(
  nowMs: number,
  lastTriageAtMs: number | null,
  intervalMs: number,
): boolean {
  return lastTriageAtMs === null || nowMs - lastTriageAtMs >= intervalMs;
}

// A `blocked` issue is unblockable iff it names at least one blocker AND every named
// blocker is closed. Non-`blocked` issues and `blocked`-but-unparseable bodies are out.
export function selectUnblockableIssues(
  issues: BlockedIssue[],
  isClosed: (issueNumber: number) => boolean,
): number[] {
  return issues
    .filter((i) => i.labels.includes("blocked"))
    .filter((i) => {
      const blockers: number[] = parseBlockers(i.body);
      return blockers.length > 0 && blockers.every(isClosed);
    })
    .map((i) => i.number);
}

type SweepDeps = {
  listBlocked(): BlockedIssue[];
  isClosed(n: number): boolean;
  promote(n: number): void;
  hasMarkerComment(n: number): boolean;
  comment(n: number, body: string): void;
};

// Deterministic blocker-sweep backstop for the event-driven auto-unblock workflow.
// Promotes every fully-unblocked issue (label flip is self-idempotent) and leaves a
// single marker comment as the audit trail (guarded so it is never duplicated).
export function sweepBlockedIssues(deps: SweepDeps): number[] {
  const selected = selectUnblockableIssues(deps.listBlocked(), deps.isClosed);
  for (const n of selected) {
    deps.promote(n);
    if (!deps.hasMarkerComment(n)) {
      deps.comment(n, `${TRIAGE_MARKER} blockers all closed — promoted to agent-ready.`);
    }
  }
  return selected;
}
