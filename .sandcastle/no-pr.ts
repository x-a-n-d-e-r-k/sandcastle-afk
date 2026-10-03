import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// An implement run that ends WITHOUT a PR must not be re-dispatched forever (#86).
//
// The only dispatch cap was maxResume, which counts checkpoint resumes after a KILLED run; a run that
// exits cleanly without a PR (the agent correctly found the issue needs an owner decision, said so,
// and stopped) leaves no checkpoint, so nothing capped it — and the loop logged "opened PR" anyway.
// One consumer burned ~310 sessions in 8 hours on a single such issue. Now, after every implement run:
//   - a PR for agent/issue-<n> exists           → success (only then is "opened PR" logged).
//   - the agent said <promise>BLOCKED</promise> → escalate now (needs a human decision).
//   - otherwise, a no-PR attempt is recorded as an issue marker carrying a FINGERPRINT of the issue
//     body + its maintainer discussion; after maxNoPrRuns attempts on the SAME fingerprint → escalate.
//     A body edit or a new maintainer comment (the answer to the blocker) changes the fingerprint, so
//     the count starts over by itself; `[afk:no-pr-reset]` resets it explicitly.
// ---------------------------------------------------------------------------

export const BLOCKED_SIGNAL = "<promise>BLOCKED</promise>";
export const NO_PR_MARKER = "[afk:no-pr";
export const NO_PR_RESET = "[afk:no-pr-reset]";
export const DEFAULT_MAX_NO_PR_RUNS = 2;

/** Stable fingerprint of what the agent was asked to do: the body plus the maintainer discussion. */
export const issueFingerprint = (body: string, discussion: string): string =>
  createHash("sha256").update(`${body}\n\u0000\n${discussion}`).digest("hex").slice(0, 12);

export const noPrMarker = (fp: string): string => `${NO_PR_MARKER} fp=${fp}]`;

/** No-PR attempts recorded for THIS fingerprint since the last explicit reset. */
export const countNoPr = (comments: string, fp: string): number => {
  const i = comments.lastIndexOf(NO_PR_RESET);
  const tail = i === -1 ? comments : comments.slice(i + NO_PR_RESET.length);
  return tail.split(noPrMarker(fp)).length - 1;
};

/** The agent's closing words, for the escalation comment (its reason for stopping, usually). */
export const lastWords = (stdout: string, max = 1500): string => {
  const t = stdout.replace(new RegExp(BLOCKED_SIGNAL.replace(/[<>/]/g, "\\$&"), "g"), "").trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
};

export type AfterImplementDeps = {
  maxNoPrRuns: number;
  /** Is there an open PR for agent/issue-<n>? */
  prOpened: () => boolean;
  /** The implement run's stdout ("" if unavailable). */
  stdout: string;
  fingerprint: () => string;
  /** Raw issue comments (markers included). */
  comments: () => string;
  mark: (marker: string) => void;
  escalate: (reason: string, agentSaid: string) => void;
  log: (m: string) => void;
};

export type AfterImplement = "pr-opened" | "no-pr" | "escalated";

export function afterImplement(issue: number, d: AfterImplementDeps): AfterImplement {
  if (d.prOpened()) { d.log(`opened PR for #${issue}`); return "pr-opened"; }
  const said = lastWords(d.stdout);
  if (d.stdout.includes(BLOCKED_SIGNAL)) {
    d.log(`#${issue}: implement ended BLOCKED (needs a human decision) -> escalating`);
    d.escalate("the implement agent reported it is BLOCKED on a decision it can't make", said);
    return "escalated";
  }
  const fp = d.fingerprint();
  const prior = countNoPr(d.comments(), fp);
  d.mark(noPrMarker(fp));
  const n = prior + 1;
  if (n >= d.maxNoPrRuns) {
    d.log(`#${issue}: ${n} implement run(s) ended without a PR on an unchanged issue -> escalating`);
    d.escalate(`${n} implement run(s) ended without opening a PR, and the issue (body + maintainer comments) hasn't changed in between`, said);
    return "escalated";
  }
  d.log(`#${issue}: implement ended WITHOUT a PR (${n}/${d.maxNoPrRuns} on this version of the issue)`);
  return "no-pr";
}
