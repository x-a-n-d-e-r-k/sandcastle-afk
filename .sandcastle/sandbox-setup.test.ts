// Sandbox startup ordering for setupCommands (#48). Pure — no Docker.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// config.ts (imported transitively by loop.ts) throws without afk.config.json — seed it.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json")))
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));

const { sandboxReadyHooks } = await import("./loop.js");
const cmds = (hooks: { command: string }[]) => hooks.map((h) => h.command);

test("setupCommands run AFTER install and BEFORE forge git-setup", () => {
  const hooks = sandboxReadyHooks("npm ci", ["provision-a", "provision-b"], true);
  assert.deepEqual(cmds(hooks), ["npm ci", "provision-a", "provision-b", "forge git-setup"]);
});

test("no setupCommands → sequence is unchanged (install [+ git-setup])", () => {
  assert.deepEqual(cmds(sandboxReadyHooks("npm ci", [], true)), ["npm ci", "forge git-setup"]);
  assert.deepEqual(cmds(sandboxReadyHooks("npm ci", [], false)), ["npm ci"]);
});

test("a non-pushing phase (review/triage) still runs setupCommands but not git-setup", () => {
  const hooks = sandboxReadyHooks("npm ci", ["provision"], false);
  assert.deepEqual(cmds(hooks), ["npm ci", "provision"]);
});

test("each setup command carries a timeout, like install", () => {
  const hooks = sandboxReadyHooks("npm ci", ["provision"], false);
  for (const h of hooks) assert.equal(typeof (h as { timeoutMs?: number }).timeoutMs, "number");
});

test("the example config ships setupCommands INERT (//-prefixed), so it never auto-runs", async () => {
  // Same lesson as #33's //ui-example: an armed sample seeds into consumers and the test suite
  // (which copies afk.config.example.json → afk.config.json). cfg.setupCommands must be undefined.
  const { cfg } = await import("./config.js");
  assert.equal(cfg.setupCommands, undefined);
});
