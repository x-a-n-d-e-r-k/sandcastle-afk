// Heal budget counts heal ATTEMPTS, not reviews (#69). Fakes only at the forge boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json")))
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));

const { healDecision, healWithBudget } = await import("./heal.js");
type Deps = Parameters<typeof healWithBudget>[2];

// forge's marker semantics in memory: [forge:heal] markers since the last [forge:heal-reset].
// `reviews` records changes-requested reviews, which must NOT affect the budget.
const forgeFake = () => {
  const notes: string[] = [];
  return {
    notes,
    review: () => { notes.push("[forge:changes-requested]"); },
    reset: () => { notes.push("[forge:heal-reset]"); },
    count: () => { const i = notes.lastIndexOf("[forge:heal-reset]"); return notes.slice(i + 1).filter((n) => n === "[forge:heal]").length; },
    mark: () => { notes.push("[forge:heal]"); },
  };
};
const deps = (f: ReturnType<typeof forgeFake>, over: Partial<Deps> = {}): Deps & { escalations: number[] } => {
  const escalations: number[] = [];
  return { maxHeal: 3, count: f.count, mark: f.mark, heal: async () => {}, escalate: (n) => { escalations.push(n); }, log: () => {}, escalations, ...over };
};

test("healDecision boundary: maxHeal-1 → heal; maxHeal → escalate", () => {
  assert.equal(healDecision(2, 3), "heal");
  assert.equal(healDecision(3, 3), "escalate");
  assert.equal(healDecision(0, 3), "heal");
});

test("5 changes-requested reviews on an unchanged head with no heal consume ZERO budget → still 'heal'", async () => {
  const f = forgeFake();
  for (let i = 0; i < 5; i++) f.review(); // what pr-changes-count used to count (→ escalate today)
  const d = deps(f);
  assert.equal(await healWithBudget(951, "CHANGES_REQUESTED", d), "healed");
  assert.deepEqual(d.escalations, []);
});

test("each heal consumes exactly 1; escalation only after maxHeal heal attempts", async () => {
  const f = forgeFake();
  const d = deps(f);
  for (let i = 0; i < 3; i++) { f.review(); assert.equal(await healWithBudget(1, "CHANGES_REQUESTED", d), "healed"); }
  assert.equal(f.count(), 3);
  assert.equal(await healWithBudget(1, "CHANGES_REQUESTED", d), "escalated");
  assert.deepEqual(d.escalations, [3]);
});

test("pr-heal-reset restores the full budget", async () => {
  const f = forgeFake();
  const d = deps(f);
  for (let i = 0; i < 3; i++) await healWithBudget(1, "x", d);
  assert.equal(await healWithBudget(1, "x", d), "escalated");
  f.reset(); // a human un-parks it
  assert.equal(f.count(), 0);
  for (let i = 0; i < 3; i++) assert.equal(await healWithBudget(1, "x", d), "healed");
});

test("mark-before-run: a heal that throws still consumed its attempt", async () => {
  const f = forgeFake();
  const d = deps(f, { heal: async () => { throw new Error("AgentIdleTimeoutError"); } });
  await assert.rejects(healWithBudget(1, "x", d), /AgentIdleTimeoutError/);
  assert.equal(f.count(), 1, "pr-heal-mark was called before the heal ran");
});
