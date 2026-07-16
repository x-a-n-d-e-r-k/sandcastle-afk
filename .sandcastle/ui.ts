import { cfg, sh, type UiVerifyCfg } from "./config.js";

// Visual verification for UI-touching PRs (#19).
//
// Green lint/test/typecheck don't prove a UI change renders. The loop merged front-end PRs
// that were visibly broken on first paint because neither the implement nor the review phase
// ever rendered them.
//
// Division of labour, chosen deliberately:
//   - The layer NEVER renders. It cannot know how to boot an arbitrary consumer's app, and
//     baking a browser into Dockerfile.template would tax every non-UI consumer. The consumer
//     supplies `ui.renderCmd`; their base image owns having a browser.
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
/** Artifacts for a PR live under this prefix on the orphan branch. */
export const artifactPrefix = (pr: number): string => `pr-${pr}/`;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Translate a glob to an anchored RegExp.
 *
 * Supported: `**` (crosses separators), `*` (within a segment), `?` (one non-separator char),
 * and `{a,b}` alternation. A trailing-slash `**\/` matches ZERO or more segments, so
 * `apps/web/**\/*.tsx` matches `apps/web/App.tsx` as well as `apps/web/a/b/C.tsx`.
 *
 * LIMITATION: alternatives inside `{...}` are LITERAL — `{*.ts,*.js}` will not do what you
 * want. Config globs are `*.{tsx,css}`-shaped in practice; write two globs instead of nesting
 * wildcards in a brace group.
 */
export const globToRegExp = (glob: string): RegExp => {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` spans zero or more whole segments; a bare `**` spans anything.
        if (glob[i + 2] === "/") { re += "(?:[^/]*/)*"; i += 3; continue; }
        re += ".*"; i += 2; continue;
      }
      re += "[^/]*"; i += 1; continue;
    }
    if (c === "?") { re += "[^/]"; i += 1; continue; }
    if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end !== -1) {
        re += `(?:${glob.slice(i + 1, end).split(",").map(escapeRe).join("|")})`;
        i = end + 1; continue;
      }
      // Unbalanced brace: treat as a literal rather than throwing on a typo'd config.
    }
    re += escapeRe(c); i += 1;
  }
  return new RegExp(`^${re}$`);
};

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

/** Artifact paths published for a PR, or [] if the branch or prefix is absent. */
export const artifactsFor = (
  pr: number,
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
    const out = run(`git ls-tree -r --name-only origin/${branch} -- "${artifactPrefix(pr)}"`);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
};

export type UiGate =
  | { required: false }
  | { required: true; blocked: false; files: string[]; artifacts: string[] }
  | { required: true; blocked: true; files: string[]; artifacts: string[]; reason: string };

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
    artifacts?: (pr: number, branch: string) => string[];
  } = {},
): UiGate => {
  if (!ui || !ui.verifyGlobs?.length) return { required: false };
  const changed = deps.changed ?? ((b, h) => changedFiles(b, h));
  const arts = deps.artifacts ?? ((n, b) => artifactsFor(n, b));

  let changedList: string[];
  try {
    changedList = changed(cfg.defaultBranch, branch);
  } catch (e) {
    return {
      required: true, blocked: true, files: [], artifacts: [],
      reason: `could not compute the diff for PR #${pr} (branch ${branch}): ${(e as Error).message}. Failing closed — a human should confirm whether this touches UI and merge manually.`,
    };
  }
  const files = uiFilesTouched(changedList, ui.verifyGlobs);
  if (!files.length) return { required: false };

  const artifacts = arts(pr, artifactBranch(ui));
  if (!artifacts.length) {
    return {
      required: true, blocked: true, files, artifacts,
      reason: `PR #${pr} changes ${files.length} UI file(s) (${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}) but published no screenshots to ${artifactBranch(ui)}:${artifactPrefix(pr)}. Green checks do not prove a UI change renders.`,
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
  return `## Visual verification (REQUIRED if you touch UI)

If your change touches any of these paths, green checks are NOT sufficient and the loop will
REFUSE to merge your PR unless you complete this section:

${ui.verifyGlobs.map((g) => `- \`${g}\``).join("\n")}

1. Render it: run \`${ui.renderCmd}\`, which writes images into \`${ui.artifactDir}\`.
2. Capture desktop AND a narrow (mobile) width, in BOTH dark and light themes.
3. **Look at the output.** Check every item in the checklist below.${canon}
4. Open the PR first (you need its number), then publish the images to the artifact branch so
   a human and the reviewer can see them. This uses a SEPARATE clone in a temp dir — it must
   never touch your PR branch or working tree:
   \`\`\`bash
   PR=<the PR number>
   forge git-setup
   REMOTE=$(git remote get-url origin); tmp=$(mktemp -d)
   git clone -q --depth 1 --branch ${artifactBranch(ui)} "$REMOTE" "$tmp" 2>/dev/null || {
     git init -q "$tmp"
     git -C "$tmp" remote add origin "$REMOTE"
     git -C "$tmp" checkout -q --orphan ${artifactBranch(ui)}
   }
   mkdir -p "$tmp/pr-$PR" && cp -r "${ui.artifactDir}/." "$tmp/pr-$PR/"
   git -C "$tmp" add -A
   git -C "$tmp" -c user.email=afk@local -c user.name=afk commit -q -m "artifacts: pr-$PR"
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
  const list = gate.artifacts.length
    ? `Published screenshots (branch \`${artifactBranch(ui)}\`):\n${gate.artifacts.map((a) => `- \`${a}\``).join("\n")}`
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
