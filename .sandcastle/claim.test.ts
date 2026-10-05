// Pure unit tests for concurrent-loop claiming (#8) — no sandbox, no live forge.
// Run: pnpm test  (node's built-in test runner via tsx).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { PickDeps, Issue, PR } from "./claim.js";

// config.ts (imported transitively by claim.ts) throws without afk.config.json, which is
// per-project + gitignored. Seed it from the example so the logic imports in a fresh clone.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json"))) {
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));
}

const { pickNextIssue, claimWinner } = await import("./claim.js");
const { isExcluded, isValidLoopId } = await import("./config.js");

// A PickDeps with no-op writes and a recorded edit log; override per test.
const deps = (over: Partial<PickDeps> & { listReady: () => Issue[] }): PickDeps & { edits: string[] } => {
  const edits: string[] = [];
  return {
    edits,
    listClosed: (): PR[] => [],
    view: () => { throw new Error("view() should not be called in this test"); },
    addLabel: (n: number, l: string) => { edits.push(`add ${n} ${l}`); },
    removeLabel: (n: number, l: string) => { edits.push(`remove ${n} ${l}`); },
    settle: async () => {},
    loopId: "a",
    mine: "working:a",
    dry: false,
    ...over,
  };
};

test("isExcluded skips `working` and `working:<id>` claims", () => {
  assert.equal(isExcluded(["working"]), true);
  assert.equal(isExcluded(["working:b"]), true);
  assert.equal(isExcluded(["agent-ready"]), false);
});

test("isValidLoopId: accepts safe tokens, rejects shell metacharacters", () => {
  assert.equal(isValidLoopId("a"), true);
  assert.equal(isValidLoopId("loop_2-b"), true);
  assert.equal(isValidLoopId("a; rm -rf ."), false); // injection attempt
  assert.equal(isValidLoopId("a b"), false); // space splits the forge arg
  assert.equal(isValidLoopId(""), false);
});

test("claimWinner: lowest LOOP_ID among working:* wins; none => undefined", () => {
  assert.equal(claimWinner(["working:b", "working:a"]), "a");
  assert.equal(claimWinner(["working:b"]), "b");
  assert.equal(claimWinner(["agent-ready"]), undefined);
});

test("tiebreak: contested claim — `a` wins, `b`'s loop releases and retries", async () => {
  const issue: Issue = { number: 7, title: "do thing", labels: ["agent-ready"] };
  // From b's view: after writing working:b, the re-read shows both claims -> a wins.
  const d = deps({
    listReady: () => [issue],
    view: () => ({ ...issue, labels: ["agent-ready", "working:a", "working:b"] }),
    loopId: "b",
    mine: "working:b",
  });
  const picked = await pickNextIssue([], d);
  assert.equal(picked, undefined); // b lost the race
  assert.deepEqual(d.edits, ["add 7 working:b", "remove 7 working:b"]); // claimed then released
});

test("tiebreak: claim winner keeps the issue with a single write", async () => {
  const issue: Issue = { number: 7, title: "do thing", labels: ["agent-ready"] };
  const d = deps({
    listReady: () => [issue],
    view: () => ({ ...issue, labels: ["agent-ready", "working:a"] }),
  });
  const picked = await pickNextIssue([], d);
  assert.equal(picked?.number, 7);
  assert.deepEqual(d.edits, ["add 7 working:a"]); // claimed, never released
});

test("resume-path: an issue carrying MINE with no PR is returned before any unclaimed candidate", async () => {
  const mineIssue: Issue = { number: 5, title: "claimed before crash", labels: ["agent-ready", "working:a"] };
  const fresh: Issue = { number: 9, title: "unclaimed", labels: ["agent-ready"] };
  const d = deps({ listReady: () => [fresh, mineIssue] }); // view() throws if a re-claim is attempted
  const picked = await pickNextIssue([], d);
  assert.equal(picked?.number, 5); // resumed our own claim, not the fresh #9
  assert.deepEqual(d.edits, []); // already ours — no write
});

test("dry-run guard: returns a candidate and issues no issue-edit", async () => {
  const issue: Issue = { number: 3, title: "x", labels: ["agent-ready"] };
  const d = deps({ listReady: () => [issue], dry: true }); // view() throws if claimed
  const picked = await pickNextIssue([], d);
  assert.equal(picked?.number, 3);
  assert.deepEqual(d.edits, []); // DRY short-circuits before the live write
});

