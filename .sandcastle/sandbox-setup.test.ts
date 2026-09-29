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
const ID = { name: "dev-bot", email: "dev@bot.test" };
const GIT_SETUP = "forge git-setup --git-name 'dev-bot' --git-email 'dev@bot.test'";

test("setupCommands run AFTER install and BEFORE forge git-setup", () => {
  const hooks = sandboxReadyHooks("npm ci", ["provision-a", "provision-b"], ID);
  assert.deepEqual(cmds(hooks), ["npm ci", "provision-a", "provision-b", GIT_SETUP]);
});

test("no setupCommands → sequence is unchanged (install [+ git-setup])", () => {
  assert.deepEqual(cmds(sandboxReadyHooks("npm ci", [], ID)), ["npm ci", GIT_SETUP]);
  assert.deepEqual(cmds(sandboxReadyHooks("npm ci", [], null)), ["npm ci"]);
});

test("a non-pushing phase (review/triage) still runs setupCommands but not git-setup", () => {
  const hooks = sandboxReadyHooks("npm ci", ["provision"], null);
  assert.deepEqual(cmds(hooks), ["npm ci", "provision"]);
});

test("each setup command carries a timeout, like install", () => {
  const hooks = sandboxReadyHooks("npm ci", ["provision"], null);
  for (const h of hooks) assert.equal(typeof (h as { timeoutMs?: number }).timeoutMs, "number");
});

test("the example config ships setupCommands INERT (//-prefixed), so it never auto-runs", async () => {
  // Same lesson as #33's //ui-example: an armed sample seeds into consumers and the test suite
  // (which copies afk.config.example.json → afk.config.json). cfg.setupCommands must be undefined.
  const { cfg } = await import("./config.js");
  assert.equal(cfg.setupCommands, undefined);
});
