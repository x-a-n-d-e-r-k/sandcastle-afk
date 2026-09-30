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

export type HealDeps = {
  maxHeal: number;
  /** Heal attempts since the last reset (forge pr-heal-count). */
  count: () => number;
  /** forge pr-heal-mark — called BEFORE the heal, so a crashed/killed heal still counts. */
  mark: () => void;
  /** The heal itself (sandbox run + follow-up). May throw. */
  heal: () => Promise<void>;
  escalate: (count: number) => void;
  log: (m: string) => void;
};

export async function healWithBudget(pr: number, why: string, d: HealDeps): Promise<"healed" | "escalated"> {
  const n = d.count();
  if (healDecision(n, d.maxHeal) === "escalate") { d.escalate(n); return "escalated"; }
  d.log(`PR #${pr} ${why} -> heal ${n + 1}/${d.maxHeal}`);
  d.mark();
  await d.heal();
  return "healed";
}
