// The config contract (#77): afk:update must say when the layer it installs needs config the
// consumer lacks. Driven by the layer's REAL validators (CONFIG_CONTRACT), not a hard-coded key list.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { CONFIG_CONTRACT, checkConfig, assertConfigContract, formatContractReport, updateExitCode } from "./config-contract.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = JSON.parse(readFileSync(join(ROOT, "afk.config.example.json"), "utf8"));
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const without = (key: string) => { const c = structuredClone(EXAMPLE); delete c[key]; return c; };

test("the shipped example satisfies the contract (it documents every required key)", () => {
  assert.deepEqual(checkConfig(EXAMPLE, EXAMPLE), []);
});

test("every contract key, when missing, is reported with its validator message and the example value", () => {
  assert.ok(CONFIG_CONTRACT.length >= 2, "maxResume and gitIdentity at least");
  for (const { key } of CONFIG_CONTRACT) {
    const v = checkConfig(without(key), EXAMPLE);
    assert.equal(v.length, 1, key);
    assert.equal(v[0].key, key);
    assert.match(v[0].message, new RegExp(key));
    assert.deepEqual(v[0].example, EXAMPLE[key], `${key}: the example value comes from afk.config.example.json`);
  }
});

test("invalid values are reported too; ALL violations at once", () => {
  const bad = { ...EXAMPLE, maxResume: -1, gitIdentity: { name: "", email: "x@y" } };
  assert.deepEqual(checkConfig(bad).map((v) => v.key).sort(), ["gitIdentity", "maxResume"]);
  assert.throws(() => assertConfigContract(bad), /maxResume[\s\S]*gitIdentity|gitIdentity[\s\S]*maxResume/);
  assert.doesNotThrow(() => assertConfigContract(EXAMPLE));
});

test("report + exit code: dry-run reports and exits 0; apply exits 1 unless --force; valid → no block, 0", () => {
  const v = checkConfig(without("maxResume"), EXAMPLE);
  assert.match(formatContractReport(v, "dry-run"), /config changes required[\s\S]*maxResume[\s\S]*"maxResume": 2/);
  assert.match(formatContractReport(v, "apply"), /CONFIG ACTION REQUIRED before `afk:loop`/);
  assert.equal(updateExitCode(v, { dry: true, force: false }), 0);
  assert.equal(updateExitCode(v, { dry: false, force: false }), 1);
  assert.equal(updateExitCode(v, { dry: false, force: true }), 0);
  assert.equal(formatContractReport([], "apply"), "");
  assert.equal(updateExitCode([], { dry: false, force: false }), 0);
});

// --- end to end: afk:update against a throwaway consumer, with THIS checkout as the layer ------

const loopRunning = () => { try { execSync("pgrep -f loop.ts", { stdio: "ignore" }); return true; } catch { return false; } };

function consumer(cfg: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "afk-consumer-"));
  const g = (c: string) => execSync(`git -c user.name=t -c user.email=t@t -c init.defaultBranch=main ${c}`, { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  writeFileSync(join(dir, "afk.config.json"), JSON.stringify(cfg, null, 2));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "c", private: true, scripts: {} }, null, 2));
  writeFileSync(join(dir, "afk.config.example.json"), "{\"stale\": true}\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules")); // tsx etc., no network
  g("init -q"); g("add -A"); g("commit -q -m init");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const update = (cwd: string, ...args: string[]) =>
  spawnSync(TSX, [join(ROOT, "scripts", "update.ts"), "--from", ROOT, ...args], { cwd, encoding: "utf8" });

test("afk:update --dry-run names the missing key, the validator message and the example value", () => {
  const c = consumer(without("maxResume"));
  try {
    const r = update(c.dir, "--dry-run", "--force"); // --force only skips the loop-running check here
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, out);
    assert.match(out, /config changes required/);
    assert.match(out, /maxResume: afk\.config\.json needs `maxResume`/);
    assert.match(out, /"maxResume": 2/);
    assert.match(out, /~ afk\.config\.example\.json/, "the stale example is listed to be synced");
  } finally { c.cleanup(); }
});

test("afk:update --dry-run with a valid config: no config block, says it satisfies the contract", () => {
  const c = consumer(EXAMPLE);
  try {
    const r = update(c.dir, "--dry-run", "--force");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /config changes required|CONFIG ACTION REQUIRED/);
    assert.match(r.stdout, /satisfies this layer's contract/);
  } finally { c.cleanup(); }
});

