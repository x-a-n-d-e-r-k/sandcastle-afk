import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewForVerdict, countNoVerdict, noVerdictMarker, type ReviewVerdictDeps } from "./review-verdict.js";

// A fake PR: comments accumulate the loop's markers; the reviewer returns whatever signal we script.
const fakePr = (o: { head: string; signals: (string | undefined)[]; max?: number; feedbackThrows?: boolean }) => {
  let comments = "### comment by someone\nlooks good so far\n";
  const logs: string[] = [];
  const escalations: { n: number; head: string }[] = [];
  let runs = 0;
  const deps: ReviewVerdictDeps = {
    max: o.max ?? 3,
    head: () => o.head,
    review: async () => ({ completionSignal: o.signals[runs++] }),
    feedback: () => { if (o.feedbackThrows) throw new Error("glab: 502"); return comments; },
    mark: (m) => { comments += `### comment by afk-bot\n${m}\n`; },
    escalate: (n, head) => escalations.push({ n, head }),
    log: (m) => logs.push(m),
  };
  return { deps, logs, escalations, comments: () => comments, runs: () => runs };
};

test("a review that posts its verdict (completion signal) records nothing", async () => {
  const p = fakePr({ head: "aaaa1111bbbb", signals: ["<promise>COMPLETE</promise>"] });
  assert.equal(await reviewForVerdict(7, p.deps), "verdict");
  assert.equal(countNoVerdict(p.comments(), "aaaa1111bbbb"), 0);
  assert.deepEqual(p.logs, []);
});

test("no verdict: counted per head, logged distinctly, parked at the cap", async () => {
  const p = fakePr({ head: "cafe0001dead", signals: [undefined, undefined, undefined] });
  assert.equal(await reviewForVerdict(3007, p.deps), "no-verdict");
  assert.equal(await reviewForVerdict(3007, p.deps), "no-verdict");
  assert.equal(p.escalations.length, 0);
  assert.equal(await reviewForVerdict(3007, p.deps), "escalated");
  assert.deepEqual(p.escalations, [{ n: 3, head: "cafe0001dead" }]);
  assert.deepEqual(p.logs, [
    "review of #3007 ended without a verdict (1/3) — head cafe0001",
    "review of #3007 ended without a verdict (2/3) — head cafe0001",
    "review of #3007 ended without a verdict (3/3) — head cafe0001",
  ]);
  assert.equal(countNoVerdict(p.comments(), "cafe0001dead"), 3);
});

test("a new head starts a fresh count", async () => {
  const p = fakePr({ head: "old0000head0", signals: [undefined, undefined] });
  await reviewForVerdict(9, p.deps);
  await reviewForVerdict(9, p.deps);
  assert.equal(countNoVerdict(p.comments(), "old0000head0"), 2);
  assert.equal(countNoVerdict(p.comments(), "new1111head1"), 0);
  assert.equal(countNoVerdict(p.comments() + noVerdictMarker("new1111head1"), "new1111head1"), 1);
});

test("un-parked after the cap: one more review, and another no-verdict parks it again", async () => {
  const p = fakePr({ head: "beef0002f00d", signals: [undefined, undefined, undefined, undefined] });
  for (let i = 0; i < 3; i++) await reviewForVerdict(11, p.deps);
  assert.equal(p.escalations.length, 1);
  assert.equal(await reviewForVerdict(11, p.deps), "escalated"); // the human's one retry also failed
  assert.equal(p.escalations.length, 2);
});

test("unreadable comments: the in-process tally still reaches the cap (never an endless re-dispatch)", async () => {
  const p = fakePr({ head: "0bad0003c0de", signals: [undefined, undefined, undefined], feedbackThrows: true });
  assert.equal(await reviewForVerdict(12, p.deps), "no-verdict");
  assert.equal(await reviewForVerdict(12, p.deps), "no-verdict");
  assert.equal(await reviewForVerdict(12, p.deps), "escalated");
  assert.ok(p.logs.some((l) => l.includes("could not record the no-verdict review")));
});

test("a verdict clears this process's tally for that head", async () => {
  const p = fakePr({ head: "f00d0004cafe", signals: [undefined, "<promise>COMPLETE</promise>", undefined], feedbackThrows: true });
  await reviewForVerdict(13, p.deps);
  assert.equal(await reviewForVerdict(13, p.deps), "verdict");
  assert.equal(await reviewForVerdict(13, p.deps), "no-verdict");
  assert.ok(p.logs.at(-1)!.includes("(1/3)"));
});

test("an idle-timeout review (it sat waiting instead of ending its turn) counts and still throws; infra errors don't count", async () => {
  const p = fakePr({ head: "1d1e0005abcd", signals: [] });
  const idle = Object.assign(new Error("Agent idle for 600s"), { name: "(FiberFailure) AgentIdleTimeoutError" });
  const deps = (err: Error): ReviewVerdictDeps => ({
    ...p.deps,
    review: async () => { throw err; },
    isNoVerdictError: (e) => /AgentIdleTimeoutError/.test((e as Error).name),
  });
  await assert.rejects(reviewForVerdict(14, deps(idle)), /Agent idle/);
  assert.equal(countNoVerdict(p.comments(), "1d1e0005abcd"), 1);
  assert.match(p.logs.at(-1)!, /\(1\/3\).*Agent idle for 600s/);
  await assert.rejects(reviewForVerdict(14, deps(new Error("docker: daemon not running"))), /docker/);
  assert.equal(countNoVerdict(p.comments(), "1d1e0005abcd"), 1); // not counted
  await assert.rejects(reviewForVerdict(14, deps(idle)));
  await assert.rejects(reviewForVerdict(14, deps(idle)));
  assert.equal(p.escalations.length, 1); // the third idle timeout parks it
});
