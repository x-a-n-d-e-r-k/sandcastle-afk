// Merge-path guards (#70, #71) — fakes only at the forge boundary; no Docker, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json")))
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));

const mg = await import("./merge-guard.js");

// Records forge side effects; `states` is the issue state the fake forge reports.
const recorder = (states: Record<number, string>) => {
  const calls: string[] = [];
  const deps: import("./merge-guard.js").IssueCloseDeps = {
    issueState: (n) => states[n] ?? "open",
    closeIssue: (n) => { calls.push(`close ${n}`); states[n] = "closed"; },
    releaseClaim: (n) => { calls.push(`release ${n}`); },
    log: () => {},
  };
  return { calls, deps };
};

test("#70 post-merge: an issue the forge left open gets exactly one close and one claim release", () => {
  const { calls, deps } = recorder({ 427: "open" });
  assert.equal(mg.closeLinkedIssue(427, 951, deps), "closed");
  assert.deepEqual(calls, ["close 427", "release 427"]);
});

test("#70 post-merge: an issue the forge already closed is not closed again — but its claim IS released (#88)", () => {
  const { calls, deps } = recorder({ 427: "closed" });
  assert.equal(mg.closeLinkedIssue(427, 951, deps), "already-closed");
  assert.deepEqual(calls, ["release 427"]);
});

// --- #71 merge guard -----------------------------------------------------------------------------

test("#71 alreadyLanded: equal trees → true; different → false; empty base tree → false", () => {
  assert.equal(mg.alreadyLanded("abc", "abc"), true);
  assert.equal(mg.alreadyLanded("abc", "def"), false);
  assert.equal(mg.alreadyLanded("", ""), false);
});

// Fake forge for guardedMerge: `landed` answers in sequence; every side effect is recorded.
const mergeFake = (o: { landed: (boolean | Error)[]; openAfterMerge: boolean }) => {
  const calls: string[] = [];
  let i = 0;
  const deps: import("./merge-guard.js").MergeDeps = {
    landed: () => { const v = o.landed[Math.min(i++, o.landed.length - 1)]; if (v instanceof Error) throw v; return v; },
    merge: () => { calls.push("pr-merge"); },
    stillOpen: () => o.openAfterMerge,
    finalize: (why) => { calls.push(`pr-close:${why}`); },
    closeIssue: () => { calls.push("issue-close"); },
    log: () => {},
  };
  return { calls, deps };
};

test("#71 already landed: pr-merge is NOT called; the PR and the issue are closed once each", () => {
  const { calls, deps } = mergeFake({ landed: [true], openAfterMerge: true });
  assert.equal(mg.guardedMerge(953, deps), "finalized-landed");
  assert.deepEqual(calls, ["pr-close:already-landed", "issue-close"]);
});

test("#71 not landed: pr-merge is called exactly once (normal merge unchanged)", () => {
  const { calls, deps } = mergeFake({ landed: [false], openAfterMerge: false });
  assert.equal(mg.guardedMerge(957, deps), "merged");
  assert.deepEqual(calls, ["pr-merge", "issue-close"]);
});

test("#71 the landed check errors: neither merge nor close (fail closed, never 'merge anyway')", () => {
  const { calls, deps } = mergeFake({ landed: [new Error("fatal: bad object")], openAfterMerge: true });
  assert.equal(mg.guardedMerge(950, deps), "skipped-error");
  assert.deepEqual(calls, []);
});

test("#71 merged but not finalized: one pr-close, one issue-close, and NO second pr-merge", () => {
  const { calls, deps } = mergeFake({ landed: [false, true], openAfterMerge: true });
  assert.equal(mg.guardedMerge(953, deps), "finalized-after-merge");
  assert.deepEqual(calls, ["pr-merge", "pr-close:not-finalized", "issue-close"]);
  assert.equal(calls.filter((c) => c === "pr-merge").length, 1);
});

test("#71 still open after merge and not landed: leave it for next cycle (no close)", () => {
  const { calls, deps } = mergeFake({ landed: [false, false], openAfterMerge: true });
  assert.equal(mg.guardedMerge(953, deps), "merge-pending");
  assert.deepEqual(calls, ["pr-merge"]);
});

test("#71 real git: landedOnBase is true once the change was squash-applied to base, false before", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-landed-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const run = (c: string, cwd: string) => execSync(c, { cwd, env, encoding: "utf8" }).trim();
  const g = (cwd: string, c: string) => run(`git -c user.name=t -c user.email=t@t -c init.defaultBranch=main ${c}`, cwd);
  try {
    const origin = join(dir, "origin.git"), seed = join(dir, "seed"), host = join(dir, "host");
    g(dir, `init -q --bare ${origin}`); g(dir, `clone -q ${origin} ${seed}`);
    writeFileSync(join(seed, "a.txt"), "one\n"); g(seed, "add -A"); g(seed, "commit -q -m init"); g(seed, "push -q origin HEAD:main");
    g(seed, "checkout -q -b agent/issue-1"); writeFileSync(join(seed, "a.txt"), "one\ntwo\n");
    g(seed, "commit -qam change"); g(seed, "push -q origin agent/issue-1");
    // unrelated progress on main, so base is not simply the branch's parent
    g(seed, "checkout -q main"); writeFileSync(join(seed, "b.txt"), "other\n"); g(seed, "add -A"); g(seed, "commit -q -m other"); g(seed, "push -q origin main");
    g(dir, `clone -q ${origin} ${host}`);
    const check = () => mg.landedOnBase({ repo: host, base: "main", branch: "agent/issue-1", run });
    assert.equal(check(), false, "change not on base yet");
    // Squash the change onto main by hand (what a forge squash-merge does).
    g(seed, "merge -q --squash agent/issue-1"); g(seed, "commit -q -m squash"); g(seed, "push -q origin main");
    assert.equal(check(), true, "change already on base");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#71 git version gate: >= 2.38 supports merge-tree --write-tree; older refuses to start, naming the fix", () => {
  for (const v of ["git version 2.38.0", "git version 2.54.0 (Apple Git-157)", "git version 3.0.1"])
    assert.equal(mg.gitSupportsMergeTree(v), true, v);
  for (const v of ["git version 2.34.1", "git version 1.9.9", "garbage"])
    assert.equal(mg.gitSupportsMergeTree(v), false, v);
  assert.throws(() => mg.assertGitSupportsMergeTree("git version 2.34.1"), /git >= 2\.38.*found "git version 2\.34\.1"/);
  assert.doesNotThrow(() => mg.assertGitSupportsMergeTree("git version 2.38.1"));
});

