import { existsSync } from "node:fs";
import { join } from "node:path";
import { sh, shq, type GitIdentity } from "./config.js";

// ---------------------------------------------------------------------------
// Checkpoint + resume for killed implement runs (#53).
//
// Liveness is output-only upstream: a Bash call that runs longer than idleTimeoutSeconds (a full
// test suite, a repro loop) looks idle and the run dies with AgentIdleTimeoutError. The agent keeps
// its work uncommitted until it opens the PR, and the next dispatch used to delete the branch — so
// every kill threw all of it away. Now a failed run's dirty worktree is committed as
// `wip(#n): checkpoint after <reason>` and pushed; the next dispatch resumes from that branch
// instead of deleting it, up to cfg.maxResume times, then escalates.
// ---------------------------------------------------------------------------

type Run = (cmd: string, cwd: string) => string;

// Usage/rate-limit errors are NOT checkpointed: runGuarded waits them out and resumes the same run.
export const USAGE_PATTERNS = [
  /usage limit/i, /rate limit/i, /\b429\b/, /too many requests/i,
  /quota/i, /overloaded/i, /capacity/i, /resets? (?:at|in)/i, /try again later/i,
];
export const isUsageError = (msg: string): boolean => USAGE_PATTERNS.some((p) => p.test(msg));

const errText = (e: unknown): string => {
  const x = e as { name?: string; message?: string } | undefined;
  return `${x?.name ?? ""} ${x?.message ?? String(e)}`;
};

// A short, commit-subject-safe reason. run() rejects with an Effect FiberFailure whose `name` is
// "(FiberFailure) AgentIdleTimeoutError", so match on name + message, not instanceof.
export const checkpointReason = (e: unknown): string => {
  const t = errText(e);
  if (/AgentIdleTimeoutError|Agent idle for/i.test(t)) return "idle timeout";
  const tag = t.match(/\b([A-Z][A-Za-z]+Error)\b/)?.[1];
  return tag ? tag.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() : "run error";
};

export const CHECKPOINT_PREFIX = (issue: number) => `wip(#${issue}): checkpoint`;
const branchOf = (issue: number) => `agent/issue-${issue}`;
// Upstream names a branch worktree after the branch with `/` → `-` (.sandcastle/worktrees/…).
export const worktreeOf = (repo: string, issue: number) => join(repo, ".sandcastle", "worktrees", branchOf(issue).replace(/\//g, "-"));

export type CheckpointOutcome = "usage" | "clean" | "checkpointed";

// Called when an implement run throws. Upstream preserves a DIRTY worktree on failure (and, for
// Docker, the worktree is bind-mounted, so the container's edits are on the host). Commit it as the
// implement identity (#52, no AI trailer — the host commits, not the agent) and push the branch.
export const checkpointAfterFailure = (o: {
  issue: number; err: unknown; repo: string; identity: GitIdentity; run?: Run; worktree?: string;
}): CheckpointOutcome => {
  const run = o.run ?? sh;
  if (isUsageError(errText(o.err))) return "usage";
  const wt = o.worktree ?? worktreeOf(o.repo, o.issue);
  if (!existsSync(wt) || !run("git status --porcelain", wt)) return "clean";
  const as = `-c user.name=${shq(o.identity.name)} -c user.email=${shq(o.identity.email)}`;
  run("git add -A", wt);
  run(`git ${as} commit -q --no-verify -m ${shq(`${CHECKPOINT_PREFIX(o.issue)} after ${checkpointReason(o.err)}`)}`, wt);
  run(`git push -q origin HEAD:refs/heads/${branchOf(o.issue)}`, wt);
  return "checkpointed";
};

// Does origin's agent/issue-N carry a checkpoint commit (on top of the base branch)?
export const hasCheckpoint = (o: { issue: number; repo: string; base: string; run?: Run }): boolean => {
  const run = o.run ?? sh;
  const b = branchOf(o.issue);
  if (!run(`git ls-remote --heads origin ${b}`, o.repo)) return false;
  run(`git fetch -q origin ${o.base} ${b}`, o.repo);
  const subjects = run(`git log --format=%s origin/${o.base}..origin/${b}`, o.repo).split("\n");
  return subjects.some((s) => s.startsWith(CHECKPOINT_PREFIX(o.issue)));
};

export const RESUME_MARKER = "[afk:resume]";

export const resumePrompt = (issue: number): string =>
  `## Resuming from a checkpoint\n\nA previous attempt at #${issue} was cut off before it finished. You are resuming from a checkpoint on this branch — \`git log -1\` (a \`${CHECKPOINT_PREFIX(issue)} …\` commit) shows what was in progress. Read it and \`git show HEAD\` first, keep what is sound, and continue from there rather than starting over. The checkpoint commit stays in history; the PR is squash-merged.\n`;

export type DispatchPlan =
  | { kind: "fresh" }
  | { kind: "resume"; resumeNo: number }
  | { kind: "escalate"; resumes: number };

// Pure decision for a dispatch. No checkpoint → fresh (the stale branch is deleted, as before).
// A checkpoint that has already been resumed maxResume times → escalate instead of spinning.
export const planDispatch = (o: { checkpoint: boolean; resumes: number; maxResume: number }): DispatchPlan => {
  if (!o.checkpoint) return { kind: "fresh" };
  if (o.resumes >= o.maxResume) return { kind: "escalate", resumes: o.resumes };
  return { kind: "resume", resumeNo: o.resumes + 1 };
};

export const countResumes = (comments: string): number => comments.split(RESUME_MARKER).length - 1;

export type DispatchDeps = {
  maxResume: number;
  hasCheckpoint: () => boolean;
  /** Resumes already made for this issue ([afk:resume] markers on the issue). */
  resumes: () => number;
  markResume: (resumeNo: number) => void;
  escalate: (resumes: number) => void;
  /** Fresh dispatch: delete the stale branch (a leftover would be reused at its old tip). */
  deleteBranch: () => void;
  /** Resume: point the local branch at origin's checkpoint tip so the run starts from it. */
  keepBranch: () => void;
  implement: (resume: boolean) => Promise<unknown>;
  checkpoint: (err: unknown) => CheckpointOutcome;
  log: (m: string) => void;
};

// One implement dispatch: fresh / resume / escalate, and checkpoint the work if the run dies.
// The run's error is rethrown after checkpointing so the cycle still reports it.
export async function dispatchIssue(issue: number, d: DispatchDeps): Promise<DispatchPlan["kind"]> {
  const checkpoint = d.hasCheckpoint();
  const plan = planDispatch({ checkpoint, resumes: checkpoint ? d.resumes() : 0, maxResume: d.maxResume });
  if (plan.kind === "escalate") { d.escalate(plan.resumes); return "escalate"; }
  if (plan.kind === "resume") {
    d.log(`#${issue} has a checkpoint -> resuming (${plan.resumeNo}/${d.maxResume})`);
    d.markResume(plan.resumeNo);
    d.keepBranch();
  } else {
    d.deleteBranch();
  }
  try {
    await d.implement(plan.kind === "resume");
  } catch (e) {
    const out = d.checkpoint(e);
    if (out === "checkpointed") d.log(`#${issue} run failed — work checkpointed to agent/issue-${issue}; the next dispatch resumes it`);
    throw e;
  }
  return plan.kind;
}
