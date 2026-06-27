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
import { forge, forgeJSON, log, sleep, isExcluded, priorityRank, LOOP_ID, WORKING } from "./config.js";

export type Issue = { number: number; title: string; labels: string[] };
export type PR = { headRef: string };

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
};

// Live forge-backed deps. A factory (not a constant) so importing this module never
// shells out — forge is only invoked when the loop actually calls these.
export const realPickDeps = (readyLabel: string, dry: boolean): PickDeps => ({
  listReady: () => forgeJSON<Issue[]>(`issue-list --label ${readyLabel}`),
  listClosed: () => forgeJSON<PR[]>("pr-list --state closed"),
  view: (n) => forgeJSON<Issue>(`issue-view ${n}`),
  addLabel: (n, label) => { forge(`issue-edit ${n} --add-label ${label}`); },
  removeLabel: (n, label) => { forge(`issue-edit ${n} --remove-label ${label}`); },
  settle: async (ms) => { await sleep(ms); },
  loopId: LOOP_ID,
  mine: MINE,
  dry,
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
  const { listReady, listClosed, view, addLabel, removeLabel, settle, loopId, mine, dry } = deps;
  const issues = listReady();
  const openHeads = new Set(allPRs.map((p) => p.headRef));
  // A CLOSED agent PR means its issue is resolved — merged (work shipped) or
  // closed-unmerged (rejected) — so never re-dispatch it. Excluding *merged* PRs also
  // closes a post-merge re-pick race (observed with #380): right after a merge the
  // linked issue can momentarily still look open+ready before the forge auto-closes it.
  const resolved = new Set(
    listClosed()
      .filter((p) => p.headRef.startsWith("agent/issue-"))
      .map((p) => p.headRef),
  );
  const hasOpenWork = (n: number) =>
    openHeads.has(`agent/issue-${n}`) || resolved.has(`agent/issue-${n}`);

  // Crash recovery: if this loop claimed an issue but died before opening a PR, the
  // claim survives but the issue is now excluded from fresh pickup (working:* is
  // excluded). Resume our OWN claim before taking anything new — bypassing isExcluded —
  // else the issue is stranded forever. No write: it's already claimed by us.
  if (mine) {
    const resume = issues
      .filter((i) => i.labels.includes(mine) && !hasOpenWork(i.number))
      .sort(byPriority)[0];
    if (resume) { log(`resuming own claim #${resume.number}`); return resume; }
  }

  const candidate = issues
    .filter((i) => !isExcluded(i.labels))
    .filter((i) => !hasOpenWork(i.number))
    .sort(byPriority)[0];

  // DRY-run safety: the claim is a live write, so short-circuit BEFORE it. (A dry run
  // once silently labelled a real issue — the claim must never fire under DRY.)
  if (!candidate || !mine || dry) return candidate;

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
