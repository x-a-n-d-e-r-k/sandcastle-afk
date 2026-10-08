import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh, shq, type GitIdentity } from "./config.js";

// ---------------------------------------------------------------------------
// Conflict resolution for an open agent PR (#54).
//
// Two defects parked healthy, approved PRs as needs-human:
//   1. The retry budget was a LIFETIME total, so the Nth time main moved under a PR it hit the
//      cap even though every earlier resolution had succeeded. Now it counts CONSECUTIVE
//      failures: every success (mechanical or agent) resets it (forge pr-conflict-retry-clear).
//   2. Every conflict was an agent run. The forge's mergeability check ignores .gitattributes
//      merge drivers (e.g. `CHANGELOG.md merge=union`), so most "conflicts" merge cleanly with
//      plain git. The host now tries `git merge origin/<base>` first and pushes it when clean —
//      no agent, no LLM spend — falling through to the agent only on a real conflict.
// ---------------------------------------------------------------------------

type Run = (cmd: string, cwd: string) => string;

export type MechanicalOutcome = "merged" | "conflicted";

// Merge origin/<base> into origin/<branch> in a throwaway host worktree (so the host checkout
// is never touched) and push on success. Committed as the implement identity (#52), never with
// an AI trailer — no agent is involved. On a conflict the merge is aborted and nothing is
// pushed. Anything else (fetch/push failure) throws for the caller to decide.
export const mechanicalMerge = (o: {
  repo: string; branch: string; base: string; identity: GitIdentity; run?: Run;
  /** Called after a successful push with the head before and after the merge. */
  onMerged?: (oldHead: string, newHead: string) => void;
}): MechanicalOutcome => {
  const run = o.run ?? sh;
  run(`git fetch origin ${shq(o.base)} ${shq(o.branch)}`, o.repo);
  const wt = mkdtempSync(join(tmpdir(), "afk-merge-"));
  try {
    run(`git worktree add --detach ${shq(wt)} ${shq(`origin/${o.branch}`)}`, o.repo);
    const oldHead = run("git rev-parse HEAD", wt).trim();
    const as = `-c user.name=${shq(o.identity.name)} -c user.email=${shq(o.identity.email)}`;
    try {
      run(`git ${as} merge --no-edit ${shq(`origin/${o.base}`)}`, wt);
    } catch {
      try { run("git merge --abort", wt); } catch {}
      return "conflicted";
    }
    run(`git push origin ${shq(`HEAD:refs/heads/${o.branch}`)}`, wt);
    o.onMerged?.(oldHead, run("git rev-parse HEAD", wt).trim());
    return "merged";
  } finally {
    try { run(`git worktree remove --force ${shq(wt)}`, o.repo); } catch {}
    rmSync(wt, { recursive: true, force: true });
    try { run("git worktree prune", o.repo); } catch {}
  }
};

// ---------------------------------------------------------------------------
// Does a mechanical base merge need a re-review?
//
// The forge's conflict check ignores `merge=union`, so a PR that adds a CHANGELOG entry reads as
// conflicting after EVERY landing that also added one. The host merges cleanly, pushes, and the PR
// used to get a full re-review each time (~12 minutes in one consumer) although none of its own
// changes moved. The merge brings in only base changes; when those touch none of the PR's own files
// — or only files merged with `merge=union` (both sides' lines kept, nothing of the PR's rewritten) —
// the PR's change is what was reviewed, so the review stands. An overlap with any other file still
// re-reviews: a clean textual merge of two edits to the same file can still be wrong.
// ---------------------------------------------------------------------------

const names = (out: string): string[] => out.split("\n").map((s) => s.trim()).filter(Boolean);

/** The PR's own files the base merge also changed, minus `merge=union` files. Throws on a git error. */
export const baseMergeOverlap = (o: { repo: string; base: string; oldHead: string; newHead: string; run?: Run }): string[] => {
  const run = o.run ?? sh;
  // The PR's own change as of before the merge: merge-base(oldHead, base)..oldHead.
  const mb = run(`git merge-base ${shq(o.oldHead)} ${shq(`origin/${o.base}`)}`, o.repo).trim();
  const own = new Set(names(run(`git diff --name-only ${shq(mb)} ${shq(o.oldHead)}`, o.repo)));
  const overlap = names(run(`git diff --name-only ${shq(o.oldHead)} ${shq(o.newHead)}`, o.repo)).filter((f) => own.has(f));
  return overlap.filter((f) => !isUnionMerged(o.repo, o.newHead, f, run));
};