test("afk:update (apply) with a missing key: files installed, example synced, loud block, NON-ZERO exit", { skip: loopRunning() && "a loop.ts process is running on this host (update refuses without --force)" }, () => {
  const c = consumer(without("gitIdentity"));
  try {
    const r = update(c.dir);
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 1, out);
    assert.match(out, /CONFIG ACTION REQUIRED before `afk:loop`[\s\S]*gitIdentity/);
    assert.ok(existsSync(join(c.dir, ".sandcastle", "loop.ts")), "the layer files were still copied");
    assert.equal(readFileSync(join(c.dir, "afk.config.example.json"), "utf8"), readFileSync(join(ROOT, "afk.config.example.json"), "utf8"), "example synced");
  } finally { c.cleanup(); }
});

test("afk:update (apply) --force with a missing key: same block, exit 0", () => {
  const c = consumer(without("gitIdentity"));
  try {
    const r = update(c.dir, "--force");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /CONFIG ACTION REQUIRED/);
  } finally { c.cleanup(); }
});

test("the CLI is what update runs: JSON with violations, report and exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-cli-"));
  try {
    writeFileSync(join(dir, "c.json"), JSON.stringify(without("maxResume")));
    const out = JSON.parse(execFileSync(TSX, [join(ROOT, ".sandcastle", "config-contract.ts"), "--check", "apply", "0", join(dir, "c.json"), join(ROOT, "afk.config.example.json")], { encoding: "utf8" }));
    assert.deepEqual(out.violations.map((v: { key: string }) => v.key), ["maxResume"]);
    assert.equal(out.exitCode, 1);
    assert.match(out.report, /CONFIG ACTION REQUIRED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- review follow-ups ----------------------------------------------------------------------

test("BLOCKER fix: the check still runs when the layer path goes through a SYMLINK (macOS tmpdir is /var → /private/var)", () => {
  const c = consumer(without("maxResume"));
  const link = join(mkdtempSync(join(tmpdir(), "afk-link-")), "layer");
  try {
    symlinkSync(ROOT, link);
    const r = spawnSync(TSX, [join(ROOT, "scripts", "update.ts"), "--from", link, "--dry-run", "--force"], { cwd: c.dir, encoding: "utf8" });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, out);
    assert.doesNotMatch(out, /Could not run|could not run/);
    assert.match(out, /maxResume: afk\.config\.json needs `maxResume`/);
  } finally { c.cleanup(); rmSync(dirname(link), { recursive: true, force: true }); }
});

test("a check that can't run is a FAILURE, not a pass: reported in dry-run, exit 1 on apply", () => {
  // A minimal layer whose contract file throws on load.
  const layer = mkdtempSync(join(tmpdir(), "afk-badlayer-"));
  const g = (c: string) => execSync(`git -c user.name=t -c user.email=t@t ${c}`, { cwd: layer, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  execSync(`mkdir -p .sandcastle`, { cwd: layer });
  writeFileSync(join(layer, ".sandcastle", "package.json"), '{"type":"module"}');
  writeFileSync(join(layer, ".sandcastle", "config-contract.ts"), 'throw new Error("contract module is broken");\n');
  writeFileSync(join(layer, "package.json"), JSON.stringify({ name: "layer", scripts: {}, dependencies: {} }));
  writeFileSync(join(layer, "afk.config.example.json"), "{}");
  g("init -q"); g("add -A"); g("commit -q -m layer");
  const c = consumer(EXAMPLE);
  try {
    const dry = spawnSync(TSX, [join(ROOT, "scripts", "update.ts"), "--from", layer, "--dry-run", "--force"], { cwd: c.dir, encoding: "utf8" });
    assert.equal(dry.status, 0);
    assert.match(dry.stdout + dry.stderr, /config changes required[\s\S]*could not run the layer's config-contract check/);
    if (!loopRunning()) {
      const apply = spawnSync(TSX, [join(ROOT, "scripts", "update.ts"), "--from", layer], { cwd: c.dir, encoding: "utf8" });
      assert.equal(apply.status, 1, apply.stdout + apply.stderr);
      assert.match(apply.stdout + apply.stderr, /CONFIG ACTION REQUIRED/);
    }
  } finally { c.cleanup(); rmSync(layer, { recursive: true, force: true }); }
});

test("config.ts reports EVERY missing required key at load, not just the first", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-cfgload-"));
  try {
    execSync("mkdir -p .sandcastle", { cwd: dir });
    for (const f of ["config.ts", "config-contract.ts"]) writeFileSync(join(dir, ".sandcastle", f), readFileSync(join(ROOT, ".sandcastle", f)));
    writeFileSync(join(dir, ".sandcastle", "package.json"), '{"type":"module"}');
    const cfg = structuredClone(EXAMPLE); delete cfg.maxResume; delete cfg.gitIdentity;
    writeFileSync(join(dir, "afk.config.json"), JSON.stringify(cfg));
    const r = spawnSync(TSX, [join(dir, ".sandcastle", "config.ts")], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /maxResume/);
    assert.match(r.stderr, /gitIdentity/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
