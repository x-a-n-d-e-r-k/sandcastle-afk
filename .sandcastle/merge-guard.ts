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
  if (d.issueState(issue) !== "open") return "already-closed";
  d.log(`#${issue} still open after PR #${pr} merged — closing it and releasing the claim (the forge did not auto-close it)`);
  d.closeIssue(issue, `AFK: closed after PR #${pr} merged — the forge did not auto-close it.`);
  d.releaseClaim(issue);
  return "closed";
}
