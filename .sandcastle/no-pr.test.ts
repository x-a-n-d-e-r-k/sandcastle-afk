// An implement run that ends without a PR is not re-dispatched forever (#86). Fakes only at the
// forge boundary: an in-memory issue (body, maintainer discussion, raw comments) and PR list.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json")))
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));

const np = await import("./no-pr.js");
type Deps = Parameters<typeof np.afterImplement>[1];

// The consumer's case: the agent posts the blocker and stops, cleanly, with no PR.
const fakeIssue = () => {
  const st = {
    body: "Implement X per the approved interface.",
    discussion: "(no comments)",
    comments: [] as string[],
    labels: [] as string[],
    prs: [] as string[],
    escalations: [] as { reason: string; said: string }[],
    logs: [] as string[],
  };
  const deps = (over: Partial<Deps> = {}): Deps => ({
    maxNoPrRuns: 2,
    prOpened: () => st.prs.includes("agent/issue-2732"),
    stdout: "The approved interface contradicts AC3; this needs an owner decision. Stopping.",
    fingerprint: () => np.issueFingerprint(st.body, st.discussion),
    comments: () => st.comments.join("\n"),
    mark: (m) => { st.comments.push(`${m} implement ended without opening a PR.`); },
    escalate: (reason, said) => { st.labels.push("needs-human"); st.escalations.push({ reason, said }); },
    log: (m) => { st.logs.push(m); },
    ...over,
  });
  return { st, deps };
};

test("a run that exits cleanly WITHOUT a PR does not log 'opened PR', and records a no-PR attempt", () => {
  const { st, deps } = fakeIssue();
  assert.equal(np.afterImplement(2732, deps()), "no-pr");
  assert.equal(st.logs.some((l) => /opened PR/.test(l)), false, "no false success in the log");
  assert.equal(st.comments.filter((c) => c.startsWith(np.NO_PR_MARKER)).length, 1);
  assert.deepEqual(st.labels, []);
});

test("a run that opened a PR logs success and records nothing", () => {
  const { st, deps } = fakeIssue();
  st.prs.push("agent/issue-2732");
  assert.equal(np.afterImplement(2732, deps()), "pr-opened");
  assert.ok(st.logs.some((l) => l === "opened PR for #2732"));
  assert.deepEqual(st.comments, []);
});

test("after maxNoPrRuns no-PR runs on an UNCHANGED issue → needs-human, with the agent's last words", () => {
  const { st, deps } = fakeIssue();
  assert.equal(np.afterImplement(2732, deps()), "no-pr");
  assert.equal(np.afterImplement(2732, deps()), "escalated");
  assert.deepEqual(st.labels, ["needs-human"]);
  assert.match(st.escalations[0].reason, /2 implement run\(s\) ended without opening a PR/);
  assert.match(st.escalations[0].said, /needs an owner decision/);
});

test("an owner's answer — a body edit OR a new maintainer comment — resets the count", () => {
  for (const change of ["body", "discussion"] as const) {
    const { st, deps } = fakeIssue();
    assert.equal(np.afterImplement(2732, deps()), "no-pr");
    st[change] += "\nDecision: use the interface; AC3 is dropped.";
    assert.equal(np.afterImplement(2732, deps()), "no-pr", `${change} changed → this counts as attempt 1 again`);
    assert.deepEqual(st.labels, []);
    assert.equal(np.afterImplement(2732, deps()), "escalated", "…and unchanged after that, it escalates again");
  }
});

test("an explicit [afk:no-pr-reset] comment resets the count", () => {
  const { st, deps } = fakeIssue();
  np.afterImplement(2732, deps());
  st.comments.push(np.NO_PR_RESET);
  assert.equal(np.afterImplement(2732, deps()), "no-pr");
  assert.deepEqual(st.labels, []);
});

test("<promise>BLOCKED</promise> escalates immediately, without waiting for the counter", () => {
  const { st, deps } = fakeIssue();
  const out = np.afterImplement(2732, deps({ stdout: `Posted the blocker on the issue.\n${np.BLOCKED_SIGNAL}` }));
  assert.equal(out, "escalated");
  assert.deepEqual(st.labels, ["needs-human"]);
  assert.match(st.escalations[0].reason, /BLOCKED/);
  assert.doesNotMatch(st.escalations[0].said, /<promise>/, "the signal itself is not quoted back");
});

test("the 310-run loop is gone: 300 consecutive clean no-PR runs escalate on the 2nd", () => {
  const { st, deps } = fakeIssue();
  let runs = 0;
  while (!st.labels.includes("needs-human") && runs < 300) { np.afterImplement(2732, deps()); runs++; }
  assert.equal(runs, 2);
});

test("lastWords keeps the end of a long message", () => {
  assert.equal(np.lastWords("x".repeat(5000)).length, 1501);
  assert.equal(np.lastWords("short"), "short");
});

// --- prompt + wiring ---------------------------------------------------------------------------

test("implement.md gives the agent the BLOCKED signal and tells it to post the blocker first", () => {
  const t = readFileSync(join(ROOT, ".sandcastle", "implement.md"), "utf8");
  assert.ok(t.includes(np.BLOCKED_SIGNAL));
  assert.match(t, /forge issue-comment \{\{ISSUE_NUMBER\}\} --body/);
});

test("house rules are re-read for every run (no loop restart needed after afk:rules)", async () => {
  const rulesFile = join(ROOT, ".sandcastle", "agent-rules.md");
  const had = existsSync(rulesFile) ? readFileSync(rulesFile, "utf8") : null;
  const { implementOpts } = await import("./loop.js");
  try {
    writeFileSync(rulesFile, "RULE-ONE");
    assert.match(String(implementOpts(1).promptArgs?.AGENT_RULES), /RULE-ONE/);
    writeFileSync(rulesFile, "RULE-TWO");
    assert.match(String(implementOpts(1).promptArgs?.AGENT_RULES), /RULE-TWO/, "an edit is picked up without restarting");
  } finally {
    if (had === null) rmSync(rulesFile, { force: true }); else writeFileSync(rulesFile, had);
  }
});
