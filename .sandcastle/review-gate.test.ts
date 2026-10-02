// A blocked PR must not merge on the same commit (#81): re-review sees the open findings, and a
// same-commit approval is refused at merge. No sandbox, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json")))
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));

const { priorFindingsBlock } = await import("./review-gate.js");
const { sameCommitAsBlock } = await import("./merge-guard.js");
const { reviewOpts, healOpts } = await import("./loop.js");
const { cliReviewOpts } = await import("./review.js");
const { NOTHING_PUSHED_NOTE } = await import("./heal.js");

const FINDING = "Deleted the only test guarding the forwarded field — a mutation leaves every test green.";

test("the re-review prompt carries the prior blocking finding and the per-finding rule", () => {
  const block = priorFindingsBlock(FINDING);
  assert.match(block, /Previous blocking review/);
  assert.ok(block.includes(`> ${FINDING}`), "the finding text is quoted into the prompt");
  assert.match(block, /resolved at <file:line>/);
  assert.match(block, /still open/);
  assert.match(block, /MUST request changes, not approve/);
  for (const opts of [reviewOpts(2722, "agent/issue-1", "1", block), cliReviewOpts(2722, "agent/issue-1", "1", block)]) {
    assert.ok(String(opts.promptArgs?.PRIOR_BLOCKING_FINDINGS).includes(FINDING), "both review sites pass it through");
  }
});

test("no prior blocking review → empty section; a rebuttal is shown for the reviewer to answer", () => {
  assert.equal(priorFindingsBlock(""), "");
  assert.equal(reviewOpts(1, "agent/issue-1", "1").promptArgs?.PRIOR_BLOCKING_FINDINGS, "");
  const withRebuttal = priorFindingsBlock(FINDING, "[afk:rebuttal] the field is guarded by test X — ran it, it fails under the mutation");
  assert.match(withRebuttal, /REBUTTED[\s\S]*guarded by test X/);
});

test("prompts carry the new placeholders; heal opts pass the 'nothing pushed' note", () => {
  assert.ok(readFileSync(join(ROOT, ".sandcastle", "review.md"), "utf8").includes("{{PRIOR_BLOCKING_FINDINGS}}"));
  const heal = readFileSync(join(ROOT, ".sandcastle", "heal.md"), "utf8");
  assert.ok(heal.includes("{{HEAL_NOTE}}"));
  assert.match(heal, /\[afk:rebuttal\]/, "the healer is told how to rebut instead of silently doing nothing");
  assert.equal(healOpts(1, "agent/issue-1", "1").promptArgs?.HEAL_NOTE, "");
  assert.equal(healOpts(1, "agent/issue-1", "1", NOTHING_PUSHED_NOTE).promptArgs?.HEAL_NOTE, NOTHING_PUSHED_NOTE);
});

// The #2722 timeline: one commit b4d0c116; CHANGES_REQUESTED on it; a heal pushed nothing; APPROVED on it.
const HEAD = "b4d0c116aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("merge backstop: approval on the same commit the block was made on, no rebuttal → refused", () => {
  assert.equal(sameCommitAsBlock({ head: HEAD, blockingSha: HEAD, rebuttal: "" }), true);
});

test("merge backstop: allowed after a new commit, or with a rebuttal, or with no block at all", () => {
  assert.equal(sameCommitAsBlock({ head: "c0ffee00", blockingSha: HEAD, rebuttal: "" }), false, "a fix was pushed");
  assert.equal(sameCommitAsBlock({ head: HEAD, blockingSha: HEAD, rebuttal: "[afk:rebuttal] …" }), false, "the finding was rebutted");
  assert.equal(sameCommitAsBlock({ head: HEAD, blockingSha: "", rebuttal: "" }), false, "never blocked");
});

test("GitLab parity: a changes-requested note carries no commit, so the backstop never fires (label flow unchanged)", () => {
  assert.equal(sameCommitAsBlock({ head: HEAD, blockingSha: "", rebuttal: "" }), false);
});
