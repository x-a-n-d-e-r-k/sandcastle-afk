// Tests for the blocker-sweep closed-check (#11). The bug: `forge issue-view` omitted
// `state`, so the loop's isClosed was always false and the sweep never unblocked. These
// exercise the REAL `isIssueClosed` (not a hand-rolled mock) through selection/sweep, so
// the wiring — not just a stand-in — is covered. Run: pnpm test.
import test from "node:test";
import assert from "node:assert/strict";
import { selectUnblockableIssues, sweepBlockedIssues, isIssueClosed } from "./triage.js";

const blocked = { number: 10, body: "Blocked by #5", labels: ["blocked"] };

test("isIssueClosed: only forge's lowercased 'closed' counts as closed", () => {
  assert.equal(isIssueClosed({ state: "closed" }), true);
  assert.equal(isIssueClosed({ state: "open" }), false);
  assert.equal(isIssueClosed({ state: undefined }), false); // the bug: forge omitted state
  assert.equal(isIssueClosed({}), false);
});

test("selectUnblockableIssues selects when every blocker is closed (via real isIssueClosed)", () => {
  const detail: Record<number, { state?: string }> = { 5: { state: "closed" } };
  assert.deepEqual(selectUnblockableIssues([blocked], (n) => isIssueClosed(detail[n])), [10]);
});

test("selectUnblockableIssues holds when a blocker is still open", () => {
  const detail: Record<number, { state?: string }> = { 5: { state: "open" } };
  assert.deepEqual(selectUnblockableIssues([blocked], (n) => isIssueClosed(detail[n])), []);
});

test("regression: with forge's old shape (no `state`), nothing is selected — the dead sweep", () => {
  const detail: Record<number, { state?: string }> = { 5: {} }; // pre-fix issue-view: no state
  assert.deepEqual(selectUnblockableIssues([blocked], (n) => isIssueClosed(detail[n])), []);
});

test("sweepBlockedIssues promotes a fully-closed-blocker issue through the real check", () => {
  const detail: Record<number, { state?: string }> = { 5: { state: "closed" } };
  const promoted: number[] = [];
  const comments: Array<[number, string]> = [];
  const result = sweepBlockedIssues({
    listBlocked: () => [blocked],
    isClosed: (n) => isIssueClosed(detail[n]),
    promote: (n) => { promoted.push(n); },
    hasMarkerComment: () => false,
    comment: (n, body) => { comments.push([n, body]); },
  });
  assert.deepEqual(result, [10]);
  assert.deepEqual(promoted, [10]);
  assert.equal(comments.length, 1);
});
