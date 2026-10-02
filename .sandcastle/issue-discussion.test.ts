// Every phase that implements or judges an issue sees its comments, not just its body.
// The prompt's `!`cmd`` line is extracted with sandcastle's own pattern and run through `sh -c`
// (as sandcastle's docker provider does) against a stub forge: working → the discussion; failing →
// a VISIBLE fallback with exit 0, so one flaky comment fetch never kills a whole run.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHELL_BLOCK = /!`([^`]+)`/g; // @ai-hero/sandcastle's MARKED_SHELL_BLOCK_PATTERN
const PROMPTS = ["implement.md", "heal.md", "review.md", "resolve-conflicts.md"];

const discussionCmd = (prompt: string): string | undefined =>
  [...readFileSync(join(ROOT, ".sandcastle", prompt), "utf8").matchAll(SHELL_BLOCK)]
    .map((m) => m[1]).find((c) => c.includes("issue-discussion"));

test("every implement/heal/review/resolve prompt injects the issue's discussion after its body", () => {
  for (const p of PROMPTS) {
    const text = readFileSync(join(ROOT, ".sandcastle", p), "utf8");
    const cmd = discussionCmd(p);
    assert.ok(cmd, `${p} must run forge issue-discussion`);
    assert.ok(cmd!.startsWith("forge issue-discussion {{ISSUE_NUMBER}}"), p);
    assert.ok(text.indexOf("forge issue-view {{ISSUE_NUMBER}}") < text.indexOf("forge issue-discussion"), `${p}: body first, then comments`);
    assert.match(text, /later comment conflicts with the body, follow the comment/, p);
  }
});

test("the prompt command, run through sh -c: forge works → discussion; forge fails → visible fallback, exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-disc-"));
  try {
    const forge = join(dir, "forge");
    const run = (stub: string) => {
      writeFileSync(forge, stub); chmodSync(forge, 0o755);
      return execFileSync("sh", ["-c", discussionCmd("implement.md")!.replace(/\{\{ISSUE_NUMBER\}\}/g, "42")],
        { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
    };
    assert.equal(run("#!/bin/sh\necho '### Comment by @alice on 2026-10-01'\n").trim(), "### Comment by @alice on 2026-10-01");
    const out = run("#!/bin/sh\necho boom >&2; exit 1\n");
    assert.match(out, /Could not load the issue's comments/, "a failed fetch is visible in the prompt, not silent");
    assert.match(out, /forge issue-discussion 42/, "and tells the agent how to fetch them itself");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("triage reads the discussion but checks its idempotency marker on the RAW comments", () => {
  const t = readFileSync(join(ROOT, ".sandcastle", "triage.md"), "utf8");
  assert.match(t, /forge issue-discussion <N>/);
  assert.match(t, /\[afk-triage\][^\n]*\n[^\n]*forge issue-comments <N>/, "marker check must use the raw comments (discussion hides markers)");
});
