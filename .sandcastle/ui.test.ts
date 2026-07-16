// Pure unit tests for the #19 visual-verification gate — no sandbox, no browser, no live git.
// Run: pnpm test  (node's built-in test runner via tsx).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { UiCfg } from "./ui.js";

// config.ts (imported transitively by ui.ts) throws without afk.config.json, which is
// per-project + gitignored. Seed it from the example so the logic imports in a fresh clone.
// Static value-imports would run before this, so ui.js is imported dynamically below.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json"))) {
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));
}

const {
  globToRegExp, matchesAnyGlob, uiFilesTouched, changedFiles, artifactsFor,
  uiGate, implementUiBlock, reviewUiBlock, artifactBranch, DEFAULT_ARTIFACT_BRANCH,
} = await import("./ui.js");

const UI: UiCfg = {
  verifyGlobs: ["apps/web/**/*.{tsx,css}", "**/tokens.css"],
  renderCmd: "pnpm afk:render",
  artifactDir: ".afk/screenshots",
};

// --- glob translation -------------------------------------------------------

test("globToRegExp: ** spans zero or more segments", () => {
  const re = globToRegExp("apps/web/**/*.tsx");
  assert.ok(re.test("apps/web/App.tsx"), "zero intermediate segments must match");
  assert.ok(re.test("apps/web/a/b/C.tsx"), "many intermediate segments must match");
  assert.ok(!re.test("apps/api/App.tsx"));
});

test("globToRegExp: leading **/ matches at any depth including root", () => {
  const re = globToRegExp("**/tokens.css");
  assert.ok(re.test("tokens.css"));
  assert.ok(re.test("packages/ui/tokens.css"));
  assert.ok(!re.test("tokens.scss"));
});

test("globToRegExp: * does not cross a separator", () => {
  const re = globToRegExp("apps/*/main.ts");
  assert.ok(re.test("apps/web/main.ts"));
  assert.ok(!re.test("apps/web/nested/main.ts"), "* must not span '/'");
});

test("globToRegExp: brace alternation", () => {
  const re = globToRegExp("a/*.{tsx,css}");
  assert.ok(re.test("a/x.tsx"));
  assert.ok(re.test("a/x.css"));
  assert.ok(!re.test("a/x.ts"));
});

test("globToRegExp: dots are literal, not wildcards", () => {
  // A naive implementation leaks regex '.' and matches 'tokensXcss'.
  const re = globToRegExp("tokens.css");
  assert.ok(re.test("tokens.css"));
  assert.ok(!re.test("tokensXcss"));
});

test("globToRegExp: anchored at both ends", () => {
  const re = globToRegExp("a/b.tsx");
  assert.ok(!re.test("z/a/b.tsx"), "must not match as a suffix");
  assert.ok(!re.test("a/b.tsx.bak"), "must not match as a prefix");
});

test("globToRegExp: ? matches exactly one non-separator char", () => {
  const re = globToRegExp("a/?.ts");
  assert.ok(re.test("a/x.ts"));
  assert.ok(!re.test("a/xy.ts"));
  assert.ok(!re.test("a//.ts"));
});

test("globToRegExp: an unbalanced brace is literal, not a throw", () => {
  const re = globToRegExp("a/{oops.ts");
  assert.ok(re.test("a/{oops.ts"));
});

// --- detection --------------------------------------------------------------

test("uiFilesTouched returns only the matching subset", () => {
  const changed = ["apps/web/App.tsx", "server/api.ts", "packages/ui/tokens.css", "README.md"];
  assert.deepEqual(uiFilesTouched(changed, UI.verifyGlobs), ["apps/web/App.tsx", "packages/ui/tokens.css"]);
});

test("uiFilesTouched is empty for a purely backend change", () => {
  assert.deepEqual(uiFilesTouched(["server/api.ts", "README.md"], UI.verifyGlobs), []);
});

test("matchesAnyGlob is false against an empty glob list", () => {
  assert.equal(matchesAnyGlob("apps/web/App.tsx", []), false);
});

test("changedFiles uses a three-dot diff and drops blank lines", () => {
  let seen = "";
  const out = changedFiles("main", "agent/issue-1", (c) => { seen = c; return "a.tsx\n\nb.css\n"; });
  assert.equal(seen, "git diff --name-only origin/main...origin/agent/issue-1");
  assert.deepEqual(out, ["a.tsx", "b.css"]);
});

// --- artifact lookup --------------------------------------------------------

test("artifactsFor lists files under the PR prefix", () => {
  const cmds: string[] = [];
  const out = artifactsFor(42, DEFAULT_ARTIFACT_BRANCH, (c) => {
    cmds.push(c);
    return c.startsWith("git ls-tree") ? "pr-42/desktop-light.png\npr-42/mobile-dark.png\n" : "";
  });
  assert.deepEqual(out, ["pr-42/desktop-light.png", "pr-42/mobile-dark.png"]);
  assert.ok(cmds[0].includes("+refs/heads/afk/artifacts:refs/remotes/origin/afk/artifacts"),
    "must fetch an explicit refspec so the tracking ref exists (#26)");
  assert.ok(cmds[1].includes('-- "pr-42/"'), "must scope ls-tree to this PR's prefix");
});

test("artifactsFor returns [] when the artifact branch does not exist", () => {
  const out = artifactsFor(42, DEFAULT_ARTIFACT_BRANCH, (c) => {
    if (c.startsWith("git fetch")) throw new Error("couldn't find remote ref");
    return "should-not-get-here";
  });
  assert.deepEqual(out, []);
});

