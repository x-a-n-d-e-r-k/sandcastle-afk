// Conflict path (#54): host-side mechanical merge first; retry cap counts CONSECUTIVE failures.
// Real temp git repos + a bare remote — no Docker, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json")))
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));

// Isolate every git call (ours and the module's) from the developer's global config
// (signing, hooks, default branch names).
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const { mechanicalMerge, handleConflict, baseTip, branchContains, baseMergeOverlap } = await import("./conflicts.js");
type Deps = Parameters<typeof handleConflict>[1];

const ID = { name: "dev-bot", email: "dev@bot.example" };
const git = (cwd: string, c: string) =>
  execSync(`git -c user.name=seed -c user.email=seed@x -c init.defaultBranch=main ${c}`, { cwd, encoding: "utf8" }).trim();

// A bare "origin", a seeding clone, and a separate "host" clone (the loop's checkout).
function fixture(opts: { attrs?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "afk-conflict-"));
  const origin = join(dir, "origin.git"), seed = join(dir, "seed"), host = join(dir, "host");
  git(dir, `init -q --bare ${origin}`);
  git(dir, `clone -q ${origin} ${seed}`);
  if (opts.attrs) writeFileSync(join(seed, ".gitattributes"), opts.attrs);
  writeFileSync(join(seed, "CHANGELOG.md"), "# Changelog\n");
  writeFileSync(join(seed, "app.txt"), "value = 1\n");
  git(seed, "add -A"); git(seed, "commit -q -m init"); git(seed, "push -q origin HEAD:main");
  git(dir, `clone -q ${origin} ${host}`);
  return { dir, origin, seed, host, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
// Diverge: the PR branch and main each change `file` from the same base.
function diverge(seed: string, file: string, onBranch: (p: string) => void, onMain: (p: string) => void) {
  git(seed, "checkout -q -b agent/issue-1");
  onBranch(join(seed, file)); git(seed, "commit -qam branch-change"); git(seed, "push -q origin agent/issue-1");
  git(seed, "checkout -q main");
  onMain(join(seed, file)); git(seed, "commit -qam main-change"); git(seed, "push -q origin main");
}

// forge's marker semantics, in memory: retries since the last "resolved" marker.
function markerCounter() {
  const markers: string[] = [];
  return {
    markers,
    failures: () => { const i = markers.lastIndexOf("resolved"); return markers.slice(i + 1).filter((m) => m === "retry").length; },
    markAttempt: () => { markers.push("retry"); },
    markResolved: () => { markers.push("resolved"); },
  };
}
const deps = (over: Partial<Deps>): Deps => {
  const c = markerCounter();
  return {
    maxFailures: 3, alreadyContainsBase: () => false,
    failures: c.failures, markAttempt: c.markAttempt, markResolved: c.markResolved,
    mechanical: () => "conflicted", agent: async () => true, escalate: () => {}, log: () => {}, ...over,
  };
};

test("union-driver-only conflict: merged on the host, pushed, no agent, counter reset", async () => {
  const fx = fixture({ attrs: "CHANGELOG.md merge=union\n" });
  try {
    diverge(fx.seed, "CHANGELOG.md", (p) => appendFileSync(p, "- branch entry\n"), (p) => appendFileSync(p, "- main entry\n"));
    const c = markerCounter();
    c.markAttempt(); // a prior failed attempt: success must reset it
    let agentRuns = 0;
    const out = await handleConflict(1, deps({
      failures: c.failures, markAttempt: c.markAttempt, markResolved: c.markResolved,
      mechanical: () => mechanicalMerge({ repo: fx.host, branch: "agent/issue-1", base: "main", identity: ID }),
      agent: async () => { agentRuns++; return true; },
    }));
    assert.equal(out, "mechanical");
    assert.equal(agentRuns, 0, "no agent run for a merge-driver-only conflict");
    assert.equal(c.failures(), 0, "a mechanical success resets the consecutive-failure count");

    // The pushed branch now contains main, carries both entries, and the merge is ours.
    git(fx.host, "fetch -q origin");
    git(fx.host, "merge-base --is-ancestor origin/main origin/agent/issue-1");
    const log = git(fx.host, "show origin/agent/issue-1:CHANGELOG.md");
    assert.match(log, /- branch entry/); assert.match(log, /- main entry/);
    assert.equal(git(fx.host, "log -1 '--format=%an <%ae>' origin/agent/issue-1"), "dev-bot <dev@bot.example>");
    assert.doesNotMatch(git(fx.host, "log -1 --format=%B origin/agent/issue-1"), /co-authored-by/i);
    // The host checkout was never touched, and no temp worktree leaked.
    assert.equal(git(fx.host, "rev-parse --abbrev-ref HEAD"), "main");
    assert.equal(git(fx.host, "worktree list --porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
  } finally { fx.cleanup(); }
});

test("a real content conflict: mechanical merge aborts cleanly, pushes nothing, agent resolver runs", async () => {
  const fx = fixture({ attrs: "CHANGELOG.md merge=union\n" });
  try {
    diverge(fx.seed, "app.txt", (p) => writeFileSync(p, "value = 2\n"), (p) => writeFileSync(p, "value = 3\n"));
    const before = git(fx.origin, "rev-parse agent/issue-1");
    assert.equal(mechanicalMerge({ repo: fx.host, branch: "agent/issue-1", base: "main", identity: ID }), "conflicted");
    assert.equal(git(fx.origin, "rev-parse agent/issue-1"), before, "nothing pushed on a conflict");
    assert.equal(git(fx.host, "status --porcelain"), "", "host checkout untouched");
    assert.equal(git(fx.host, "worktree list --porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1);

    let agentRuns = 0;
    const out = await handleConflict(1, deps({
      mechanical: () => mechanicalMerge({ repo: fx.host, branch: "agent/issue-1", base: "main", identity: ID }),
      agent: async () => { agentRuns++; return true; },
    }));
    assert.equal(out, "agent-resolved");
    assert.equal(agentRuns, 1);
  } finally { fx.cleanup(); }
});

test("baseTip/branchContains: resolved iff the pushed branch contains the pre-run base tip", () => {
  const fx = fixture({});
  try {
    diverge(fx.seed, "app.txt", (p) => writeFileSync(p, "value = 2\n"), () => appendFileSync(join(fx.seed, "CHANGELOG.md"), "- main\n"));
    const sha = baseTip(fx.host, "main");
    assert.equal(branchContains(fx.host, "agent/issue-1", sha), false);
    git(fx.seed, "checkout -q agent/issue-1"); git(fx.seed, "merge -q --no-edit main"); git(fx.seed, "push -q origin agent/issue-1");
    // main moves AGAIN after the resolve — still counts as resolved against the tip it was given.
    git(fx.seed, "checkout -q main"); appendFileSync(join(fx.seed, "CHANGELOG.md"), "- later\n");
    git(fx.seed, "commit -qam later"); git(fx.seed, "push -q origin main");
    assert.equal(branchContains(fx.host, "agent/issue-1", sha), true);
  } finally { fx.cleanup(); }
});

test("counter: conflict→success three times over is never escalated", async () => {
  const c = markerCounter();
  let escalated = 0;
  const d = deps({ failures: c.failures, markAttempt: c.markAttempt, markResolved: c.markResolved, escalate: () => { escalated++; } });
  // Alternate mechanical and agent successes, more times than the cap.
  for (const mech of [true, false, true, false, false, true]) {
    const out = await handleConflict(1, { ...d, mechanical: () => (mech ? "merged" : "conflicted"), agent: async () => true });
    assert.notEqual(out, "escalated");
  }
  assert.equal(escalated, 0);
  assert.equal(c.failures(), 0);
});

test("counter: three consecutive failed resolutions escalate on the next conflict", async () => {
  const c = markerCounter();
  let escalated = 0, agentRuns = 0;
  const d = deps({
    failures: c.failures, markAttempt: c.markAttempt, markResolved: c.markResolved,
    agent: async () => { agentRuns++; return false; }, escalate: () => { escalated++; },
  });
  for (let i = 0; i < 3; i++) assert.equal(await handleConflict(1, d), "agent-failed");
  assert.equal(await handleConflict(1, d), "escalated");
  assert.equal(escalated, 1);
  assert.equal(agentRuns, 3, "no fourth agent run once the cap is hit");
});

test("counter: a success between failures resets the streak (fail, fail, success, fail, fail → no escalation)", async () => {
  const c = markerCounter();
  let escalated = 0;
  const d = deps({ failures: c.failures, markAttempt: c.markAttempt, markResolved: c.markResolved, escalate: () => { escalated++; } });
  for (const ok of [false, false, true, false, false]) await handleConflict(1, { ...d, agent: async () => ok });
  assert.equal(escalated, 0);
  assert.equal(c.failures(), 2);
});

test("a mechanical-merge ERROR (not a conflict) falls back to the agent instead of wedging the cycle", async () => {
  let agentRuns = 0;
  const out = await handleConflict(1, deps({
    mechanical: () => { throw new Error("push rejected"); },
    agent: async () => { agentRuns++; return true; },
  }));
  assert.equal(out, "agent-resolved");
  assert.equal(agentRuns, 1);
});

// --- stale forge conflict flag (#68) -------------------------------------------------------

test("stale flag: branch already contains base → 'stale-flag', and nothing is marked, merged, run or escalated", async () => {
  const calls: string[] = [];
  const out = await handleConflict(951, deps({
    alreadyContainsBase: () => true,
    failures: () => { calls.push("failures"); return 99; }, // even at/over the cap: a stale flag is not a failure
    markAttempt: () => calls.push("markAttempt"), markResolved: () => calls.push("markResolved"),
    mechanical: () => { calls.push("mechanical"); return "merged"; },
    agent: async () => { calls.push("agent"); return true; },
    escalate: () => calls.push("escalate"),
  }));
  assert.equal(out, "stale-flag");
  assert.deepEqual(calls, []);
});

test("stale flag: a real conflict (branch lacks base) runs the mechanical-then-agent path exactly as before", async () => {
  const calls: string[] = [];
  const out = await handleConflict(1, deps({
    alreadyContainsBase: () => false,
    mechanical: () => { calls.push("mechanical"); return "conflicted"; },
    markAttempt: () => calls.push("markAttempt"),
    agent: async () => { calls.push("agent"); return true; },
    markResolved: () => calls.push("markResolved"),
  }));
  assert.equal(out, "agent-resolved");
  assert.deepEqual(calls, ["mechanical", "markAttempt", "agent", "markResolved"]);
});

test("stale flag: the check itself errors → fall through to the mechanical merge, never 'stale-flag'", async () => {
  let mech = 0;
  const out = await handleConflict(1, deps({
    alreadyContainsBase: () => { throw new Error("fatal: couldn't find remote ref"); },
    mechanical: () => { mech++; return "merged"; },
  }));
  assert.equal(out, "mechanical");
  assert.equal(mech, 1);
});

test("stale flag with real git: a branch that already merged main is detected via baseTip/branchContains", async () => {
  const fx = fixture({});
  try {
    diverge(fx.seed, "app.txt", (p) => writeFileSync(p, "value = 2\n"), () => appendFileSync(join(fx.seed, "CHANGELOG.md"), "- main\n"));
    git(fx.seed, "checkout -q agent/issue-1"); git(fx.seed, "merge -q --no-edit main"); git(fx.seed, "push -q origin agent/issue-1");
    let mech = 0;
    const out = await handleConflict(1, deps({
      alreadyContainsBase: () => branchContains(fx.host, "agent/issue-1", baseTip(fx.host, "main")),
      mechanical: () => { mech++; return "merged"; },
    }));
    assert.equal(out, "stale-flag");
    assert.equal(mech, 0);
  } finally { fx.cleanup(); }
});

// --- does a mechanical base merge need a re-review? ------------------------------------------

// The PR adds a CHANGELOG entry and edits app.txt; main then adds its own CHANGELOG entry (the
// forge calls that a conflict — it ignores merge=union) and changes `mainFile`.
const PAD = "\na\nb\nc\nd\ne\n";
function baseMerge(mainFile: string, mainContent: string, attrs = "CHANGELOG.md merge=union\n") {
  const fx = fixture({ attrs });
  writeFileSync(join(fx.seed, "lib.txt"), "lib = 1\n");
  writeFileSync(join(fx.seed, "app.txt"), `value = 1\n${PAD}`);
  git(fx.seed, "add -A"); git(fx.seed, "commit -q -m lib"); git(fx.seed, "push -q origin HEAD:main");
  git(fx.seed, "checkout -q -b agent/issue-1");
  writeFileSync(join(fx.seed, "CHANGELOG.md"), "# Changelog\n- pr entry\n");
  writeFileSync(join(fx.seed, "app.txt"), `value = 2\n${PAD}`);
  git(fx.seed, "commit -qam pr"); git(fx.seed, "push -q origin agent/issue-1");
  git(fx.seed, "checkout -q main");
  writeFileSync(join(fx.seed, "CHANGELOG.md"), "# Changelog\n- main entry\n");
  writeFileSync(join(fx.seed, mainFile), mainContent);
  git(fx.seed, "add -A"); git(fx.seed, "commit -q -m main"); git(fx.seed, "push -q origin main");
  let heads: { oldHead: string; newHead: string } | null = null;
  const r = mechanicalMerge({ repo: fx.host, branch: "agent/issue-1", base: "main", identity: ID, onMerged: (oldHead, newHead) => { heads = { oldHead, newHead }; } });
  return { fx, r, heads: heads as { oldHead: string; newHead: string } | null };
}

test("base merge: only a merge=union CHANGELOG and files the PR didn't touch -> no overlap (keep the review)", () => {
  const { fx, r, heads } = baseMerge("lib.txt", "lib = 2\n");
  try {
    assert.equal(r, "merged");
    assert.ok(heads && heads.oldHead !== heads.newHead);
    assert.deepEqual(baseMergeOverlap({ repo: fx.host, base: "main", ...heads! }), []);
  } finally { fx.cleanup(); }
});

test("base merge: main also changed a file the PR changed (merged cleanly) -> overlap (re-review)", () => {
  // app.txt: the PR changed line 1; main appends a line, so git merges it cleanly — but the PR's own
  // file now differs from what was reviewed.
  const { fx, r, heads } = baseMerge("app.txt", `value = 1\n${PAD}other = 3\n`);
  try {
    assert.equal(r, "merged");
    assert.deepEqual(baseMergeOverlap({ repo: fx.host, base: "main", ...heads! }), ["app.txt"]);
  } finally { fx.cleanup(); }
});

test("base merge: a CHANGELOG overlap counts when it is NOT merge=union", () => {
  // Without the union driver the two top entries conflict, so make main's entry non-adjacent.
  const fx = fixture({});
  try {
    writeFileSync(join(fx.seed, "CHANGELOG.md"), "# Changelog\n\na\nb\nc\nd\ne\n");
    git(fx.seed, "commit -qam pad"); git(fx.seed, "push -q origin HEAD:main");
    git(fx.seed, "checkout -q -b agent/issue-1");
    writeFileSync(join(fx.seed, "CHANGELOG.md"), "# Changelog\n- pr\n\na\nb\nc\nd\ne\n");
    git(fx.seed, "commit -qam pr"); git(fx.seed, "push -q origin agent/issue-1");
    git(fx.seed, "checkout -q main");
    writeFileSync(join(fx.seed, "CHANGELOG.md"), "# Changelog\n\na\nb\nc\nd\ne\n- main\n");
    git(fx.seed, "commit -qam main"); git(fx.seed, "push -q origin main");
    let heads: { oldHead: string; newHead: string } | null = null;
    assert.equal(mechanicalMerge({ repo: fx.host, branch: "agent/issue-1", base: "main", identity: ID, onMerged: (oldHead, newHead) => { heads = { oldHead, newHead }; } }), "merged");
    assert.deepEqual(baseMergeOverlap({ repo: fx.host, base: "main", ...(heads as unknown as { oldHead: string; newHead: string }) }), ["CHANGELOG.md"]);
  } finally { fx.cleanup(); }
});

test("baseMergeOverlap throws on an unknown commit (the loop then re-reviews)", () => {
  const fx = fixture({});
  try {
    assert.throws(() => baseMergeOverlap({ repo: fx.host, base: "main", oldHead: "deadbeef", newHead: "deadbeef" }));
  } finally { fx.cleanup(); }
});
