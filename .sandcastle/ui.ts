import { cfg, sh, shq, isHexSha, type UiVerifyCfg } from "./config.js";

// Visual verification for UI-touching PRs (#19).
//
// Green lint/test/typecheck don't prove a UI change renders. The loop merged front-end PRs
// that were visibly broken on first paint because neither the implement nor the review phase
// ever rendered them.
//
// Division of labour, chosen deliberately:
//   - The layer never knows HOW to render. It cannot boot an arbitrary consumer's app, and
//     baking a browser into Dockerfile.template would tax every non-UI consumer. The consumer
//     supplies `ui.renderCmd`; their base image owns having a browser. (The host may REPLAY that
//     command in the consumer's image when only the head moved — see rerender.ts, #67.)
//   - The AGENT publishes. There is no post-run hook in @ai-hero/sandcastle (`onSandboxReady`
//     is the only one) and RunResult exposes no worktree path, so the host cannot retrieve
//     uncommitted files after a run. The agent pushes screenshots to an orphan artifact branch
//     using the git credentials it already has from `forge git-setup`.
//   - The HOST enforces. `uiGate()` is consulted before merge and is the only structural part:
//     a UI-touching PR with no published artifacts does not merge. The prompts advise; this
//     gate is what makes the step non-optional — the same lesson as #23.
//
// The gate proves an artifact EXISTS, not that it is a faithful render. It closes the silence
// case (nobody looked), which is the reported bug. It does not stop a determined agent from
// publishing a junk PNG.

/**
 * Shape (declared in config.ts so `Cfg` owns it):
 *   verifyGlobs    — globs whose match marks a PR UI-touching, e.g. "apps/web/**\/*.{tsx,css}"
 *   renderCmd      — consumer-supplied; renders the app and writes images into artifactDir
 *   artifactDir    — where renderCmd writes, relative to the repo root
 *   artifactBranch — orphan branch the agent pushes to; never merged (default: afk/artifacts)
 *   canonDir       — optional dir of canonical mockups to compare against
 */
export type UiCfg = UiVerifyCfg;

export const DEFAULT_ARTIFACT_BRANCH = "afk/artifacts";
export const artifactBranch = (ui: UiCfg): string => ui.artifactBranch ?? DEFAULT_ARTIFACT_BRANCH;
/**
 * Artifacts for a PR live under this prefix on the orphan branch, keyed by the PR's HEAD SHA
 * (#35). Keying by PR number alone let a heal that rewrote the UI keep satisfying the gate on
 * screenshots of the pre-heal code — a green gate with a render nobody re-did. The SHA makes
 * freshness structural: a heal pushes a new tip, the prefix changes, stale artifacts no longer
 * count.
 */
export const artifactPrefix = (pr: number, headSha: string): string => `pr-${pr}/${headSha}/`;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Translate a glob fragment to a regex fragment. Recursive: each brace alternative is run
// through the same translator, so `*`, `**`, and `?` behave inside `{...}` exactly as outside
// (`{*.ts,*.js}` works). `*`/`?` never cross `/`; `**/` spans zero or more whole segments.
const translateGlob = (glob: string): string => {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") { re += "(?:[^/]*/)*"; i += 3; continue; }
        re += ".*"; i += 2; continue;
      }
      re += "[^/]*"; i += 1; continue;
    }
    if (c === "?") { re += "[^/]"; i += 1; continue; }
    if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end !== -1) {
        // Split on top-level commas and translate each alternative. Nested braces are NOT
        // supported (indexOf finds the first `}`, so `{a,{b,c}}` parses oddly-but-deterministically);
        // config globs don't nest, and the behavior is pinned by a test rather than left to chance.
        const alts = glob.slice(i + 1, end).split(",").map(translateGlob);
        re += `(?:${alts.join("|")})`;
        i = end + 1; continue;
      }
      // Unbalanced brace: treat as a literal rather than throwing on a typo'd config.
    }
    re += escapeRe(c); i += 1;
  }
  return re;
};

/**
 * Translate a glob to an anchored RegExp.
 *
 * Supported: `**` (crosses separators), `*` (within a segment), `?` (one non-separator char),
 * and `{a,b}` alternation whose alternatives may themselves contain `*`/`**`/`?`. A
 * trailing-slash `**\/` matches ZERO or more segments, so `apps/web/**\/*.tsx` matches
 * `apps/web/App.tsx` as well as `apps/web/a/b/C.tsx`. Nested brace groups are not supported.
 */
export const globToRegExp = (glob: string): RegExp => new RegExp(`^${translateGlob(glob)}$`);

