// ---------------------------------------------------------------------------
// Re-review is not stateless (#81).
//
// A fresh review of the same diff could approve what the previous review blocked, and the blocking
// finding simply vanished. The re-review now sees the latest changes-requested review (and any
// `[afk:rebuttal]` posted after it) and must account for every finding before it may approve.
// Rendered into review.md as {{PRIOR_BLOCKING_FINDINGS}}; "" when nothing blocked the PR.
// ---------------------------------------------------------------------------

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
