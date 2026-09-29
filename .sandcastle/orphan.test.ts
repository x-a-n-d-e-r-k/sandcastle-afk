// Orphan PRs (#61): a PR whose source branch doesn't exist on origin is not a merge conflict.
// No sandbox, no live forge — fakes only at the forge boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json")))
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));

const { classifyPr, handleOrphan } = await import("./loop.js");
const { ORPHAN_LABEL } = await import("./config.js");

// hasConflicts that records whether it was asked.
const conflicts = (answer: boolean) => {
  const f = () => { f.calls++; return answer; };
  f.calls = 0;
  return f;
};

test("classifyPr: head unknown ('error') → skip, and conflicts are never asked (fail closed)", () => {
  const h = conflicts(true);
  assert.equal(classifyPr("error", h), "skip");
  assert.equal(h.calls, 0);
});

test("classifyPr: missing head → orphan, even though GitLab reports it conflicting (the evidence case)", () => {
  const h = conflicts(true);
  assert.equal(classifyPr(false, h), "orphan");
  assert.equal(h.calls, 0, "an orphan must never reach the conflict check");
});

test("classifyPr: head exists → conflicted / ok by the conflict check", () => {
  assert.equal(classifyPr(true, conflicts(true)), "conflicted");
  assert.equal(classifyPr(true, conflicts(false)), "ok");
});

test("handleOrphan: labels, comments, closes and releases the claim once each — never the conflict path", () => {
  const calls: string[] = [];
  handleOrphan({ number: 953, headRef: "agent/issue-433" }, {
    comment: (b) => calls.push(`comment:${b}`),
    label: (l) => calls.push(`label:${l}`),
    close: () => calls.push("close"),
    releaseClaim: () => calls.push("release"),
    log: () => {},
  });
  assert.deepEqual(calls.map((c) => c.split(":")[0]), ["label", "comment", "close", "release"],
    "label BEFORE close: a closed orphan without the label strands its issue");
  assert.equal(calls[0], `label:${ORPHAN_LABEL}`);
  assert.match(calls[1], /source branch agent\/issue-433 does not exist on origin/);
  // The deps surface has no conflict-retry / resolve / escalate hooks at all, so the handler
  // structurally cannot take the conflict path; assert the recorded set is exactly the four.
  assert.equal(calls.length, 4);
  assert.equal(calls.some((c) => /retry|resolve|escalate|needs-human/i.test(c)), false);
});

test("the orphan label defaults to afk-orphan", () => {
  assert.equal(ORPHAN_LABEL, "afk-orphan");
});