test("single-loop (mine===\"\"): selects without writing a claim", async () => {
  const issue: Issue = { number: 1, title: "x", labels: ["agent-ready"] };
  const d = deps({ listReady: () => [issue], mine: "", loopId: "" });
  const picked = await pickNextIssue([], d);
  assert.equal(picked?.number, 1);
  assert.deepEqual(d.edits, []);
});

// --- orphan PRs (#61): a closed orphan resolves nothing, so its issue is dispatchable again ----

const orphanIssue: Issue = { number: 433, title: "do thing", labels: ["agent-ready"] };
const closedPr = (over: Partial<PR>): PR => ({ headRef: "agent/issue-433", labels: [], merged: false, ...over });

test("orphan: a ready issue whose only closed PR is labelled afk-orphan IS picked", async () => {
  const d = deps({ listReady: () => [orphanIssue], listClosed: () => [closedPr({ labels: ["afk-orphan"] })], mine: "", loopId: "" });
  assert.equal((await pickNextIssue([], d))?.number, 433);
});

test("orphan: the same closed-unmerged PR WITHOUT the label still blocks re-dispatch", async () => {
  const d = deps({ listReady: () => [orphanIssue], listClosed: () => [closedPr({})], mine: "", loopId: "" });
  assert.equal(await pickNextIssue([], d), undefined);
});

test("orphan: a merged PR blocks re-dispatch (even if somehow labelled)", async () => {
  for (const labels of [[], ["afk-orphan"]]) {
    const d = deps({ listReady: () => [orphanIssue], listClosed: () => [closedPr({ merged: true, labels })], mine: "", loopId: "" });
    assert.equal(await pickNextIssue([], d), undefined);
  }
});

test("orphan: a non-orphan closed PR alongside an orphan one still blocks", async () => {
  const d = deps({
    listReady: () => [orphanIssue],
    listClosed: () => [closedPr({ labels: ["afk-orphan"] }), closedPr({})],
    mine: "", loopId: "",
  });
  assert.equal(await pickNextIssue([], d), undefined);
});

test("orphan resume path: this loop's own claim whose closed PR is orphan-labelled IS resumed", async () => {
  const claimed: Issue = { ...orphanIssue, labels: ["agent-ready", "working:a"] };
  const d = deps({ listReady: () => [claimed], listClosed: () => [closedPr({ labels: ["afk-orphan"] })] });
  assert.equal((await pickNextIssue([], d))?.number, 433);
  assert.deepEqual(d.edits, []);
});

// --- merged PRs (#70): a merged agent PR resolves its issue even if the forge left it open -----

test("merged: an own-claimed ready issue whose only PR merged is NOT resumed and NOT picked", async () => {
  const claimed: Issue = { number: 427, title: "shipped", labels: ["agent-ready", "working:a"] };
  const unclaimed: Issue = { number: 427, title: "shipped", labels: ["agent-ready"] };
  const merged: PR = { headRef: "agent/issue-427", labels: [], merged: true };
  // Resume path (own claim) and candidate path (no claim) alike.
  assert.equal(await pickNextIssue([], deps({ listReady: () => [claimed], listClosed: () => [merged] })), undefined);
  assert.equal(await pickNextIssue([], deps({ listReady: () => [unclaimed], listClosed: () => [merged], mine: "", loopId: "" })), undefined);
});

// --- `blocked` makes an issue unclaimable (#78) --------------------------------------------------
// A tiny in-memory forge: issues with labels; listReady filters by the ready label like the real one;
// the sweep's unblock removes `blocked` and nothing else (the real wiring in loop.ts).
const { sweepBlockedIssues } = await import("./triage.js");
const { BLOCKED_LABEL } = await import("./config.js");

test("#78: an agent-ready + blocked issue is never claimed (candidate path)", async () => {
  const ready: Issue = { number: 50, title: "dependent", labels: ["agent-ready", "blocked"] };
  const free: Issue = { number: 51, title: "free", labels: ["agent-ready"] };
  assert.equal(isExcluded(ready.labels), true);
  const picked = await pickNextIssue([], deps({ listReady: () => [ready, free], mine: "", loopId: "" }));
  assert.equal(picked?.number, 51, "the genuinely unblocked issue is picked, not the blocked one");
  assert.equal(await pickNextIssue([], deps({ listReady: () => [ready], mine: "", loopId: "" })), undefined);
});

