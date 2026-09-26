// `forge` is baked into the sandbox image by `afk:init` — it does not ride in on the worktree.
// Consumer repos may gitignore bin/forge (it's overlay, not their source), so a git worktree
// never contains it. Runs the real init script in a throwaway host repo. No Docker.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const LAYER = join(dirname(fileURLToPath(import.meta.url)), "..");

function initInFixture() {
  const host = mkdtempSync(join(tmpdir(), "afk-init-"));
  mkdirSync(join(host, ".sandcastle"));
  copyFileSync(join(LAYER, ".sandcastle/Dockerfile.template"), join(host, ".sandcastle/Dockerfile.template"));
  cpSync(join(LAYER, "bin"), join(host, "bin"), { recursive: true });
  cpSync(join(LAYER, "skills"), join(host, "skills"), { recursive: true });
  copyFileSync(join(LAYER, "afk.config.example.json"), join(host, "afk.config.json"));
  writeFileSync(join(host, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  // tsx resolves from the fixture cwd otherwise, which has no node_modules.
  const tsx = pathToFileURL(join(LAYER, "node_modules/tsx/dist/loader.mjs")).href;
  execFileSync(process.execPath, ["--import", tsx, join(LAYER, "scripts/init.ts")], { cwd: host, stdio: "pipe" });
  return host;
}

test("init stages bin/forge into the image build context (.sandcastle/), executable and identical", () => {
  const host = initInFixture();
  try {
    const staged = join(host, ".sandcastle/forge");
    assert.equal(readFileSync(staged, "utf8"), readFileSync(join(host, "bin/forge"), "utf8"));
    assert.ok(statSync(staged).mode & 0o111, "staged forge must be executable");
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test("rendered Dockerfile bakes forge onto PATH and no longer relies on the worktree's bin/", () => {
  const host = initInFixture();
  try {
    const df = readFileSync(join(host, ".sandcastle/Dockerfile"), "utf8");
    assert.match(df, /^COPY --chmod=755 forge \/usr\/local\/bin\/forge$/m);
    assert.doesNotMatch(df, /workspace\/bin/);
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});