// --- #88: a failed merge CALL is an unknown outcome -------------------------------------------------

const throwingMerge = (o: { landed: boolean[]; openAfterMerge: boolean }) => {
  const f = mergeFake(o);
  f.deps.merge = () => { f.calls.push("pr-merge"); throw new Error("Command failed: forge pr-merge 953 — HTTP 500"); };
  return f;
};

test("#88 the server merged, then the call failed, and the MR stayed open → finalized (closed + issue), NO second merge", () => {
  const { calls, deps } = throwingMerge({ landed: [false, true], openAfterMerge: true });
  assert.equal(mg.guardedMerge(953, deps), "finalized-after-merge");
  assert.deepEqual(calls, ["pr-merge", "pr-close:not-finalized", "issue-close"]);
});

test("#88 the call failed but the forge DID finalize the merge → merged (the cycle doesn't error)", () => {
  const { calls, deps } = throwingMerge({ landed: [false], openAfterMerge: false });
  assert.equal(mg.guardedMerge(953, deps), "merged");
  assert.deepEqual(calls, ["pr-merge", "issue-close"]);
});

test("#88 a GENUINE failure (nothing landed, still open) → merge-pending: no close, retried next cycle by the loop", () => {
  const { calls, deps } = throwingMerge({ landed: [false, false], openAfterMerge: true });
  assert.equal(mg.guardedMerge(953, deps), "merge-pending");
  assert.deepEqual(calls, ["pr-merge"]);
});

test("#88 a PR whose issue is CLOSED: every definite answer takes it OUT of flight; only a transient error waits", () => {
  const a = (headExists: boolean | "error", landed: boolean | "error") => mg.closedIssuePrAction({ headExists, landed: () => landed });
  assert.equal(a(true, true), "finalize", "already on base → close the PR, release the claim");
  assert.equal(a(true, false), "park", "not on base (e.g. closed as not planned) → needs-human, never merged — and no longer blocks dispatch");
  assert.equal(a(false, "error"), "orphan", "branch gone → orphan handling (the landed check would only error forever)");
  assert.equal(a("error", true), "wait", "head check failed → retry next cycle");
  assert.equal(a(true, "error"), "wait", "landed check failed → retry next cycle");
});

test("#88 the landed check is not even attempted for an orphan (its fetch would fail)", () => {
  let called = false;
  assert.equal(mg.closedIssuePrAction({ headExists: false, landed: () => { called = true; return "error"; } }), "orphan");
  assert.equal(called, false);
});

test("#88 real git: an abandoned PR that CONFLICTS with base → 'not landed' → park (not wait forever); the pre-merge guard still throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-conflict-park-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const run = (c: string, cwd: string) => execSync(c, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const g = (cwd: string, c: string) => run(`git -c user.name=t -c user.email=t@t -c init.defaultBranch=main ${c}`, cwd);
  try {
    const origin = join(dir, "origin.git"), seed = join(dir, "seed"), host = join(dir, "host");
    g(dir, `init -q --bare ${origin}`); g(dir, `clone -q ${origin} ${seed}`);
    writeFileSync(join(seed, "a.txt"), "one\n"); g(seed, "add -A"); g(seed, "commit -q -m init"); g(seed, "push -q origin HEAD:main");
    g(seed, "checkout -q -b agent/issue-433"); writeFileSync(join(seed, "a.txt"), "branch version\n");
    g(seed, "commit -qam pr"); g(seed, "push -q origin agent/issue-433");
    g(seed, "checkout -q main"); writeFileSync(join(seed, "a.txt"), "main moved on\n");
    g(seed, "commit -qam later"); g(seed, "push -q origin main");
    g(dir, `clone -q ${origin} ${host}`);
    const o = { repo: host, base: "main", branch: "agent/issue-433", run };
    assert.throws(() => mg.landedOnBase(o), "default (pre-merge guard): a conflict throws → don't merge this cycle");
    assert.equal(mg.landedOnBase({ ...o, conflictMeansNotLanded: true }), false, "closed-issue path: a conflict means not on base");
    assert.equal(mg.closedIssuePrAction({ headExists: true, landed: () => mg.landedOnBase({ ...o, conflictMeansNotLanded: true }) }), "park");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