// The merge attribute as of the merged commit (the PR's own .gitattributes could differ from the host's).
const isUnionMerged = (repo: string, rev: string, file: string, run: Run): boolean => {
  try { return /: merge: union$/m.test(run(`git check-attr --source ${shq(rev)} merge -- ${shq(file)}`, repo)); }
  catch { return false; }
};

// The base tip to measure an agent resolution against, captured BEFORE the agent runs: if
// main moves again mid-run, the agent still succeeded at what it was asked to do.
export const baseTip = (repo: string, base: string, run: Run = sh): string => {
  run(`git fetch origin ${shq(base)}`, repo);
  return run(`git rev-parse ${shq(`origin/${base}`)}`, repo);
};

// Did the agent's push actually resolve? True iff the pushed branch now contains `sha`.
export const branchContains = (repo: string, branch: string, sha: string, run: Run = sh): boolean => {
  run(`git fetch origin ${shq(branch)}`, repo);
  try { run(`git merge-base --is-ancestor ${shq(sha)} ${shq(`origin/${branch}`)}`, repo); return true; }
  catch { return false; }
};

export type ConflictDeps = {
  maxFailures: number;
  /**
   * Does the PR branch already contain the current base tip (#68)? Then the forge's conflict flag
   * is stale — there is nothing to resolve. Throws on a git error (→ treated as "can't tell").
   */
  alreadyContainsBase: () => boolean;
  /** Consecutive failed resolutions since the last success (forge pr-conflict-retry-count). */
  failures: () => number;
  markAttempt: () => void;
  markResolved: () => void;
  mechanical: () => MechanicalOutcome;
  /** Runs the agent resolver; resolves to whether the PR is resolved afterwards. */
  agent: () => Promise<boolean>;
  escalate: (failures: number) => void;
  log: (m: string) => void;
};

export type ConflictResult = "stale-flag" | "escalated" | "mechanical" | "agent-resolved" | "agent-failed";

export async function handleConflict(pr: number, d: ConflictDeps): Promise<ConflictResult> {
  // A stale forge flag (#68): the branch already contains base, so it cannot conflict with it.
  // "Resolving" it merges nothing, pushes nothing, leaves the flag stale — and every such
  // "success" reset the failure count, so it looped forever, re-reviewing an unchanged head and
  // starving every other PR. Touch nothing; the caller asks the forge to recompute. Fail closed:
  // if the check itself errors, fall through to today's path — never skip a real conflict.
  let stale = false;
  try { stale = d.alreadyContainsBase(); }
  catch (e) { d.log(`stale-flag check for #${pr} errored (${(e as Error).message.split("\n")[0]}) — resolving as usual`); }
  if (stale) {
    d.log(`#${pr} is flagged conflicting but already contains the base tip — stale forge flag, not resolving`);
    return "stale-flag";
  }

  const fails = d.failures();
  if (fails >= d.maxFailures) { d.escalate(fails); return "escalated"; }

  let mech: MechanicalOutcome;
  try { mech = d.mechanical(); }
  catch (e) { d.log(`mechanical merge for #${pr} errored (${(e as Error).message}) — falling back to the agent`); mech = "conflicted"; }
  if (mech === "merged") {
    d.markResolved();
    d.log(`resolved #${pr} mechanically (merge drivers)`);
    return "mechanical";
  }

  // Mark BEFORE the run so a crashed/killed attempt still counts as a failure.
  d.log(`#${pr} has a real conflict -> agent resolve ${fails + 1}/${d.maxFailures}`);
  d.markAttempt();
  if (await d.agent()) { d.markResolved(); return "agent-resolved"; }
  d.log(`agent resolve for #${pr} did not land (${fails + 1}/${d.maxFailures} consecutive)`);
  return "agent-failed";
}