test("artifactsFor does not leak another PR's artifacts", () => {
  // ls-tree is prefix-scoped, but guard the wiring: an empty result must stay empty.
  assert.deepEqual(artifactsFor(7, DEFAULT_ARTIFACT_BRANCH, () => ""), []);
});

test("artifactBranch honours an override", () => {
  assert.equal(artifactBranch(UI), "afk/artifacts");
  assert.equal(artifactBranch({ ...UI, artifactBranch: "ci/shots" }), "ci/shots");
});

// --- the gate (the only structural part) ------------------------------------

const gate = (opts: { ui?: UiCfg; changed: string[]; artifacts: string[] }) =>
  uiGate(42, "agent/issue-1", opts.ui, {
    changed: () => opts.changed,
    artifacts: () => opts.artifacts,
  });

test("gate: not required when the consumer has no ui config", () => {
  assert.deepEqual(gate({ ui: undefined, changed: ["apps/web/App.tsx"], artifacts: [] }), { required: false });
});

test("gate: not required when ui.verifyGlobs is empty", () => {
  assert.deepEqual(gate({ ui: { ...UI, verifyGlobs: [] }, changed: ["apps/web/App.tsx"], artifacts: [] }), { required: false });
});

test("gate: not required for a non-UI diff, even with no artifacts", () => {
  assert.deepEqual(gate({ ui: UI, changed: ["server/api.ts"], artifacts: [] }), { required: false });
});

test("gate: BLOCKS a UI diff with no published artifacts", () => {
  // The bug in #19: this is the case that used to merge green.
  const g = gate({ ui: UI, changed: ["apps/web/App.tsx", "server/api.ts"], artifacts: [] });
  assert.equal(g.required, true);
  assert.equal(g.required && g.blocked, true);
  assert.deepEqual(g.required && g.files, ["apps/web/App.tsx"]);
  assert.match(g.required && g.blocked ? g.reason : "", /published no screenshots/);
});

test("gate: PASSES a UI diff that published artifacts", () => {
  const g = gate({ ui: UI, changed: ["apps/web/App.tsx"], artifacts: ["pr-42/desktop-light.png"] });
  assert.equal(g.required, true);
  assert.equal(g.required && g.blocked, false);
});

test("gate: FAILS CLOSED when the diff can't be computed — never throws", () => {
  // changedFiles uses execSync, which throws on a missing ref. On the pre-merge (APPROVED)
  // path a throw would propagate to the cycle catch and livelock (#18). uiGate must turn that
  // into an escalatable block, not an exception.
  let g: ReturnType<typeof uiGate>;
  assert.doesNotThrow(() => {
    g = uiGate(42, "agent/issue-gone", UI, {
      changed: () => { throw new Error("fatal: ambiguous argument 'origin/main...origin/agent/issue-gone'"); },
      artifacts: () => [],
    });
  });
  assert.equal(g!.required, true);
  assert.equal(g!.required && g!.blocked, true);
  assert.match(g!.required && g!.blocked ? g!.reason : "", /failing closed/i);
});

// --- injected prompt blocks -------------------------------------------------

test("implementUiBlock is empty when ui is unconfigured (non-UI repos unaffected)", () => {
  assert.equal(implementUiBlock(undefined), "");
  assert.equal(implementUiBlock({ ...UI, verifyGlobs: [] }), "");
});

test("implementUiBlock names the globs, the render command and the artifact dir", () => {
  const b = implementUiBlock(UI);
  assert.match(b, /pnpm afk:render/);
  assert.match(b, /\.afk\/screenshots/);
  assert.match(b, /apps\/web/);
  assert.match(b, /narrow \(mobile\) width/i);
  assert.match(b, /dark and light/i);
});

test("implementUiBlock's publish recipe never touches the agent's own branch", () => {
  const b = implementUiBlock(UI);
  assert.match(b, /git clone -q --depth 1/, "must publish from a separate clone");
  assert.ok(!/git checkout -q --orphan \S+\n(?![\s\S]*mktemp)/.test(b));
  assert.ok(!b.includes("rm -rf ./*"), "must never wipe the working tree");
});

test("implementUiBlock mentions canonDir only when configured", () => {
  assert.ok(!implementUiBlock(UI).includes("canonical mockups"));
  assert.match(implementUiBlock({ ...UI, canonDir: "docs/canon" }), /docs\/canon/);
});

test("reviewUiBlock is empty when the gate is not required", () => {
  assert.equal(reviewUiBlock({ required: false }, UI), "");
});

test("reviewUiBlock tells the reviewer to reject when artifacts are missing", () => {
  const g = gate({ ui: UI, changed: ["apps/web/App.tsx"], artifacts: [] });
  const b = reviewUiBlock(g, UI);
  assert.match(b, /No screenshots were published/);
  assert.match(b, /request changes/i);
});

test("reviewUiBlock lists the published screenshots when present", () => {
  const g = gate({ ui: UI, changed: ["apps/web/App.tsx"], artifacts: ["pr-42/desktop-light.png"] });
  const b = reviewUiBlock(g, UI);
  assert.match(b, /pr-42\/desktop-light\.png/);
  assert.ok(!b.includes("No screenshots were published"));
});

test("both blocks carry the standing UI checklist", () => {
  const g = gate({ ui: UI, changed: ["apps/web/App.tsx"], artifacts: ["pr-42/a.png"] });
  for (const b of [implementUiBlock(UI), reviewUiBlock(g, UI)]) {
    assert.match(b, /scroll horizontally/);
    assert.match(b, /render BLANK on edit/);
  }
});