test("#78: a stale own claim on an agent-ready + blocked issue is released and not worked", async () => {
  const stale: Issue = { number: 50, title: "dependent", labels: ["agent-ready", "blocked", "working:a"] };
  const d = deps({ listReady: () => [stale] }); // view() throws if a fresh claim is attempted
  assert.equal(await pickNextIssue([], d), undefined);
  assert.deepEqual(d.edits, ["remove 50 working:a"]);
});

test("#78: a blocked own claim WITH an open PR keeps its claim (it is PR ownership)", async () => {
  const withPr: Issue = { number: 50, title: "dependent", labels: ["agent-ready", "blocked", "working:a"] };
  const d = deps({ listReady: () => [withPr] });
  await pickNextIssue([{ headRef: "agent/issue-50" }], d);
  assert.deepEqual(d.edits, []);
});

test("#78: dry-run never releases a claim", async () => {
  const stale: Issue = { number: 50, title: "dependent", labels: ["agent-ready", "blocked", "working:a"] };
  const d = deps({ listReady: () => [stale], dry: true });
  await pickNextIssue([], d);
  assert.deepEqual(d.edits, []);
});

test("#78: unblocking removes `blocked` only — a ready issue is claimable next poll; a never-ready one is not", async () => {
  const forgeIssues: Issue[] = [
    { number: 60, title: "ready+blocked", labels: ["agent-ready", BLOCKED_LABEL] },
    { number: 61, title: "blocked only", labels: [BLOCKED_LABEL] },
  ];
  const listReady = () => forgeIssues.filter((i) => i.labels.includes("agent-ready"));
  assert.equal(await pickNextIssue([], deps({ listReady, mine: "", loopId: "" })), undefined, "nothing claimable while blocked");
  sweepBlockedIssues({
    listBlocked: () => forgeIssues.map((i) => ({ ...i, body: "<!-- blocker-deps: #5 -->" })),
    isClosed: () => true,
    unblock: (n) => { const i = forgeIssues.find((x) => x.number === n)!; i.labels = i.labels.filter((l) => l !== BLOCKED_LABEL); },
    hasMarkerComment: () => true, comment: () => {}, blockedLabel: BLOCKED_LABEL,
  });
  assert.deepEqual(forgeIssues.map((i) => i.labels), [["agent-ready"], []], "agent-ready untouched; never added");
  assert.equal((await pickNextIssue([], deps({ listReady, mine: "", loopId: "" })))?.number, 60);
});

test("#78: labels.blocked is optional and defaults to 'blocked'", () => {
  assert.equal(BLOCKED_LABEL, "blocked");
});

test("#78: a `blocked:<x>` sub-label blocks the resume path too (same rule as isExcluded)", async () => {
  const stale: Issue = { number: 52, title: "dependent", labels: ["agent-ready", "blocked:api", "working:a"] };
  assert.equal(isExcluded(stale.labels), true);
  const d = deps({ listReady: () => [stale] });
  assert.equal(await pickNextIssue([], d), undefined);
  assert.deepEqual(d.edits, ["remove 52 working:a"]);
});

// --- #86: an issue parked for a human is never resumed off a stale claim -------------------------

test("#86: a stale own claim on a needs-human issue is released, not resumed (the resume path bypasses isExcluded)", async () => {
  const parked: Issue = { number: 2732, title: "needs an owner decision", labels: ["agent-ready", "needs-human", "working:a"] };
  const d = deps({ listReady: () => [parked] });
  assert.equal(await pickNextIssue([], d), undefined);
  assert.deepEqual(d.edits, ["remove 2732 working:a"]);
});

// --- #88: an MR left open after its issue was closed is still OWNED (not orphaned) ---------------
const claimMod = await import("./claim.js");
const { ownedIssueNumbers } = claimMod;

test("#88: owned issues = this loop's claimed issues, open AND closed", () => {
  const owned = ownedIssueNumbers([{ number: 1 }, { number: 2 }], [{ number: 433 }]);
  assert.deepEqual([...owned].sort((a, b) => a - b), [1, 2, 433], "the closed-but-claimed issue's open MR stays drivable");
});

test("#88: a PR parked for a human leaves the in-flight set, so the next cycle dispatches new work", () => {
  const { inFlightPrs } = claimMod;
  const pr = { headRef: "agent/issue-433", labels: [] as string[] };
  assert.equal(inFlightPrs([pr], "needs-human", () => true).length, 1, "a live PR blocks dispatch (in flight)");
  pr.labels.push("needs-human"); // what the closed-issue 'park' path does
  assert.equal(inFlightPrs([pr], "needs-human", () => true).length, 0, "parked → not in flight → pickNextIssue runs");
});
