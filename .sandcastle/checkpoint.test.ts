// Checkpoint + resume for killed implement runs (#53). Real temp git repos + a bare remote; no Docker.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json")))
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const cp = await import("./checkpoint.js");
const { assertMaxResume, livenessRule } = await import("./config.js");
const { implementOpts, reviewOpts, healOpts, resolveConflictsOpts, triageOpts } = await import("./loop.js");
type Deps = Parameters<typeof cp.dispatchIssue>[1];

const ID = { name: "dev-bot", email: "dev@bot.example" };
const git = (cwd: string, c: string) =>
  execSync(`git -c user.name=seed -c user.email=seed@x -c init.defaultBranch=main ${c}`, { cwd, encoding: "utf8" }).trim();

// What run() actually rejects with on an idle kill: an Effect FiberFailure, not the tagged class.
const idleError = () => Object.assign(new Error("Agent idle for 900 seconds — no output received."), { name: "(FiberFailure) AgentIdleTimeoutError" });

// origin (bare) + host clone; the host holds upstream's worktree for agent/issue-7 at the
// conventional path, as a killed Docker run leaves it (bind-mounted, so edits are on the host).
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "afk-ckpt-"));
  const origin = join(dir, "origin.git"), host = join(dir, "host");
  git(dir, `init -q --bare ${origin}`);
  git(dir, `clone -q ${origin} ${host}`);
  writeFileSync(join(host, "app.txt"), "v1\n");
  git(host, "add -A"); git(host, "commit -q -m init"); git(host, "push -q origin HEAD:main");
  mkdirSync(join(host, ".sandcastle", "worktrees"), { recursive: true });
  const wt = cp.worktreeOf(host, 7);
  git(host, `worktree add -q -b agent/issue-7 ${wt} origin/main`);
  return { dir, origin, host, wt, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const fakeDeps = (over: Partial<Deps>): Deps => ({
  maxResume: 2, hasCheckpoint: () => false, resumes: () => 0, markResume: () => {}, escalate: () => {},
  deleteBranch: () => {}, keepBranch: () => {}, implement: async () => {}, checkpoint: () => "clean", log: () => {}, ...over,
});

// --- checkpoint on failure --------------------------------------------------------------------

test("idle-killed run with a dirty worktree → exactly one wip checkpoint commit, pushed, as the implement identity", async () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.wt, "app.txt"), "v2 half-done\n");
    writeFileSync(join(fx.wt, "new.ts"), "export const x = 1;\n");
    await assert.rejects(
      cp.dispatchIssue(7, fakeDeps({
        implement: async () => { throw idleError(); },
        checkpoint: (err) => cp.checkpointAfterFailure({ issue: 7, err, repo: fx.host, identity: ID }),
      })),
      /Agent idle/, "the run's error is still surfaced to the cycle",
    );
    const log = git(fx.origin, "log --format=%s%x09%an%x09%ae main..agent/issue-7").split("\n");
    assert.equal(log.length, 1, "exactly one checkpoint commit");
    assert.equal(log[0], "wip(#7): checkpoint after idle timeout\tdev-bot\tdev@bot.example");
    assert.doesNotMatch(git(fx.origin, "log -1 --format=%B agent/issue-7"), /co-authored-by/i);
    assert.equal(git(fx.origin, "show agent/issue-7:new.ts"), "export const x = 1;");
  } finally { fx.cleanup(); }
});

test("clean worktree → no commit, no push", () => {
  const fx = fixture();
  try {
    assert.equal(cp.checkpointAfterFailure({ issue: 7, err: idleError(), repo: fx.host, identity: ID }), "clean");
    assert.equal(git(fx.origin, "branch --list agent/issue-7"), "", "nothing pushed");
  } finally { fx.cleanup(); }
});

test("usage-limit error → no checkpoint (runGuarded's wait-and-resume path owns it)", () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.wt, "app.txt"), "dirty\n");
    const usage = new Error("Claude usage limit reached; resets at 2026-09-30T10:00:00Z");
    assert.equal(cp.checkpointAfterFailure({ issue: 7, err: usage, repo: fx.host, identity: ID }), "usage");
    assert.equal(git(fx.origin, "branch --list agent/issue-7"), "");
    assert.equal(cp.isUsageError(usage.message), true);
    assert.equal(cp.isUsageError(idleError().message), false, "an idle kill is not a usage limit");
  } finally { fx.cleanup(); }
});

test("checkpointReason names the failure", () => {
  assert.equal(cp.checkpointReason(idleError()), "idle timeout");
  assert.equal(cp.checkpointReason(Object.assign(new Error("boom"), { name: "(FiberFailure) AgentError" })), "agent error");
  assert.equal(cp.checkpointReason(new Error("boom")), "run error");
});

// --- resume vs fresh on dispatch --------------------------------------------------------------

test("hasCheckpoint: true only for a branch carrying a wip checkpoint commit", () => {
  const fx = fixture();
  try {
    assert.equal(cp.hasCheckpoint({ issue: 7, repo: fx.host, base: "main" }), false, "no remote branch");
    writeFileSync(join(fx.wt, "app.txt"), "plain\n"); git(fx.wt, "commit -qam 'feat: something'"); git(fx.wt, "push -q origin agent/issue-7");
    assert.equal(cp.hasCheckpoint({ issue: 7, repo: fx.host, base: "main" }), false, "a stale branch without a checkpoint");
    writeFileSync(join(fx.wt, "app.txt"), "wip\n");
    assert.equal(cp.checkpointAfterFailure({ issue: 7, err: idleError(), repo: fx.host, identity: ID }), "checkpointed");
    assert.equal(cp.hasCheckpoint({ issue: 7, repo: fx.host, base: "main" }), true);
  } finally { fx.cleanup(); }
});