export const matchesAnyGlob = (file: string, globs: string[]): boolean =>
  globs.some((g) => globToRegExp(g).test(file));

/** The subset of `changed` that matches `globs`. Empty => the PR is not UI-touching. */
export const uiFilesTouched = (changed: string[], globs: string[]): string[] =>
  changed.filter((f) => matchesAnyGlob(f, globs));

/** Files changed between two branches, via the merge-base (three-dot), host-side. */
export const changedFiles = (base: string, head: string, run: (c: string) => string = sh): string[] => {
  const out = run(`git diff --name-only origin/${base}...origin/${head}`);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
};

/** The PR branch's current tip SHA, read host-side. Injectable for testing. */
export const headShaOf = (branch: string, run: (c: string) => string = sh): string =>
  run(`git rev-parse origin/${branch}`).trim();

/** Artifact paths published for a PR at a specific head SHA, or [] if none exist there. */
export const artifactsFor = (
  pr: number,
  headSha: string,
  branch: string = DEFAULT_ARTIFACT_BRANCH,
  run: (c: string) => string = sh,
): string[] => {
  try {
    // Explicit refspec: a bare `git fetch origin <branch>` only updates the tracking ref when
    // the clone's configured refspec happens to cover it (see #26).
    run(`git fetch -q origin "+refs/heads/${branch}:refs/remotes/origin/${branch}"`);
  } catch {
    return []; // branch doesn't exist yet => nothing published
  }
  try {
    // Scoped to pr-<n>/<sha>/ — a sibling SHA's dir under the same PR does not match.
    const out = run(`git ls-tree -r --name-only origin/${branch} -- "${artifactPrefix(pr, headSha)}"`);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
};

/** Where a PR's render inputs (#67) live on the artifact branch — one copy per PR, latest wins. */
export const renderInputsPrefix = (pr: number): string => `pr-${pr}/render-inputs/`;

/** Head SHAs this PR has published screenshots for (the `pr-<n>/<sha>/` dirs), newest unknown. */
export const renderedHeads = (pr: number, branch: string = DEFAULT_ARTIFACT_BRANCH, run: (c: string) => string = sh): string[] => {
  try { run(`git fetch -q origin "+refs/heads/${branch}:refs/remotes/origin/${branch}"`); } catch { return []; }
  try {
    return run(`git ls-tree -d --name-only origin/${branch} -- "pr-${pr}/"`)
      // Only hex SHAs: these dir names are pushed content, and they reach host `git` (#97).
      .split("\n").map((s) => s.trim().slice(`pr-${pr}/`.length)).filter((s) => isHexSha(s));
  } catch { return []; }
};

/** Files persisted under the PR's render-inputs prefix, or [] (assumes the branch was fetched). */
export const persistedRenderInputs = (pr: number, branch: string = DEFAULT_ARTIFACT_BRANCH, run: (c: string) => string = sh): string[] => {
  try {
    return run(`git ls-tree -r --name-only origin/${branch} -- "${renderInputsPrefix(pr)}"`)
      .split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
};

/**
 * UI-relevant files that differ between two commits: the verifyGlobs matches, plus anything under
 * canonDir (the reviewer compares the render against it). Two-dot, NOT the PR's own diff: a base
 * merge that changed shared UI makes an earlier render stale too. Throws if a commit isn't present.
 */
export const uiChangedBetween = (a: string, b: string, ui: UiCfg, run: (c: string) => string = sh): string[] => {
  const changed = run(`git diff --name-only ${a} ${b}`).split("\n").map((s) => s.trim()).filter(Boolean);
  const canon = ui.canonDir ? ui.canonDir.replace(/\/+$/, "") + "/" : null;
  return changed.filter((f) => matchesAnyGlob(f, ui.verifyGlobs) || (canon !== null && f.startsWith(canon)));
};

export type UiGate =
  | { required: false }
  // carriedFrom: the screenshots were rendered at that earlier commit, and no UI file changed between
  // it and the head (a base merge, a backend-only fix) — so they still show what the head renders.
  | { required: true; blocked: false; files: string[]; artifacts: string[]; carriedFrom?: string }
  // kind "missing": the diff resolved and no screenshots exist for the CURRENT head — the one case
  // a re-render can fix (#67). kind "error": the diff/head couldn't be resolved (fail closed, #18).
  | { required: true; blocked: true; kind: "missing" | "error"; files: string[]; artifacts: string[]; reason: string };

/**
 * The merge decision. The git reads (`changed`, `artifacts`) are injectable, so it is
 * unit-testable without git; it still reads `cfg.defaultBranch` from module config for the
 * diff base. `required: false` whenever the consumer has no `ui` config or the PR touches no
 * UI files — non-UI repos and non-UI PRs are entirely unaffected.
 *
 * FAILS CLOSED: if the diff can't be computed (e.g. origin/<head> isn't present), it does not
 * throw — a throw from here on the pre-merge path would livelock the loop's cycle (#18). It
 * escalates to a human instead, which is the safe direction for a gate whose job is to stop an
 * unverified UI change from merging.
 */
export const uiGate = (
  pr: number,
  branch: string,
  // Explicit, NOT defaulted to cfg.ui: a default parameter would make an explicit `undefined`
  // silently fall back to global config, so "this consumer has no ui config" would be
  // unrepresentable — and would test green only on a machine whose config lacks the key.
  ui: UiCfg | undefined,
  deps: {
    changed?: (base: string, head: string) => string[];
    headSha?: (branch: string) => string;
    artifacts?: (pr: number, headSha: string, branch: string) => string[];
    renderedHeads?: (pr: number, branch: string) => string[];
    uiChanged?: (a: string, b: string) => string[];
  } = {},
): UiGate => {
  if (!ui || !ui.verifyGlobs?.length) return { required: false };
  const changed = deps.changed ?? ((b, h) => changedFiles(b, h));
  const headSha = deps.headSha ?? ((b) => headShaOf(b));
  const arts = deps.artifacts ?? ((n, sha, b) => artifactsFor(n, sha, b));

  // Diff and head SHA share the fail-closed guard: both read origin/<head>, and a throw here on
  // the pre-merge path would livelock the cycle (#18). Escalate to a human instead.
  let changedList: string[];
  let sha: string;
  try {
    changedList = changed(cfg.defaultBranch, branch);
    sha = headSha(branch);
  } catch (e) {
    return {
      required: true, blocked: true, kind: "error", files: [], artifacts: [],
      reason: `could not resolve the diff/head for PR #${pr} (branch ${branch}): ${(e as Error).message}. Failing closed — a human should confirm whether this touches UI and merge manually.`,
    };
  }
  const files = uiFilesTouched(changedList, ui.verifyGlobs);
  if (!files.length) return { required: false };

  // Artifacts must exist for THIS head SHA. Screenshots published against an earlier commit
  // (e.g. before a heal rewrote the UI) no longer count — that is the #35 fix.
  const artifacts = arts(pr, sha, artifactBranch(ui));
  if (!artifacts.length) {
    // Keyed to the exact head, a render went stale on EVERY head move — including a merge from the
    // base branch that touched no UI — so a busy base never let a finished UI PR converge (re-render,
    // base moves, re-render, …, heal cap). Carry an earlier render forward when no UI file (verifyGlobs,
    // canonDir) changed between it and the head. A heal that rewrote UI still needs a fresh render (#35).
    const heads = deps.renderedHeads ?? ((n, b) => renderedHeads(n, b));
    const uiChanged = deps.uiChanged ?? ((a, b) => uiChangedBetween(a, b, ui));
    for (const s of heads(pr, artifactBranch(ui)).filter((x) => x !== sha)) {
      let same = false;
      try { same = uiChanged(s, sha).length === 0; } catch { /* that commit is gone (force-push): not a basis */ }
      if (!same) continue;
      const carried = arts(pr, s, artifactBranch(ui));
      if (carried.length) return { required: true, blocked: false, files, artifacts: carried, carriedFrom: s };
    }
    return {
      required: true, blocked: true, kind: "missing", files, artifacts,
      reason: `PR #${pr} changes ${files.length} UI file(s) (${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}) but published no screenshots to ${artifactBranch(ui)}:${artifactPrefix(pr, sha)} for the current head ${sha.slice(0, 8)}. Green checks do not prove a UI change renders; a heal since the last render needs a fresh one.`,
    };
  }
  return { required: true, blocked: false, files, artifacts };
};

/**
 * The block injected into implement.md as {{UI_VERIFICATION}}.
 *
 * Injected whenever the consumer configured `ui` — NOT conditioned on the diff, because at
 * implement time the agent has not written the code yet, so there is nothing to match. The
 * host gate does the conditional enforcement once the diff exists.
 */
export const implementUiBlock = (ui: UiCfg | undefined): string => {
  if (!ui || !ui.verifyGlobs?.length) return "";
  const canon = ui.canonDir
    ? `\n- Compare against the canonical mockups in \`${ui.canonDir}\`. If your render disagrees with canon, fix the code — canon is authoritative.`
    : "";
  // #67: persist exactly the configured render inputs (nothing else), so the loop can replay this
  // render at a newer head (e.g. after it merges the base branch in) instead of parking the PR.
  const inputs = ui.renderInputs ?? [];
  const persistInputs = inputs.length
    ? `\n   # render inputs: lets the loop re-render at a newer head instead of parking the PR
   rm -rf "$tmp/pr-$PR/render-inputs" && mkdir -p "$tmp/pr-$PR/render-inputs"
   tar -cf - ${inputs.map((p) => shq(p)).join(" ")} | tar -xf - -C "$tmp/pr-$PR/render-inputs"`
    : "";
  return `## Visual verification (REQUIRED if you touch UI)

If your change touches any of these paths, green checks are NOT sufficient and the loop will
REFUSE to merge your PR unless you complete this section:

${ui.verifyGlobs.map((g) => `- \`${g}\``).join("\n")}

1. Render it: run \`${ui.renderCmd}\`, which writes images into \`${ui.artifactDir}\`.
2. Capture desktop AND a narrow (mobile) width, in BOTH dark and light themes.
3. **Look at the output.** Check every item in the checklist below.${canon}
4. Commit and push your change FIRST (open the PR if it isn't open yet), then publish the images.
   The gate keys artifacts to your branch's HEAD commit, so publish AFTER your final commit — if
   you heal/amend later, re-publish. This uses a SEPARATE clone in a temp dir — it must never
   touch your PR branch or working tree:
   \`\`\`bash
   PR=<the PR number>
   SHA=$(git rev-parse HEAD)   # your branch tip; the gate requires screenshots under this SHA
   forge git-setup
   REMOTE=$(git remote get-url origin); tmp=$(mktemp -d)
   git clone -q --depth 1 --branch ${artifactBranch(ui)} "$REMOTE" "$tmp" 2>/dev/null || {
     git init -q "$tmp"
     git -C "$tmp" remote add origin "$REMOTE"
     git -C "$tmp" checkout -q --orphan ${artifactBranch(ui)}
   }
   mkdir -p "$tmp/pr-$PR/$SHA" && cp -r "${ui.artifactDir}/." "$tmp/pr-$PR/$SHA/"${persistInputs}
   git -C "$tmp" add -A
   git -C "$tmp" -c user.email=afk@local -c user.name=afk commit -q -m "artifacts: pr-$PR @ $SHA"
   git -C "$tmp" push -q origin HEAD:refs/heads/${artifactBranch(ui)}
   \`\`\`
5. Comment the image links on the PR with \`forge pr-comment\` so they're visible in review.

${UI_CHECKLIST}

Do not open a UI-touching PR without published screenshots — it cannot merge.`;
};

