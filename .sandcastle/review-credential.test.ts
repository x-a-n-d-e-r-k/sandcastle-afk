// Reviewer-credential isolation (#32) — no sandbox, no Docker.
// FORGE_REVIEW_TOKEN gates PR approval and approval gates auto-merge. It must reach the review
// run's agent env and NOTHING else, and startup must refuse a misplaced/missing token.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// config.ts throws without afk.config.json (per-project + gitignored). Seed from the example,
// and force reviewMode:"internal" so cfg.reviewMode is deterministic here. Import dynamically
// so this runs before the modules under test load.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CFG = join(ROOT, "afk.config.json");
if (!existsSync(CFG)) copyFileSync(join(ROOT, "afk.config.example.json"), CFG);

// The reviewer token must be in the host env before loop.ts's factories are exercised.
process.env.FORGE_REVIEW_TOKEN = "review-token-xyz";

const { reviewOpts, implementOpts, healOpts, resolveConflictsOpts, triageOpts } = await import("./loop.js");
const { assertReviewCredential, reviewAgentEnv, envFileDeclaresToken } = await import("./config.js");

// The agent provider from claudeCode(model, {env}) exposes `env` as a readable field.
const agentEnv = (opts: { agent: unknown }): Record<string, string> =>
  (opts.agent as { env?: Record<string, string> }).env ?? {};

// --- env shaping: exact key, not a serialized-blob substring (issue criterion 7) -----------

test("reviewOpts injects FORGE_REVIEW_TOKEN into the review agent's env", () => {
  // Load-bearing: this FAILS against pre-#32 code, where reviewOpts used baseRun's
  // claudeCode(model) with env {} and the token reached the sandbox only via upstream's .env
  // read. The explicit review-only injection is the new enforcement channel.
  assert.equal(agentEnv(reviewOpts(5, "agent/issue-5", "5")).FORGE_REVIEW_TOKEN, "review-token-xyz");
});

test("implementOpts does NOT put FORGE_REVIEW_TOKEN in the agent env", () => {
  assert.equal("FORGE_REVIEW_TOKEN" in agentEnv(implementOpts(5)), false);
});

test("healOpts and the conflict-resolver do NOT get the reviewer token", () => {
  // The sharpest form of the hole: both write code on the PR's own branch.
  assert.equal("FORGE_REVIEW_TOKEN" in agentEnv(healOpts(5, "agent/issue-5", "5")), false);
  assert.equal("FORGE_REVIEW_TOKEN" in agentEnv(resolveConflictsOpts(5, "agent/issue-5", "5")), false);
});

test("triageOpts does NOT get the reviewer token", () => {
  assert.equal("FORGE_REVIEW_TOKEN" in agentEnv(triageOpts()), false);
});

test("reviewAgentEnv is empty when the token is unset (external mode never approves)", () => {
  const saved = process.env.FORGE_REVIEW_TOKEN;
  delete process.env.FORGE_REVIEW_TOKEN;
  try {
    assert.deepEqual(reviewAgentEnv(), {});
  } finally {
    process.env.FORGE_REVIEW_TOKEN = saved;
  }
});

// --- the startup guard (pure) --------------------------------------------------------------

test("guard: internal mode + no token anywhere → throws, naming .env.review", () => {
  assert.throws(
    () => assertReviewCredential({ reviewMode: "internal", hostHasToken: false, dotEnvHasToken: false }),
    /\.env\.review/,
  );
});

test("guard: external mode + no token → does NOT throw", () => {
  assert.doesNotThrow(() =>
    assertReviewCredential({ reviewMode: "external", hostHasToken: false, dotEnvHasToken: false }));
});

test("guard: token declared in .env → throws (leaks into every sandbox), even if host has it too", () => {
  assert.throws(
    () => assertReviewCredential({ reviewMode: "internal", hostHasToken: true, dotEnvHasToken: true }),
    /must not appear in \.sandcastle\/\.env/,
  );
});

test("guard: internal mode + token in host env (correct setup) → does NOT throw", () => {
  assert.doesNotThrow(() =>
    assertReviewCredential({ reviewMode: "internal", hostHasToken: true, dotEnvHasToken: false }));
});

// --- .env token detection: a real value is the leak; an empty assignment is not -------------

test("envFileDeclaresToken: true for ANY declaration — bare or valued (not just non-empty)", () => {
  // The regression this PR must not ship: upstream keys sandbox injection on the KEY's presence
  // and fills a blank value from the host env, and this module loads .env.review into that host
  // env. So a bare `FORGE_REVIEW_TOKEN=` line leaks the real token exactly as a valued one does —
  // it must be refused, not waved through. Detection mirrors upstream's parse (key = text before
  // the first `=`, comments/blanks skipped).
  const dir = mkdtempSync(join(tmpdir(), "afk-env-"));
  const f = join(dir, ".env");
  try {
    writeFileSync(f, "FORGE_REVIEW_TOKEN=ghp_real\n");
    assert.equal(envFileDeclaresToken(f), true, "valued line must be refused");

    writeFileSync(f, "GH_TOKEN=abc\nFORGE_REVIEW_TOKEN=\n"); // bare — the reopened hole
    assert.equal(envFileDeclaresToken(f), true, "a BARE line must be refused (upstream still injects it)");

    writeFileSync(f, "  FORGE_REVIEW_TOKEN =  \n"); // whitespace around key/value
    assert.equal(envFileDeclaresToken(f), true);

    writeFileSync(f, "# FORGE_REVIEW_TOKEN=ghp_only_in_a_comment\nGH_TOKEN=x\n");
    assert.equal(envFileDeclaresToken(f), false, "a commented line is not injected by upstream");

    writeFileSync(f, "GH_TOKEN=abc\nCLAUDE_CODE_OAUTH_TOKEN=x\n");
    assert.equal(envFileDeclaresToken(f), false, "absent → not declared");

    assert.equal(envFileDeclaresToken(join(dir, "nope.env")), false); // missing file
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
