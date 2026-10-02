// ---------------------------------------------------------------------------
// Heal budget (#69).
//
// maxHeal used to be enforced with pr-changes-count — every changes-requested REVIEW ever posted,
// with no reset. So re-reviews of an unchanged head (e.g. the stale-conflict loop, #68) parked PRs
// "Nx without converging" without a single heal against the latest feedback, and a human who
// un-parked a PR had it re-parked on the next review. The budget now counts heal ATTEMPTS
// ([forge:heal] markers since the last [forge:heal-reset]), marked before each run — the same
// shape as the conflict budget (#54). `forge pr-heal-reset <n>` gives a PR a fresh budget.
// ---------------------------------------------------------------------------

export const healDecision = (healCount: number, maxHeal: number): "heal" | "escalate" =>
  healCount >= maxHeal ? "escalate" : "heal";

// ---------------------------------------------------------------------------
// A heal must PUSH something before the PR is reviewed again (#81).
//
// A heal used to run → clear → re-review unconditionally. A heal that pushed nothing (the agent
// declined to change anything, or its push failed) went straight back to a fresh, stateless review
// of the SAME commit — and on GitHub an approval supersedes the earlier CHANGES_REQUESTED, so a
// blocked PR merged with its blocking finding never addressed. Now:
//   - new head        → the normal follow-up (clear, re-review).
//   - same head, but the healer posted an `[afk:rebuttal]` comment → re-review, which must answer it.
//   - same head, no rebuttal → don't re-review: heal again (still within the budget — every attempt
//     is marked) and tell the healer its previous run pushed nothing. Budget spent → escalate with
//     the open finding quoted.
// ---------------------------------------------------------------------------

export const NOTHING_PUSHED_NOTE =
  "## Your previous heal pushed NOTHING\n\n" +
  "The last heal run ended without a new commit on this branch, so the blocking feedback above is still " +
  "unaddressed and the PR was NOT sent back to review. Either fix it and push, or — if after careful " +
  "verification you believe a finding is wrong — post a rebuttal (see the task) instead of changing code.\n";

export type HealPushDeps = {
  maxHeal: number;
  count: () => number;
  mark: () => void;
  /** Run the heal agent; `note` is injected into its prompt (e.g. NOTHING_PUSHED_NOTE). May throw. */
  heal: (note: string) => Promise<void>;
  /** The PR branch's head SHA on origin (synced). */
  head: () => string;
  /** How many `[afk:rebuttal]` comments the PR has (to see whether this run posted one). */
  rebuttals: () => number;
  /** A new head landed: clear + re-review (or await an external reviewer). */
  afterPush: () => Promise<void>;
  /** No push, but a rebuttal: re-review, which must answer it. */
  afterRebuttal: () => Promise<void>;
  /** Budget spent; `openFinding` is what is still unaddressed. */
  escalate: (count: number, openFinding: string) => void;
  /** The finding a no-push escalation should quote (e.g. the blocking review body). */
  openFinding: () => string;
  /** Stop requested (afk:stop / Ctrl-C)? Checked between attempts, so retries never block a stop. */
  shouldStop?: () => boolean;
  log: (m: string) => void;
};

export type HealPushOutcome = "pushed" | "rebutted" | "escalated" | "stopped";

export async function healUntilPushed(pr: number, why: string, d: HealPushDeps): Promise<HealPushOutcome> {
  let note = "";
  // Bounded by THIS call's attempts as well as the forge count: a count that never moves (GitLab's
  // note list failing reads as 0) must not turn no-push retries into an endless in-cycle loop.
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0 && d.shouldStop?.()) { d.log(`PR #${pr}: stop requested — no further heal attempts`); return "stopped"; }
    const n = d.count();
    if (healDecision(Math.max(n, attempt), d.maxHeal) === "escalate") { d.escalate(Math.max(n, attempt), d.openFinding()); return "escalated"; }
    const before = d.head(), rebuttalsBefore = d.rebuttals();
    d.log(`PR #${pr} ${why} -> heal ${Math.max(n, attempt) + 1}/${d.maxHeal}${note ? " (previous heal pushed nothing)" : ""}`);
    d.mark();
    await d.heal(note);
    if (d.head() !== before) { await d.afterPush(); return "pushed"; }
    if (d.rebuttals() > rebuttalsBefore) {
      d.log(`PR #${pr}: heal posted a rebuttal instead of a change -> re-review must answer it`);
      await d.afterRebuttal();
      return "rebutted";
    }
    d.log(`PR #${pr}: heal pushed nothing (head still ${before.slice(0, 8)}) — not re-reviewing; healing again`);
    note = NOTHING_PUSHED_NOTE;
  }
}
