// One commit identity, no AI co-author trailer, on every pushing phase (#52). No Docker.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json")))
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));

const { cfg, requireGitIdentity, gitSetupCommand } = await import("./config.js");
const { implementOpts, healOpts, resolveConflictsOpts, reviewOpts, triageOpts } = await import("./loop.js");

type Hook = { readonly command: string };
const hooks = (o: { hooks?: { sandbox?: { onSandboxReady?: readonly Hook[] } } }) =>
  (o.hooks?.sandbox?.onSandboxReady ?? []).map((h) => h.command);

test("requireGitIdentity: missing / blank → throws naming gitIdentity; valid → trimmed", () => {
  assert.throws(() => requireGitIdentity(undefined), /gitIdentity/);
  assert.throws(() => requireGitIdentity({ name: "bot", email: "" }), /gitIdentity/);
  assert.throws(() => requireGitIdentity({ name: "  ", email: "a@b" }), /gitIdentity/);
  assert.deepEqual(requireGitIdentity({ name: " bot ", email: " a@b " }), { name: "bot", email: "a@b" });
});

test("implement, heal and resolve all pin the SAME configured identity; review/triage push nothing", () => {
  const want = gitSetupCommand(requireGitIdentity(cfg.gitIdentity));
  for (const [name, o] of Object.entries({
    implement: implementOpts(5),
    heal: healOpts(5, "agent/issue-5", "5"),
    resolve: resolveConflictsOpts(5, "agent/issue-5", "5"),
  })) {
    assert.equal(hooks(o).at(-1), want, `${name} must end its setup with the identity-pinning git-setup`);
  }
  for (const o of [reviewOpts(5, "agent/issue-5", "5"), triageOpts()])
    assert.equal(hooks(o).some((c) => c.includes("git-setup")), false);
});

test("gitSetupCommand survives the shell: a quote in the name lands verbatim as the commit author", () => {
  // Run the exact hook string through `sh -c`, as upstream does in the container, then commit.
  const tmp = mkdtempSync(join(tmpdir(), "afk-ident-"));
  try {
    mkdirSync(join(tmp, "bin")); mkdirSync(join(tmp, "home"));
    writeFileSync(join(tmp, "bin", "gh"), "#!/usr/bin/env bash\nexit 0\n"); chmodSync(join(tmp, "bin", "gh"), 0o755);
    const env = {
      ...process.env, HOME: join(tmp, "home"), GIT_CONFIG_NOSYSTEM: "1", FORGE_PLATFORM: "github",
      PATH: `${join(tmp, "bin")}:${join(ROOT, "bin")}:${process.env.PATH}`,
    };
    const run = (c: string, cwd = tmp) => execSync(c, { env, cwd, encoding: "utf8" }).trim();
    execFileSync("sh", ["-c", gitSetupCommand({ name: "O'Brien $(bot)", email: "ob@bot.example" })], { env, cwd: tmp });
    run("git init -q repo && echo x > repo/f && git -C repo add f && git -C repo commit -q -m wip");
    assert.equal(run("git -C repo log -1 --format='%an <%ae>'"), "O'Brien $(bot) <ob@bot.example>");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the sandbox image disables Claude Code's co-author attribution for every phase", () => {
  const tpl = readFileSync(join(ROOT, ".sandcastle", "Dockerfile.template"), "utf8");
  const m = tpl.match(/echo '(\{.*\})' > \/home\/agent\/\.claude\/settings\.json/);
  assert.ok(m, "Dockerfile.template must write /home/agent/.claude/settings.json");
  const settings = JSON.parse(m[1]);
  assert.equal(settings.includeCoAuthoredBy, false);
  assert.equal(settings.attribution?.commit, "");
  assert.equal(settings.attribution?.pr, "");
  // Written AFTER the agent user switch, so it lands in the agent's own home, owned by it.
  assert.ok(tpl.indexOf("settings.json") > tpl.indexOf("USER ${AGENT_UID}"), "must be written as the agent user");
});
