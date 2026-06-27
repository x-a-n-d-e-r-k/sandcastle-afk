// Read-only ownership dashboard for concurrent loops (#8).
//   pnpm afk:claims
// Lists every `working:*` claim, maps each claimed issue to its agent PR + review
// state, groups by owner, and flags any issue held by more than one owner (a claim
// race that did NOT resolve) — exiting non-zero so it can gate a check.
import { forge, forgeJSON, WORKING } from "./config.js";

type Issue = { number: number; title: string; labels: string[] };
type PR = { number: number; headRef: string; reviewState: string };

const ownersOf = (labels: string[]): string[] =>
  labels.filter((l) => l.startsWith(`${WORKING}:`)).map((l) => l.slice(WORKING.length + 1)).sort();

const issueNumOf = (headRef: string): number => Number(headRef.match(/issue-(\d+)/)?.[1]);

function main(): void {
  // We don't know the live LOOP_IDs in advance, so list all open issues and keep the
  // claimed ones (any carrying a `working:<id>` label).
  const claimed = forgeJSON<Issue[]>("issue-list").filter((i) => ownersOf(i.labels).length > 0);
  const prByIssue = new Map<number, PR>(
    forgeJSON<PR[]>("pr-list")
      .filter((p) => p.headRef.startsWith("agent/issue-"))
      .map((p) => [issueNumOf(p.headRef), p]),
  );

  if (!claimed.length) { console.log("No active claims (no working:* issues)."); return; }

  // Group claimed issues by owner (an issue may appear under >1 owner if contested).
  const byOwner = new Map<string, Issue[]>();
  for (const i of claimed) {
    for (const o of ownersOf(i.labels)) {
      const arr = byOwner.get(o) ?? [];
      arr.push(i);
      byOwner.set(o, arr);
    }
  }

  console.log("Claims by owner:\n");
  for (const owner of [...byOwner.keys()].sort()) {
    console.log(`  ${WORKING}:${owner}`);
    for (const i of byOwner.get(owner)!.sort((a, b) => a.number - b.number)) {
      const pr = prByIssue.get(i.number);
      const prTxt = pr ? `PR #${pr.number} [${pr.reviewState}]` : "no PR (claimed, not yet opened)";
      console.log(`    #${i.number} ${i.title} — ${prTxt}`);
    }
    console.log("");
  }

  const contested = claimed.filter((i) => ownersOf(i.labels).length > 1);
  for (const i of contested) {
    console.log(`⚠ CONTESTED #${i.number}: held by ${ownersOf(i.labels).map((o) => `${WORKING}:${o}`).join(", ")}`);
  }

  if (contested.length) {
    console.log("\nOne or more issues have multiple owners — a claim race did not resolve.");
    process.exit(1);
  }
  console.log("All claims uncontested.");
}

main();