test("dispatch with a checkpoint branch → branch kept, resume prompt injected", async () => {
  const calls: string[] = [];
  let resumed: boolean | undefined;
  const kind = await cp.dispatchIssue(7, fakeDeps({
    hasCheckpoint: () => true, resumes: () => 0,
    markResume: (k) => calls.push(`mark ${k}`), keepBranch: () => calls.push("keep"), deleteBranch: () => calls.push("delete"),
    implement: async (r) => { resumed = r; },
  }));
  assert.equal(kind, "resume");
  assert.deepEqual(calls, ["mark 1", "keep"]);
  assert.equal(resumed, true);
  const args = implementOpts(7, true).promptArgs ?? {};
  assert.match(String(args.RESUME), /resuming from a checkpoint/i);
  assert.match(String(args.RESUME), /git log -1/);
});

test("dispatch without a checkpoint → branch deleted (stale-branch protection pinned), no resume prompt", async () => {
  const calls: string[] = [];
  let resumed: boolean | undefined;
  const kind = await cp.dispatchIssue(7, fakeDeps({
    keepBranch: () => calls.push("keep"), deleteBranch: () => calls.push("delete"), implement: async (r) => { resumed = r; },
  }));
  assert.equal(kind, "fresh");
  assert.deepEqual(calls, ["delete"]);
  assert.equal(resumed, false);
  assert.equal(implementOpts(7).promptArgs?.RESUME, "");
});

test("maxResume boundary: at the limit → escalate with no dispatch; below → resume", async () => {
  let escalated = -1, ran = false;
  const at = await cp.dispatchIssue(7, fakeDeps({
    maxResume: 2, hasCheckpoint: () => true, resumes: () => 2,
    escalate: (k) => { escalated = k; }, implement: async () => { ran = true; },
  }));
  assert.equal(at, "escalate");
  assert.equal(escalated, 2);
  assert.equal(ran, false, "no further dispatch once escalated");

  const below = await cp.dispatchIssue(7, fakeDeps({ maxResume: 2, hasCheckpoint: () => true, resumes: () => 1 }));
  assert.equal(below, "resume");
});

test("countResumes counts [afk:resume] markers in the issue's comments", () => {
  assert.equal(cp.countResumes("hello"), 0);
  assert.equal(cp.countResumes(`${cp.RESUME_MARKER} resuming (1/2)\nnoise\n${cp.RESUME_MARKER} resuming (2/2)`), 2);
});

// --- config -----------------------------------------------------------------------------------

test("config: maxResume absent or invalid → load error naming the key", () => {
  assert.throws(() => assertMaxResume(undefined), /maxResume/);
  assert.throws(() => assertMaxResume(-1), /maxResume/);
  assert.throws(() => assertMaxResume(1.5), /maxResume/);
  assert.throws(() => assertMaxResume("2"), /maxResume/);
  assert.doesNotThrow(() => assertMaxResume(0));
  assert.doesNotThrow(() => assertMaxResume(3));
});

test("config.ts itself refuses to load a config without maxResume", () => {
  // Load config.ts in a child process against a temp repo root whose afk.config.json lacks the key.
  const dir = mkdtempSync(join(tmpdir(), "afk-cfg-"));
  try {
    mkdirSync(join(dir, ".sandcastle"));
    copyFileSync(join(ROOT, ".sandcastle", "config.ts"), join(dir, ".sandcastle", "config.ts"));
    copyFileSync(join(ROOT, ".sandcastle", "config-contract.ts"), join(dir, ".sandcastle", "config-contract.ts")); // its validators (#77)
    writeFileSync(join(dir, ".sandcastle", "package.json"), '{"type":"module"}');
    const example = JSON.parse(execSync(`cat ${JSON.stringify(join(ROOT, "afk.config.example.json"))}`, { encoding: "utf8" }));
    delete example.maxResume;
    writeFileSync(join(dir, "afk.config.json"), JSON.stringify(example));
    assert.throws(
      () => execSync(`node --import tsx -e 'await import(${JSON.stringify(join(dir, ".sandcastle", "config.ts"))})'`, { cwd: ROOT, stdio: "pipe" }),
      (e: { stderr?: Buffer }) => /maxResume/.test(String(e.stderr)),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- the liveness rule ------------------------------------------------------------------------

test("implement, heal, resolve and review prompts carry the background-long-commands rule; triage doesn't", () => {
  const rule = livenessRule(900);
  assert.match(rule, /BACKGROUND/);
  assert.match(rule, /15 min/);
  for (const [name, o] of Object.entries({
    implement: implementOpts(7), heal: healOpts(5, "agent/issue-5", "5"),
    resolve: resolveConflictsOpts(5, "agent/issue-5", "5"), review: reviewOpts(5, "agent/issue-5", "5"),
  })) assert.ok(String(o.promptArgs?.AGENT_RULES).includes("## Long-running commands"), `${name} must carry the liveness rule`);
  assert.equal(String(triageOpts().promptArgs?.AGENT_RULES).includes("## Long-running commands"), false);
});
