// Concurrent-loop backlog claiming (#8).
//
// Lets N loops (one per repo clone, e.g. two folders on the same machine) work the
// same backlog without colliding: no two loops pick the same issue or drive the same
// PR. Each clone sets a unique LOOP_ID; a loop CLAIMS an issue on pickup by adding the
// label `working:<LOOP_ID>`. That claim scopes both issue pickup and PR-driving.
//
// This lives apart from loop.ts (which imports @ai-hero/sandcastle) on purpose: the
// claim logic stays unit-testable with no sandbox runtime and no live forge — the deps
// `pickNextIssue` needs are injected (realPickDeps wires the live ones).
import { cfg, log, sleep, isExcluded, priorityRank, isAgentBranch, LOOP_ID, WORKING, ORPHAN_LABEL, BLOCKED_LABEL } from "./config.js";
import * as forge from "./forge-client.js";

export type Issue = { number: number; title: string; labels: string[]; state?: string };
export type PR = { headRef: string; labels?: string[]; merged?: boolean };

// The claim label THIS clone writes. Empty when LOOP_ID is unset => single-loop mode:
// no claims written, the loop owns every issue/PR (byte-for-byte today's behavior).
export const MINE = LOOP_ID ? `${WORKING}:${LOOP_ID}` : "";
export const CLAIM_SETTLE_MS = 3_000;

// Issue number embedded in an `agent/issue-N` head ref.
export const issueNumOf = (headRef: string): number => Number(headRef.match(/issue-(\d+)/)?.[1]);

// Deterministic claim-race tiebreak: the lowest LOOP_ID among an issue's `working:*`
// labels wins. Returns the winning id, or undefined if the issue carries no claim.
export const claimWinner = (labels: string[]): string | undefined =>
  labels
    .filter((l) => l.startsWith(`${WORKING}:`))
    .map((l) => l.slice(WORKING.length + 1))
    .sort()[0];

// The issues whose agent PRs THIS loop drives (#8): its claimed issues — open AND closed (#88). A forge
// that merged an MR but left it open closes the issue (via Closes #N) while the MR stays open; counting
// only OPEN claimed issues orphaned that MR for every loop, so the merge guard could never finalize it.
export const ownedIssueNumbers = (openClaimed: { number: number }[], closedClaimed: { number: number }[]): Set<number> =>
  new Set([...openClaimed, ...closedClaimed].map((i) => i.number));

// The agent PRs this loop drives this cycle: its own, minus those parked for a human. New work is only
// dispatched when this is EMPTY — so anything the loop can't act on must leave it (be parked), not just
// be skipped, or one stuck PR blocks dispatch forever (#88 review).
export const inFlightPrs = <P extends { headRef: string; labels: string[] }>(prs: P[], needsHuman: string, isMine: (headRef: string) => boolean): P[] =>
  prs.filter((p) => !p.labels.includes(needsHuman) && isMine(p.headRef));

// Everything pickNextIssue touches, injected so it's testable without a live forge.
export type PickDeps = {
  listReady: () => Issue[];
  listClosed: () => PR[];
  view: (n: number) => Issue;
  addLabel: (n: number, label: string) => void;
  removeLabel: (n: number, label: string) => void;
  settle: (ms: number) => Promise<void>;
  loopId: string;
  mine: string;
  dry: boolean;
  /** The ready label: an issue that lost it between the list and the claim is not claimed (#95). */
  readyLabel?: string;
};

// Live forge-backed deps. A factory (not a constant) so importing this module never
// shells out — forge is only invoked when the loop actually calls these.
export const realPickDeps = (readyLabel: string, dry: boolean): PickDeps => ({
  listReady: () => forge.issueList("--label", readyLabel),
  listClosed: () => forge.prList("--state", "closed"),
  view: (n) => forge.issueView(n),
  addLabel: (n, label) => { forge.issueEdit(n, "--add-label", label); },
  removeLabel: (n, label) => { forge.issueEdit(n, "--remove-label", label); },
  settle: async (ms) => { await sleep(ms); },
  loopId: LOOP_ID,
  mine: MINE,
  dry,
  readyLabel,
});

// Priority sort (unchanged from the original loop): priority label, then `fix*` titles
// first, then issue number. The claim layer sits ON TOP of this ordering.
const byPriority = (a: Issue, b: Issue): number => {
  const s = (t: string) => (/^fix/i.test(t) ? 0 : 1);
  return priorityRank(a.labels) - priorityRank(b.labels) || s(a.title) - s(b.title) || a.number - b.number;
};

