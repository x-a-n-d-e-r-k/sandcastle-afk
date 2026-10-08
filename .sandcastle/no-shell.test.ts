// #97: text an agent writes (relayed as a comment) used to reach /bin/sh inside JSON.stringify "quotes",
// so backticks / $(...) ran on the HOST and $TOKENS were posted. These tests pin the argv-only path.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json")))
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));

const { runForge, isSafeRef, isAgentBranch, isHexSha } = await import("./config.js");
const { renderedHeads } = await import("./ui.js");

// A fake executable that records its argv (NUL-separated) — what bin/forge / gh would receive.
const recorder = (dir: string, name: string) => {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/bash\nprintf '%s\\0' "$@" > "${join(dir, "argv")}"\n`);
  chmodSync(bin, 0o755);
  return { bin, argv: () => readFileSync(join(dir, "argv"), "utf8").split("\0").slice(0, -1) };
};

// Everything a shell would act on, plus the reported case.
const hostile = (d: string) => [
  "Next step: run `touch " + d + "/bt` and then `id > " + d + "/id`.",
  "$(touch " + d + "/subst)",
  "home=$HOME token=$GH_TOKEN",
  `quotes " and ' and \\ backslash`,
  "line one\nline two",
  "; touch " + d + "/semi",
  "x --repo evil/repo *",
].join("\n");

test("runForge passes every argument verbatim — no shell, nothing executed, nothing expanded", () => {
  const d = mkdtempSync(join(tmpdir(), "afk-noshell-"));
  try {
    const r = recorder(d, "forge");
    const body = hostile(d);
    runForge(r.bin, ["issue-comment", 123, "--body", body], { ...process.env, GH_TOKEN: "SECRET-TOKEN" });
    assert.deepEqual(r.argv(), ["issue-comment", "123", "--body", body]);
    assert.deepEqual(readdirSync(d).sort(), ["argv", "forge"], "no marker file was created");
    assert.ok(!r.argv().join(" ").includes("SECRET-TOKEN"), "no env var was expanded into the body");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("bin/forge hands a comment / body to gh as ONE argument (no word-splitting or globbing)", () => {
  const d = mkdtempSync(join(tmpdir(), "afk-noshell-"));
  try {
    const gh = recorder(d, "gh");
    const env = { ...process.env, PATH: `${d}:${process.env.PATH}`, FORGE_PLATFORM: "github" };
    const text = hostile(d);
    const run = (...argv: string[]) => execFileSync(join(ROOT, "bin", "forge"), argv, { cwd: d, env, encoding: "utf8" });
    run("issue-close", "5", "--comment", text);
    assert.deepEqual(gh.argv(), ["issue", "close", "5", "--comment", text]);
    run("pr-approve", "6", "--body", text);
    assert.deepEqual(gh.argv(), ["pr", "review", "6", "--approve", "--body", text]);
    run("pr-comment", "7", "--body", text);
    assert.deepEqual(gh.argv(), ["pr", "comment", "7", "--body", text]);
    run("issue-comment", "8", "--body", text);
    assert.deepEqual(gh.argv(), ["issue", "comment", "8", "--body", text]);
    run("issue-close", "9"); // no comment: no stray empty argument
    assert.deepEqual(gh.argv(), ["issue", "close", "9"]);
    assert.deepEqual(readdirSync(d).sort(), ["argv", "gh"], "no marker file was created");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("ref guards: only plain refs, exact agent branches and hex SHAs reach host git", () => {
  for (const ok of ["main", "agent/issue-12", "release/1.2", "afk/artifacts"]) assert.ok(isSafeRef(ok), ok);
  for (const bad of ["agent/issue-1$(id)", "a`id`", "a;b", "a b", "-x", "a..b", "a|b", "a&b", "$HOME", ""]) assert.ok(!isSafeRef(bad), bad);
  assert.ok(isAgentBranch("agent/issue-7"));
  for (const bad of ["agent/issue-7$(id)", "agent/issue-7x", "agent/issue-", "xagent/issue-7"]) assert.ok(!isAgentBranch(bad), bad);
  assert.ok(isHexSha("0105db4e") && !isHexSha("$(id)") && !isHexSha("render-inputs"));
});

test("renderedHeads drops artifact dirs that aren't hex SHAs (pushed content reaches host git)", () => {
  const run = (c: string) => (c.includes("ls-tree") ? "pr-9/0105db4e\npr-9/$(touch x)\npr-9/render-inputs\npr-9/abcdef0123\n" : "");
  assert.deepEqual(renderedHeads(9, "afk/artifacts", run), ["0105db4e", "abcdef0123"]);
});

test("lint: no host shell string built with JSON.stringify, and the forge client never joins argv", () => {
  const dir = join(ROOT, ".sandcastle");
  const offenders: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const src = readFileSync(join(dir, f), "utf8");
    src.split("\n").forEach((line, i) => {
      if (/\b(sh|run|shSafe|execSync)\(`[^`]*\$\{JSON\.stringify/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], "JSON.stringify is not shell quoting — use shq() or an argv array");
  const client = readFileSync(join(dir, "forge-client.ts"), "utf8");
  assert.doesNotMatch(client, /\.join\(" "\)/);
  assert.doesNotMatch(readFileSync(join(dir, "config.ts"), "utf8"), /execSync\(`\$\{JSON\.stringify\(FORGE\)\}/);
});
