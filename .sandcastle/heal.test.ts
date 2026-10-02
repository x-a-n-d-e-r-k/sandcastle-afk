// Heals: the budget counts heal ATTEMPTS, not reviews (#69), and a heal must PUSH (or rebut)
// before the PR is reviewed again (#81). Fakes only at the forge boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json")))
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));

const { healDecision, healUntilPushed, NOTHING_PUSHED_NOTE } = await import("./heal.js");
type Deps = Parameters<typeof healUntilPushed>[2];

// An in-memory PR: forge marker semantics ([forge:heal] since the last [forge:heal-reset]), a head
// SHA, rebuttal comments, and a log of what happened. `pushes` scripts each heal: true = it
// commits, "rebut" = it posts a rebuttal, false = it does nothing.
const fakePr = (pushes: (boolean | "rebut")[] = []) => {
  const pr = {
    notes: [] as string[],
    head: "b4d0c116",
    rebuttalCount: 0,
    events: [] as string[],
    healNotes: [] as string[],
    escalations: [] as { n: number; open: string }[],
    review: () => { pr.notes.push("[forge:changes-requested]"); },
    reset: () => { pr.notes.push("[forge:heal-reset]"); },
    count: () => { const i = pr.notes.lastIndexOf("[forge:heal-reset]"); return pr.notes.slice(i + 1).filter((n) => n === "[forge:heal]").length; },
  };
  let run = 0;
  const deps = (over: Partial<Deps> = {}): Deps => ({
    maxHeal: 3,
    count: pr.count,
    mark: () => { pr.notes.push("[forge:heal]"); },
    heal: async (note) => {
      pr.healNotes.push(note);
      const what = pushes[run++] ?? true;
      if (what === true) pr.head = `${pr.head}+`;
      if (what === "rebut") pr.rebuttalCount++;
    },
    head: () => pr.head,
    rebuttals: () => pr.rebuttalCount,
    afterPush: async () => { pr.events.push("re-review"); },
    afterRebuttal: async () => { pr.events.push("re-review(rebuttal)"); },
    openFinding: () => "Deleted the only test guarding the forwarded field.",
    escalate: (n, open) => { pr.escalations.push({ n, open }); },
    log: () => {},
    ...over,
  });
  return { pr, deps };
};

// --- #69: the budget counts heal attempts --------------------------------------------------

test("healDecision boundary: maxHeal-1 → heal; maxHeal → escalate", () => {
  assert.equal(healDecision(2, 3), "heal");
  assert.equal(healDecision(3, 3), "escalate");
  assert.equal(healDecision(0, 3), "heal");
});

test("5 changes-requested reviews with no heal consume ZERO budget → still heals", async () => {
  const { pr, deps } = fakePr([true]);
  for (let i = 0; i < 5; i++) pr.review();
  assert.equal(await healUntilPushed(951, "CHANGES_REQUESTED", deps()), "pushed");
  assert.deepEqual(pr.escalations, []);
});

test("each heal consumes exactly 1; escalation only after maxHeal attempts", async () => {
  const { pr, deps } = fakePr([true, true, true]);
  for (let i = 0; i < 3; i++) assert.equal(await healUntilPushed(1, "x", deps()), "pushed");
  assert.equal(pr.count(), 3);
  assert.equal(await healUntilPushed(1, "x", deps()), "escalated");
  assert.equal(pr.escalations.length, 1);
});

test("pr-heal-reset restores the full budget", async () => {
  const { pr, deps } = fakePr([true, true, true, true, true, true]);
  for (let i = 0; i < 3; i++) await healUntilPushed(1, "x", deps());
  assert.equal(await healUntilPushed(1, "x", deps()), "escalated");
  pr.reset();
  assert.equal(pr.count(), 0);
  for (let i = 0; i < 3; i++) assert.equal(await healUntilPushed(1, "x", deps()), "pushed");
});

test("mark-before-run: a heal that throws still consumed its attempt", async () => {
  const { pr, deps } = fakePr();
  await assert.rejects(healUntilPushed(1, "x", deps({ heal: async () => { throw new Error("AgentIdleTimeoutError"); } })), /AgentIdleTimeoutError/);
  assert.equal(pr.count(), 1);
});

// --- #81: a heal must push (or rebut) before a re-review --------------------------------------

test("a heal that pushes nothing NEVER triggers a re-review; it heals again with the 'nothing pushed' note", async () => {
  const { pr, deps } = fakePr([false, true]);
  assert.equal(await healUntilPushed(2722, "CHANGES_REQUESTED", deps()), "pushed");
  assert.deepEqual(pr.events, ["re-review"], "exactly one re-review, and only after the push");
  assert.equal(pr.count(), 2, "the no-op heal counted against the budget");
  assert.deepEqual(pr.healNotes, ["", NOTHING_PUSHED_NOTE], "the second heal was told its first pushed nothing");
});

test("budget exhausted with the head unchanged → escalated with the open finding, never re-reviewed", async () => {
  const { pr, deps } = fakePr([false, false, false]);
  assert.equal(await healUntilPushed(2722, "CHANGES_REQUESTED", deps()), "escalated");
  assert.deepEqual(pr.events, [], "no re-review of the unchanged commit");
  assert.equal(pr.count(), 3);
  assert.deepEqual(pr.escalations, [{ n: 3, open: "Deleted the only test guarding the forwarded field." }]);
});

test("a heal that REBUTS instead of changing code goes to a re-review that must answer it", async () => {
  const { pr, deps } = fakePr(["rebut"]);
  assert.equal(await healUntilPushed(2722, "CHANGES_REQUESTED", deps()), "rebutted");
  assert.deepEqual(pr.events, ["re-review(rebuttal)"]);
  assert.equal(pr.head, "b4d0c116", "nothing pushed");
});
