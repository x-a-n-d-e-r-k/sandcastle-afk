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