/** The block injected into review.md as {{UI_VERIFICATION}}. Diff-conditional: the PR exists. */
export const reviewUiBlock = (gate: UiGate, ui: UiCfg | undefined): string => {
  if (!ui || !gate.required) return "";
  const canon = ui.canonDir ? `\n- Compare against canon in \`${ui.canonDir}\`. Reject a render that disagrees with it.` : "";
  const from = "carriedFrom" in gate ? gate.carriedFrom : undefined;
  const carried = from
    ? `\n\nThese were rendered at \`${from.slice(0, 8)}\`. No UI file (\`ui.verifyGlobs\`${ui.canonDir ? ", `ui.canonDir`" : ""}) changed between that commit and this head, so they still show what this head renders. Do NOT block for want of screenshots of the exact head SHA.`
    : "";
  const list = gate.artifacts.length
    ? `Published screenshots (branch \`${artifactBranch(ui)}\`):\n${gate.artifacts.map((a) => `- \`${a}\``).join("\n")}${carried}`
    : `**No screenshots were published.** This PR cannot merge. Request changes and say so.`;
  return `## Visual verification (this PR touches UI)

This PR changes UI files:
${gate.files.map((f) => `- \`${f}\``).join("\n")}

${list}

Confirm the render before approving. Green checks do NOT prove a UI change works — that is the
entire reason this step exists. If the screenshots are missing, unreadable, or don't match what
the issue asked for, **request changes**; do not approve on green checks alone.${canon}

${UI_CHECKLIST}`;
};

/** Standing checklist injected into both phases when the visual step is active. */
export const UI_CHECKLIST = `### UI checklist

- No overflow, overlap, misalignment, clipped text, or unstyled elements.
- Form fields are laid out as intended (not accidentally side-by-side or stacked).
- The body does not scroll horizontally at a narrow width.
- Interactive affordances (buttons, focus rings, hover states) are present and visible.
- Secret inputs (API keys, tokens) render BLANK on edit with a "keep current" hint — never
  seeded with, or masked back to, the stored value.`;
