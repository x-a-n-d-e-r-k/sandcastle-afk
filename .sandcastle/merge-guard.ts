// ---------------------------------------------------------------------------
// Merge-path guards. Forge side effects are injected so the decisions are unit-testable
// without a live forge.
// ---------------------------------------------------------------------------

export type IssueCloseDeps = {
  /** Lowercased issue state from forge issue-view ("open" | "closed"). */
  issueState: (n: number) => string;
  closeIssue: (n: number, comment: string) => void;
  /** Remove this loop's claim label; a no-op in single-loop mode. */
  releaseClaim: (n: number) => void;
  log: (m: string) => void;
};

// Belt and braces after a merge (#70): don't rely on the forge's closing keyword alone. A degraded
// GitLab merged the MR but left `Closes #N` unapplied, and the still-open, still-claimed issue was
// resumed into a fresh PR for work that had already shipped.
export function closeLinkedIssue(issue: number, pr: number, d: IssueCloseDeps): "closed" | "already-closed" {
  // The claim is released either way (#88): a claim left on a CLOSED issue kept an orphaned PR
  // "owned" by nobody's reckoning — and is stale bookkeeping in any case.
  if (d.issueState(issue) !== "open") { d.releaseClaim(issue); return "already-closed"; }
  d.log(`#${issue} still open after PR #${pr} merged — closing it and releasing the claim (the forge did not auto-close it)`);
  d.closeIssue(issue, `AFK: closed after PR #${pr} merged — the forge did not auto-close it.`);
  d.releaseClaim(issue);
  return "closed";
}

// --- merge guard (#71) -----------------------------------------------------------------------
// A degraded GitLab carried out one `pr-merge --squash` six times server-side and left the MR
// `opened` + approved + green: exactly the state in which the next cycle merges again, and every
// duplicate is another push (another deploy) to the default branch. So: never merge a change that
// is already on base, and verify a merge actually finalized.

type Run = (cmd: string, cwd: string) => string;

// Pure: merging the branch into base would produce base's own tree, i.e. the change is already there.
export const alreadyLanded = (baseTree: string, mergedTree: string): boolean =>
  !!baseTree && baseTree === mergedTree;

// Git side of the check. Throws on ANY git error (including a conflicting merge-tree, which exits
// non-zero) — the caller treats a throw as "don't merge this cycle", never as "merge anyway".
export const landedOnBase = (o: { repo: string; base: string; branch: string; run: Run }): boolean => {
  o.run(`git fetch -q origin ${o.base} ${o.branch}`, o.repo);
  const baseTree = o.run(`git rev-parse origin/${o.base}^{tree}`, o.repo);
  const mergedTree = o.run(`git merge-tree --write-tree origin/${o.base} origin/${o.branch}`, o.repo).split("\n")[0].trim();
  return alreadyLanded(baseTree, mergedTree);
};

export type MergeDeps = {
  /** landedOnBase for this PR; throws on a git error. */
  landed: () => boolean;
  merge: () => void;
  /** Is the PR still open after the merge call? */
  stillOpen: () => boolean;
  /** Comment + close the PR (pr-close), for a change that is already on base. */
  finalize: (why: string) => void;
  /** closeLinkedIssue for this PR's issue (#70). */
  closeIssue: () => void;
  log: (m: string) => void;
};

export type MergeOutcome = "merged" | "finalized-landed" | "finalized-after-merge" | "merge-pending" | "skipped-error";

export function guardedMerge(pr: number, d: MergeDeps): MergeOutcome {
  let landed: boolean;
  try { landed = d.landed(); }
  catch (e) { d.log(`PR #${pr}: already-landed check failed (${(e as Error).message.split("\n")[0]}) — NOT merging this cycle`); return "skipped-error"; }
  if (landed) {
    d.log(`PR #${pr}: its change is already on the base branch — finalizing instead of merging`);
    d.finalize("already-landed");
    d.closeIssue();
    return "finalized-landed";
  }

  // A failed merge CALL is an unknown outcome, not a failure (#88): a self-hosted GitLab merged and then
  // answered 500. Fall through to the same post-merge check — merged / landed-but-open → finalize /
  // genuinely not merged → leave it for the next cycle (never a second merge in this one).
  try { d.merge(); }
  catch (e) { d.log(`PR #${pr}: the merge call failed (${(e as Error).message.split("\n")[0]}) — outcome unknown, checking whether it landed`); }
  if (!d.stillOpen()) { d.log(`merged #${pr}`); d.closeIssue(); return "merged"; }

  // The merge call returned but the PR still reads open. If the change landed anyway, the forge
  // failed to finalize: close it rather than let the next cycle merge a second time.
  let landedAfter: boolean;
  try { landedAfter = d.landed(); }
  catch (e) { d.log(`PR #${pr}: still open after merge and the landed check failed (${(e as Error).message.split("\n")[0]}) — re-evaluating next cycle`); return "merge-pending"; }
  if (landedAfter) {
    d.log(`PR #${pr}: the forge landed the merge but did not finalize the PR — closing it`);
    d.finalize("not-finalized");
    d.closeIssue();
    return "finalized-after-merge";
  }
  d.log(`PR #${pr}: still open after the merge call and not on base — re-evaluating next cycle`);
  return "merge-pending";
}

// The landed check needs `git merge-tree --write-tree` (git ≥ 2.38). On an older git it errors on
// every approved PR, and fail-closed then means the loop never merges again — silently. Refuse to
// start instead, naming the fix (review follow-up on #71).
export const MIN_GIT: [number, number] = [2, 38];
export const gitSupportsMergeTree = (versionOutput: string): boolean => {
  const m = versionOutput.match(/(\d+)\.(\d+)/);
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > MIN_GIT[0] || (maj === MIN_GIT[0] && min >= MIN_GIT[1]);
};
export const assertGitSupportsMergeTree = (versionOutput: string): void => {
  if (!gitSupportsMergeTree(versionOutput)) {
    throw new Error(
      `the AFK loop needs git >= ${MIN_GIT.join(".")} on the host (for \`git merge-tree --write-tree\`, used to ` +
      `avoid re-merging an already-landed change); found "${versionOutput.trim()}". Upgrade git and restart.`,
    );
  }
};

// --- same-commit backstop (#81) ------------------------------------------------------------------
// Refuse to merge an approval that sits on the very commit a changes-requested review blocked, with
// nothing pushed since and no rebuttal answering the finding — the "blocked PR merges on the same
// commit" hole. Cheap, and it catches a regression of the heal/re-review fixes. GitLab notes carry
// no commit (blockingSha ""), so this never fires there; its label flow is unchanged.
export const sameCommitAsBlock = (g: { head: string; blockingSha: string; rebuttal: string }): boolean =>
  !!g.blockingSha && g.blockingSha === g.head && !g.rebuttal.trim();
