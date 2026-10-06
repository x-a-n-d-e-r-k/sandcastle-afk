// ---------------------------------------------------------------------------
// A review that ends WITHOUT a verdict is counted, not silently re-dispatched.
//
// The reviewer runs with maxIterations 1. A reviewer that backgrounds a slow preflight and ends its
// turn "to wait for the notification" ends the session: no approve / request-changes is posted, the
// PR still reads "needs review", and the next cycle started a fresh reviewer that restarted preflight
// from zero — again and again, each costing minutes, with nothing in the log to say why.
//
// A review run that ends without its completion signal (the prompt's last step, after posting the
// verdict) is a no-verdict review. Each one is recorded on the PR as a marker comment keyed by the
// head SHA, logged as `review of #N ended without a verdict (k/max)`, and at the cap the PR is parked
// with needsHuman. A new head starts a fresh count (it is a different review). A human who un-parks the
// PR (removes needsHuman) gets one more review: a verdict ends it, another no-verdict parks it again.
// Counting needs no comment ORDER (GitLab's note list isn't sorted), only occurrences.
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_REVIEW_NO_VERDICT = 3;
export const noVerdictMarker = (head: string): string => `[afk:review-no-verdict head=${head}]`;

/** No-verdict reviews of `head` recorded in `feedback` (the PR's comments). */
export const countNoVerdict = (feedback: string, head: string): number =>
  feedback.split(noVerdictMarker(head)).length - 1;

export type ReviewVerdictDeps = {
  max: number;
  /** The PR head SHA being reviewed (synced from origin). */
  head: () => string;
  /** Run the reviewer; resolves with its completion signal (undefined: it ended without one). May throw. */
  review: () => Promise<{ completionSignal?: string }>;
  /** The PR's comments, where the markers live. */
  feedback: () => string;
  mark: (marker: string) => void;
  /**
   * A run that THREW but is still the reviewer's own failure to finish — an idle timeout (it sat waiting
   * on a background preflight instead of ending its turn). Counted like a no-verdict end, then rethrown.
   * Infra failures (Docker, usage limits) are not: they'd park healthy PRs.
   */
  isNoVerdictError?: (e: unknown) => boolean;
  /** At the cap: park the PR for a human. */
  escalate: (count: number, head: string) => void;
  log: (m: string) => void;
};

export type ReviewVerdictOutcome = "verdict" | "no-verdict" | "escalated";

// This process's own tally per PR head: the floor under the forge count, so a comment list that can't
// be read (counts 0) or a marker that failed to post can't turn the cap into an endless re-dispatch.
const tally = new Map<string, number>();

export async function reviewForVerdict(pr: number, d: ReviewVerdictDeps): Promise<ReviewVerdictOutcome> {
  const head = d.head();
  const key = `${pr}@${head}`;
  let r: { completionSignal?: string };
  try { r = await d.review(); }
  catch (e) {
    if (d.isNoVerdictError?.(e)) recordNoVerdict(pr, head, key, d, ` (${(e as Error)?.message?.split("\n")[0] ?? "run error"})`);
    throw e;
  }
  if (r.completionSignal !== undefined) { tally.delete(key); return "verdict"; }
  return recordNoVerdict(pr, head, key, d, "");
}

function recordNoVerdict(pr: number, head: string, key: string, d: ReviewVerdictDeps, why: string): ReviewVerdictOutcome {
  const local = (tally.get(key) ?? 0) + 1;
  tally.set(key, local);
  let forgeCount = 0;
  try { d.mark(noVerdictMarker(head)); forgeCount = countNoVerdict(d.feedback(), head); }
  catch (e) { d.log(`PR #${pr}: could not record the no-verdict review (${(e as Error).message.split("\n")[0]})`); }
  const n = Math.max(forgeCount, local);
  d.log(`review of #${pr} ended without a verdict (${n}/${d.max}) — head ${head.slice(0, 8)}${why}`);
  if (n >= d.max) { tally.delete(key); d.escalate(n, head); return "escalated"; }
  return "no-verdict";
}