// Select the next issue to work, claiming it for this clone via verify-after-write.
//   - single-loop (mine === "") or dry-run: select, but NEVER write a claim.
//   - multi-loop: claim the candidate, settle, re-read; lowest LOOP_ID wins a race,
//     the loser releases its own label and retries next cycle.
//   - crash recovery: a pre-crash claim with no PR is resumed before any new pickup.
export async function pickNextIssue(allPRs: PR[], deps: PickDeps): Promise<Issue | undefined> {
  const { listReady, listClosed, view, addLabel, removeLabel, settle, loopId, mine, dry, readyLabel } = deps;
  // The closed-PR list is a slow forge call: read it FIRST, so the ready list (and the claims on it)
  // is as fresh as possible when the candidate is picked (#95).
  const closed = listClosed();
  const issues = listReady();
  const openHeads = new Set(allPRs.map((p) => p.headRef));
  // A CLOSED agent PR means its issue is resolved — merged (work shipped) or
  // closed-unmerged (rejected) — so never re-dispatch it. Excluding *merged* PRs also
  // closes a post-merge re-pick race (observed with #380): right after a merge the
  // linked issue can momentarily still look open+ready before the forge auto-closes it.
  // EXCEPT an orphan (#61): a PR closed because its source branch never reached origin carries
  // the orphan label and resolved nothing, so its issue stays dispatchable. Merged always counts.
  const isOrphan = (p: PR) => !p.merged && (p.labels ?? []).includes(ORPHAN_LABEL);
  const resolved = new Set(
    closed
      .filter((p) => isAgentBranch(p.headRef) && !isOrphan(p))
      .map((p) => p.headRef),
  );
  const hasOpenWork = (n: number) =>
    openHeads.has(`agent/issue-${n}`) || resolved.has(`agent/issue-${n}`);

  // Crash recovery: if this loop claimed an issue but died before opening a PR, the
  // claim survives but the issue is now excluded from fresh pickup (working:* is
  // excluded). Resume our OWN claim before taking anything new — bypassing isExcluded —
  // else the issue is stranded forever. No write: it's already claimed by us.
  if (mine) {
    // A claim on an issue that is (or became) `blocked` is released, not resumed (#78): holding it
    // only keeps every loop — this one included — off it, and resuming would balk on a missing
    // dependency. With an open PR the claim is PR ownership, so it stays.
    // Same matching rule as isExcluded: `blocked` or a `blocked:<x>` sub-label.
    const isBlocked = (i: Issue) => i.labels.some((l) => l === BLOCKED_LABEL || l.startsWith(`${BLOCKED_LABEL}:`));
    // Likewise a claim on an issue parked for a human (#86): the resume path bypasses isExcluded, so
    // without this an escalated issue that still carried our claim was re-dispatched every cycle.
    const isParked = (i: Issue) => i.labels.includes(cfg.labels.needsHuman);
    const held = (i: Issue) => isBlocked(i) || isParked(i);
    for (const i of issues.filter((i) => i.labels.includes(mine) && held(i) && !hasOpenWork(i.number))) {
      const why = isParked(i) ? "parked for a human" : "blocked";
      if (dry) { log(`DRY: would release own claim on ${why} #${i.number}`); continue; }
      log(`#${i.number} is ${why} — releasing our claim`);
      removeLabel(i.number, mine);
    }
    const resume = issues
      .filter((i) => i.labels.includes(mine) && !held(i) && !hasOpenWork(i.number))
      .sort(byPriority)[0];
    if (resume) { log(`resuming own claim #${resume.number}`); return resume; }
  }

  const candidates = issues
    .filter((i) => !isExcluded(i.labels))
    .filter((i) => !hasOpenWork(i.number))
    .sort(byPriority);

  // DRY-run safety: the claim is a live write, so short-circuit BEFORE it. (A dry run
  // once silently labelled a real issue — the claim must never fire under DRY.)
  if (!candidates.length || !mine || dry) return candidates[0];

  // Never claim over an existing claim (#95). The lowest-id tiebreak below is only sound while both
  // loops are inside their settle window at once; a loop whose list was read before another loop's
  // claim landed would otherwise write its label AFTER that loop had verified and started, "win" a
  // race that was already over, and both would work the issue. Re-read right before the write, so
  // the remaining window is the claim itself — which the settle + tiebreak does cover.
  // A candidate taken meanwhile is skipped for the next one, so a lost pick doesn't idle a poll.
  let candidate: Issue | undefined;
  for (const c of candidates) {
    const now = view(c.number);
    const current = now.labels ?? [];
    const closed = (now.state ?? "").toLowerCase() === "closed";
    const unready = !!readyLabel && !current.includes(readyLabel);
    if (!isExcluded(current) && !closed && !unready) { candidate = c; break; }
    const by = current.filter((l) => l === WORKING || l.startsWith(`${WORKING}:`));
    const why = by.length ? `already claimed (${by.join(", ")})` : closed ? "closed" : unready ? `no longer ${readyLabel}` : "no longer pickable";
    log(`#${c.number}: ${why} — not claiming`);
  }
  if (!candidate) return undefined;

  // Claim with verify-after-write: add our label, let it settle, re-read the issue.
  addLabel(candidate.number, mine);
  await settle(CLAIM_SETTLE_MS);
  const fresh = view(candidate.number).labels ?? [];
  const winner = claimWinner(fresh);
  if (winner !== loopId) {
    log(`#${candidate.number}: claim race lost to "${winner}" — releasing`);
    removeLabel(candidate.number, mine);
    return undefined; // retry next cycle
  }
  return candidate;
}
