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
}): MechanicalOutcome => {
  const run = o.run ?? sh;
  run(`git fetch origin ${o.base} ${o.branch}`, o.repo);
  const wt = mkdtempSync(join(tmpdir(), "afk-merge-"));
  try {
    run(`git worktree add --detach ${shq(wt)} origin/${o.branch}`, o.repo);
    const as = `-c user.name=${shq(o.identity.name)} -c user.email=${shq(o.identity.email)}`;
    try {
      run(`git ${as} merge --no-edit origin/${o.base}`, wt);
    } catch {
      try { run("git merge --abort", wt); } catch {}
      return "conflicted";
    }
    run(`git push origin HEAD:refs/heads/${o.branch}`, wt);
    return "merged";
  } finally {
    try { run(`git worktree remove --force ${shq(wt)}`, o.repo); } catch {}
    rmSync(wt, { recursive: true, force: true });
    try { run("git worktree prune", o.repo); } catch {}
  }
};

// The base tip to measure an agent resolution against, captured BEFORE the agent runs: if
// main moves again mid-run, the agent still succeeded at what it was asked to do.
export const baseTip = (repo: string, base: string, run: Run = sh): string => {
  run(`git fetch origin ${base}`, repo);
  return run(`git rev-parse origin/${base}`, repo);
};

// Did the agent's push actually resolve? True iff the pushed branch now contains `sha`.
export const branchContains = (repo: string, branch: string, sha: string, run: Run = sh): boolean => {
  run(`git fetch origin ${branch}`, repo);
  try { run(`git merge-base --is-ancestor ${sha} origin/${branch}`, repo); return true; }
  catch { return false; }
};

export type ConflictDeps = {
  maxFailures: number;
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

export type ConflictResult = "escalated" | "mechanical" | "agent-resolved" | "agent-failed";

export async function handleConflict(pr: number, d: ConflictDeps): Promise<ConflictResult> {
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
