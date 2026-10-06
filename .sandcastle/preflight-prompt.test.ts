// Preflight travels in the prompt, not as a file (#55) — no sandbox, no Docker.
// The sandbox worktree holds only tracked files, so the generated (gitignored)
// .sandcastle/preflight.sh is never there; every preflight-running prompt must carry the
// commands themselves, rendered from cfg.preflight.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// config.ts throws without afk.config.json — seed it from the example before importing.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CFG = join(ROOT, "afk.config.json");
if (!existsSync(CFG)) copyFileSync(join(ROOT, "afk.config.example.json"), CFG);

const { renderPreflight, cfg, PREFLIGHT_IN_TURN } = await import("./config.js");
const { implementOpts, reviewOpts, healOpts, resolveConflictsOpts, triageOpts } = await import("./loop.js");
const { mainImplementOpts } = await import("./main.js");
const { cliReviewOpts } = await import("./review.js");

// --- renderPreflight --------------------------------------------------------------------------

test("renderPreflight: single command → fenced bash block with set -e", () => {
  assert.equal(renderPreflight(["npm run preflight"]), "```bash\nset -e\nnpm run preflight\n```\n\n" + PREFLIGHT_IN_TURN);
});

test("renderPreflight: several commands on separate lines, never joined with &&", () => {
  const out = renderPreflight(["a", "b || true", "c"]);
  const lines = out.split("\n");
  assert.equal(lines[0], "```bash");
  assert.equal(lines[1], "set -e");
  assert.deepEqual(lines.slice(2, 5), ["a", "b || true", "c"]);
  assert.equal(lines[5], "```");
  // `a && b || true && c` keeps going after `a` fails — the whole point of one-per-line.
  assert.equal(out.includes("&&"), false);
});

test("renderPreflight: empty input fails closed", () => {
  assert.throws(() => renderPreflight([]), /at least one command/);
});

// --- sibling parity: every preflight-running site gets it, triage does not -------------------

test("every implement/review/heal/resolve site passes PREFLIGHT = renderPreflight(cfg.preflight)", () => {
  const want = renderPreflight(cfg.preflight);
  const sites = {
    "loop implementOpts": implementOpts(5),
    "loop reviewOpts": reviewOpts(5, "agent/issue-5", "5"),
    "loop healOpts": healOpts(5, "agent/issue-5", "5"),
    "loop resolveConflictsOpts": resolveConflictsOpts(5, "agent/issue-5", "5"),
    "main.ts implement": mainImplementOpts(5),
    "review.ts review": cliReviewOpts(5, "agent/issue-5", "5"),
  };
  for (const [name, opts] of Object.entries(sites)) {
    assert.equal(opts.promptArgs?.PREFLIGHT, want, `${name} must carry PREFLIGHT`);
  }
});

test("main.ts and review.ts also pass UI_VERIFICATION (their prompts reference it)", () => {
  assert.equal("UI_VERIFICATION" in (mainImplementOpts(5).promptArgs ?? {}), true);
  assert.equal("UI_VERIFICATION" in (cliReviewOpts(5, "agent/issue-5", "5").promptArgs ?? {}), true);
});

test("triageOpts does not get PREFLIGHT (it never runs preflight)", () => {
  assert.equal("PREFLIGHT" in (triageOpts().promptArgs ?? {}), false);
});

// --- prompt files ------------------------------------------------------------------------------

test("the four preflight prompts use {{PREFLIGHT}}, not the gitignored script", () => {
  for (const f of ["implement.md", "review.md", "heal.md", "resolve-conflicts.md"]) {
    const text = readFileSync(join(ROOT, ".sandcastle", f), "utf8");
    assert.equal(text.includes("{{PREFLIGHT}}"), true, `${f} must contain {{PREFLIGHT}}`);
    assert.equal(text.includes(".sandcastle/preflight.sh"), false, `${f} must not reference preflight.sh`);
  }
});

test("no .sandcastle/*.md prompt references .sandcastle/preflight.sh", () => {
  const dir = join(ROOT, ".sandcastle");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".md"))) {
    assert.equal(readFileSync(join(dir, f), "utf8").includes(".sandcastle/preflight.sh"), false, f);
  }
});
