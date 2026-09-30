// Re-render instead of parking (#67). The sandbox runner is faked; the git pieces run against real
// temp repos with a bare remote. No Docker, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json")))
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const { rerenderBeforeEscalating, publishArtifacts } = await import("./rerender.js");
const { implementUiBlock, renderedHeads, persistedRenderInputs, uiGate } = await import("./ui.js");
type Deps = Parameters<typeof rerenderBeforeEscalating>[2];
type Blocked = Parameters<typeof rerenderBeforeEscalating>[1];

const OLD = "7a586a1f00000000000000000000000000000000";
const NEW = "89caa33f00000000000000000000000000000000";
const missing: Blocked = { required: true, blocked: true, kind: "missing", files: ["apps/web/App.tsx"], artifacts: [], reason: "PR #2630 changes 1 UI file(s) but published no screenshots for the current head 89caa33f." };

const deps = (over: Partial<Deps> = {}): Deps & { renders: number } => {
  const d = {
    renders: 0,
    head: NEW,
    renderedHeads: () => [OLD],
    inputsConfigured: true,
    persistedInputs: () => ["pr-2630/render-inputs/.afk/render.json"],
    renderAndPublish: async () => { d.renders++; return { exitCode: 0, output: "wrote 6 images" }; },
    recheck: () => ({ required: true as const, blocked: false as const, files: ["apps/web/App.tsx"], artifacts: ["pr-2630/89caa33f/a.png"] }),
    log: () => {},
    ...over,
  };
  return d;
};

test("approved PR with screenshots for an older head + a persisted spec → one re-render, gate passes, not escalated", async () => {
  const d = deps();
  const r = await rerenderBeforeEscalating(2630, missing, d);
  assert.equal(r.ok, true);
  assert.equal(d.renders, 1);
});

test("the re-render exits non-zero → escalated, and the reason carries the render's failure line", async () => {
  const d = deps({ renderAndPublish: async () => ({ exitCode: 1, output: "booting app...\nError: seed module ./seed-users not found\n" }) });
  const r = await rerenderBeforeEscalating(2630, missing, d);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /failed \(exit 1\): Error: seed module \.\/seed-users not found/);
});

test("no persisted spec (renderInputs configured) → escalated with 'no render spec to replay', no render attempted", async () => {
  const d = deps({ persistedInputs: () => [] });
  const r = await rerenderBeforeEscalating(2630, missing, d);
  assert.match(r.ok === false ? r.reason : "", /no render spec to replay/);
  assert.equal(d.renders, 0);
});

test("renderInputs NOT configured: nothing to replay is needed → the re-render still runs", async () => {
  const d = deps({ inputsConfigured: false, persistedInputs: () => [] });
  assert.equal((await rerenderBeforeEscalating(2630, missing, d)).ok, true);
  assert.equal(d.renders, 1);
});

test("never rendered (no older head) → escalated as before: the #19 'nobody looked' case stays a human's call", async () => {
  const d = deps({ renderedHeads: () => [] });
  const r = await rerenderBeforeEscalating(2630, missing, d);
  assert.deepEqual(r, { ok: false, reason: missing.reason });
  assert.equal(d.renders, 0);
});

test("a diff/head ERROR is not staleness → fail closed as before, no render", async () => {
  const d = deps();
  const err: Blocked = { ...missing, kind: "error", reason: "could not resolve the diff" };
  assert.deepEqual(await rerenderBeforeEscalating(2630, err, d), { ok: false, reason: "could not resolve the diff" });
  assert.equal(d.renders, 0);
});

test("the render couldn't even start (sandbox error) → escalated with the error; published but gate still blocked → escalated", async () => {
  const boom = await rerenderBeforeEscalating(2630, missing, deps({ renderAndPublish: async () => { throw new Error("docker: image not found"); } }));
  assert.match(boom.ok === false ? boom.reason : "", /could not run: docker: image not found/);
  const still = await rerenderBeforeEscalating(2630, missing, deps({ recheck: () => ({ ...missing, reason: "still nothing" }) }));
  assert.match(still.ok === false ? still.reason : "", /still blocked: still nothing/);
});

// --- git pieces, against a real bare remote --------------------------------------------------

