// ---------------------------------------------------------------------------
// Re-review is not stateless (#81).
//
// A fresh review of the same diff could approve what the previous review blocked, and the blocking
// finding simply vanished. The re-review now sees the latest changes-requested review (and any
// `[afk:rebuttal]` posted after it) and must account for every finding before it may approve.
// Rendered into review.md as {{PRIOR_BLOCKING_FINDINGS}}; "" when nothing blocked the PR.
// ---------------------------------------------------------------------------

// What CHANGES_REQUESTED should trigger (#81).
//   - block on the CURRENT head → heal.
//   - block on an OLDER commit, current head not yet reviewed since → re-review: the fix may already be
//     pushed and only the re-review failed (on GitHub the decision stays CHANGES_REQUESTED until a new
//     review lands). Healing again would push nothing and park a fixed PR unreviewed.
//   - block on an OLDER commit, current head ALREADY reviewed since → escalate: the decision still reads
//     CHANGES_REQUESTED because another reviewer's block stands (or our review didn't register).
//     Re-reviewing again would repeat forever, unbudgeted; it needs a human.
// GitLab (no blockingSha) and an unreadable gate keep today's behaviour: heal.
export type CrAction = "heal" | "rereview" | "escalate";
export const changesRequestedAction = (g: { head: string; blockingSha: string; headReviewed?: string } | null): CrAction => {
  if (!g || !g.blockingSha || !g.head || g.blockingSha === g.head) return "heal";
  return g.headReviewed === "true" ? "escalate" : "rereview";
};

export const quote = (s: string): string => s.trim().split("\n").map((l) => `> ${l}`).join("\n");

export const priorFindingsBlock = (blockingBody: string, rebuttal = ""): string => {
  if (!blockingBody.trim()) return "";
  const reb = rebuttal.trim()
    ? `\n\nThe author REBUTTED (instead of changing code). Answer it explicitly — accept it only if you verify it is right:\n\n${quote(rebuttal)}`
    : "";
  return `## Previous blocking review (verify EACH finding against the current head)

A previous review requested changes:

${quote(blockingBody)}${reb}

For every finding above, state in your review body either **"resolved at <file:line>"** (what changed and where) or **"still open"**. If ANY blocking finding is still open — including when the head did not change — you MUST request changes, not approve. An approval that ignores these findings is invalid.`;
};
