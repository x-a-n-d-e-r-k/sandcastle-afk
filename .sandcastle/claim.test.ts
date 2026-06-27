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
const { isExcluded } = await import("./config.js");

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