const git = (cwd: string, c: string) => execSync(`git -c user.name=t -c user.email=t@t -c init.defaultBranch=main ${c}`, { cwd, encoding: "utf8" }).trim();
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "afk-rerender-"));
  const origin = join(dir, "origin.git"), host = join(dir, "host");
  git(dir, `init -q --bare ${origin}`); git(dir, `clone -q ${origin} ${host}`);
  git(host, "commit -q --allow-empty -m init"); git(host, "push -q origin HEAD:main");
  return { dir, origin, host, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const run = (c: string, cwd: string) => execSync(c, { cwd, encoding: "utf8" }).trim();
const hostRun = (host: string) => (c: string) => run(c, host);

test("publishArtifacts pushes images to pr-<n>/<sha>/ (creating the orphan branch), and the gate then sees them", () => {
  const fx = repo();
  try {
    const src = join(fx.dir, "shots"); mkdirSync(src); writeFileSync(join(src, "desktop-dark.png"), "png");
    const n = publishArtifacts({ repo: fx.host, artifactBranch: "afk/artifacts", pr: 7, sha: NEW, srcDir: src, identity: { name: "dev-bot", email: "d@b" } });
    assert.equal(n, 1);
    assert.equal(git(fx.origin, `show afk/artifacts:pr-7/${NEW}/desktop-dark.png`), "png");
    assert.equal(git(fx.origin, "log -1 --format=%an afk/artifacts"), "dev-bot");
    // A second publish at another head reuses the existing branch.
    publishArtifacts({ repo: fx.host, artifactBranch: "afk/artifacts", pr: 7, sha: OLD, srcDir: src, identity: { name: "dev-bot", email: "d@b" } });
    assert.deepEqual(renderedHeads(7, "afk/artifacts", hostRun(fx.host)).sort(), [OLD, NEW].sort());
  } finally { fx.cleanup(); }
});

test("publishArtifacts refuses an empty render (nothing written ≠ screenshots)", () => {
  const fx = repo();
  try {
    const src = join(fx.dir, "empty"); mkdirSync(src);
    assert.throws(() => publishArtifacts({ repo: fx.host, artifactBranch: "afk/artifacts", pr: 7, sha: NEW, srcDir: src, identity: { name: "b", email: "b@b" } }), /wrote nothing/);
  } finally { fx.cleanup(); }
});

test("the implement block's publish step persists EXACTLY the configured renderInputs, nothing else from .afk/", () => {
  const ui = { verifyGlobs: ["apps/web/**"], renderCmd: "pnpm ui:render", artifactDir: ".afk/screenshots", renderInputs: [".afk/render.json", ".afk/seed"] };
  const block = implementUiBlock(ui);
  // Pull out the render-inputs lines of the snippet and execute them for real.
  const lines = block.split("\n").map((l) => l.trim());
  const i = lines.findIndex((l) => l.startsWith("# render inputs"));
  assert.ok(i >= 0, "the publish step must persist render inputs when renderInputs is configured");
  const snippet = lines.slice(i + 1, i + 3).join("\n");
  const fx = repo();
  try {
    const work = join(fx.dir, "work"), tmp = join(fx.dir, "tmpclone");
    mkdirSync(join(work, ".afk", "seed"), { recursive: true }); mkdirSync(tmp);
    writeFileSync(join(work, ".afk", "render.json"), '{"pages":["/"]}');
    writeFileSync(join(work, ".afk", "seed", "users.ts"), "export {}");
    writeFileSync(join(work, ".afk", "debug.log"), "noise");         // not an input
    mkdirSync(join(work, ".afk", "screenshots")); writeFileSync(join(work, ".afk", "screenshots", "x.png"), "png");
    execFileSync("bash", ["-c", `set -e; tmp=${JSON.stringify(tmp)}; PR=5\n${snippet}`], { cwd: work });
    const got = run("find . -type f | sort", join(tmp, "pr-5", "render-inputs")).split("\n");
    assert.deepEqual(got, ["./.afk/render.json", "./.afk/seed/users.ts"]);
  } finally { fx.cleanup(); }
  assert.equal(implementUiBlock({ ...ui, renderInputs: undefined }).includes("# render inputs"), false, "no inputs configured → no persistence step");
});

test("persistedRenderInputs lists pr-<n>/render-inputs/ and renderedHeads ignores that dir", () => {
  const fx = repo();
  try {
    const work = join(fx.dir, "w"); git(fx.dir, `clone -q ${fx.origin} ${work}`);
    git(work, "checkout -q --orphan afk/artifacts"); git(work, "rm -rq --cached . --ignore-unmatch");
    mkdirSync(join(work, "pr-9", OLD), { recursive: true }); writeFileSync(join(work, "pr-9", OLD, "a.png"), "x");
    mkdirSync(join(work, "pr-9", "render-inputs", ".afk"), { recursive: true }); writeFileSync(join(work, "pr-9", "render-inputs", ".afk", "render.json"), "{}");
    git(work, "add pr-9"); git(work, "commit -q -m a"); git(work, "push -q origin afk/artifacts");
    const r = hostRun(fx.host);
    assert.deepEqual(renderedHeads(9, "afk/artifacts", r), [OLD]);
    assert.deepEqual(persistedRenderInputs(9, "afk/artifacts", r), ["pr-9/render-inputs/.afk/render.json"]);
    assert.deepEqual(persistedRenderInputs(10, "afk/artifacts", r), []);
  } finally { fx.cleanup(); }
});

test("uiGate reports kind 'missing' for stale screenshots and kind 'error' when the diff can't resolve", () => {
  const UI = { verifyGlobs: ["apps/web/**"], renderCmd: "x", artifactDir: "y" };
  const g = uiGate(1, "agent/issue-1", UI, { changed: () => ["apps/web/A.tsx"], headSha: () => NEW, artifacts: () => [] });
  assert.equal(g.required && g.blocked ? g.kind : "", "missing");
  const e = uiGate(1, "agent/issue-1", UI, { changed: () => { throw new Error("no ref"); } });
  assert.equal(e.required && e.blocked ? e.kind : "", "error");
});
