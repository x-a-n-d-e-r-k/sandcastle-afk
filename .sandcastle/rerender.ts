import { mkdtempSync, rmSync, mkdirSync, readdirSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandbox, type SandboxHooks } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { sh, shq, type GitIdentity } from "./config.js";
import { artifactPrefix, renderInputsPrefix, uiFilesTouched, type UiGate, type UiCfg } from "./ui.js";

// ---------------------------------------------------------------------------
// Re-render instead of parking (#67).
//
// The visual gate keys screenshots to the PR's head SHA (#35), which is right: a heal that rewrites
// UI must re-render. But the loop itself routinely moves an approved PR's head without touching its
// UI — merging the base branch in (#54), resolving a conflict — and the gate then parked a healthy
// PR for a human to re-run the very command the agent had run. `ui.renderCmd` is a command, so the
// host can replay it: boot the consumer's image at the current head (createSandbox, no agent, no
// LLM), run renderCmd, publish the images at that head, re-check the gate.
//
// Bounds, so this doesn't weaken #19:
//   - Only when the PR already published a render for an OLDER head. A PR that never rendered
//     (the "nobody looked" case #19 exists for) still goes to a human.
//   - One attempt per blocked gate; a failed render escalates with its failure line.
//   - Renders that need agent-authored, uncommitted inputs (a render spec kept out of the PR)
//     replay them from `ui.renderInputs`, which the agent publishes with its screenshots.
// ---------------------------------------------------------------------------

type Blocked = Extract<UiGate, { blocked: true }>;

export type RerenderDeps = {
  /** This PR's current head SHA. */
  head: string;
  /** Head SHAs this PR already published screenshots for. */
  renderedHeads: () => string[];
  /**
   * Are the PR's UI files (gate.files) byte-identical at `sha` and at `head`? True means only the
   * base branch moved the head since that render, so the render a reviewer saw still shows the
   * PR's UI. False (or any git error) means the PR's own UI changed: a human/reviewer must look.
   */
  uiUnchangedSince: (sha: string) => boolean;
  /** Is `ui.renderInputs` configured (does the render need replayed inputs)? */
  inputsConfigured: boolean;
  /** Files persisted under pr-<n>/render-inputs/. */
  persistedInputs: () => string[];
  /** Restore inputs, run renderCmd at `head` in the sandbox, publish the images at `head`. */
  renderAndPublish: () => Promise<{ exitCode: number; output: string }>;
  /** Re-run the gate after publishing. */
  recheck: () => UiGate;
  log: (m: string) => void;
};

export type RerenderResult = { ok: true; gate: UiGate } | { ok: false; reason: string };

const lastLine = (s: string): string =>
  s.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "(no output)";

export async function rerenderBeforeEscalating(pr: number, gate: Blocked, d: RerenderDeps): Promise<RerenderResult> {
  // A diff/head error is not "screenshots are stale" — fail closed as before (#18).
  if (gate.kind !== "missing") return { ok: false, reason: gate.reason };
  const older = d.renderedHeads().filter((sha) => sha !== d.head);
  if (!older.length) return { ok: false, reason: gate.reason }; // never rendered: a human's call (#19)
  // Only replay a render a reviewer already saw: the PR's own UI must be unchanged since then. A
  // heal that rewrote UI without re-rendering is exactly what the gate exists to stop.
  const basis = older.find((sha) => { try { return d.uiUnchangedSince(sha); } catch { return false; } });
  if (!basis) {
    return { ok: false, reason: `${gate.reason} Not re-rendered automatically: this PR's own UI files changed since its last render (${older[0].slice(0, 8)}), so the new render needs a reviewer.` };
  }
  if (d.inputsConfigured && !d.persistedInputs().length) {
    return { ok: false, reason: `${gate.reason} Re-render not attempted: \`ui.renderInputs\` is configured but there is no render spec to replay (nothing published under ${renderInputsPrefix(pr)}).` };
  }

  d.log(`PR #${pr}: UI unchanged since the render at ${basis.slice(0, 8)}; only the head moved (${d.head.slice(0, 8)}) -> re-rendering`);
  let r: { exitCode: number; output: string };
  try { r = await d.renderAndPublish(); }
  catch (e) { return { ok: false, reason: `${gate.reason} The automatic re-render at ${d.head.slice(0, 8)} could not run: ${lastLine((e as Error).message)}` }; }
  if (r.exitCode !== 0) {
    return { ok: false, reason: `${gate.reason} The automatic re-render at ${d.head.slice(0, 8)} failed (exit ${r.exitCode}): ${lastLine(r.output)}` };
  }
  const g = d.recheck();
  if (g.required && g.blocked) return { ok: false, reason: `Re-rendered at ${d.head.slice(0, 8)}, but the gate is still blocked: ${g.reason}` };
  return { ok: true, gate: g };
}

// --- live pieces ------------------------------------------------------------------------------

export const DEFAULT_RENDER_TIMEOUT_SECONDS = 900;
export const renderCommand = (ui: UiCfg): string =>
  // -k: a render that ignores SIGTERM (a stuck browser) gets SIGKILLed 30s later.
  `timeout -k 30s ${ui.renderTimeoutSeconds ?? DEFAULT_RENDER_TIMEOUT_SECONDS}s sh -c ${shq(ui.renderCmd)}`;

// The PR's UI files at a commit: its diff against the base, filtered to verifyGlobs. Taking the
// union at the rendered head AND the current head matters: a heal that reverts a UI file to base
// drops it from the current diff, yet the PR's UI did change since the render.
export const prUiFilesAt = (o: { repo: string; base: string; sha: string; globs: string[]; run?: Run }): string[] => {
  const run = o.run ?? sh;
  const changed = run(`git diff --name-only ${shq(`origin/${o.base}...${o.sha}`)}`, o.repo).split("\n").map((s) => s.trim()).filter(Boolean);
  return uiFilesTouched(changed, o.globs);
};

// Are the PR's UI files byte-identical at two commits? Any unresolvable path (added/removed
// since, or a commit that isn't present) counts as changed — the conservative answer.
export const uiFilesUnchanged = (o: { repo: string; files: string[]; a: string; b: string; run?: Run }): boolean => {
  const run = o.run ?? sh;
  if (!o.files.length) return false;
  for (const f of o.files) {
    let x: string, y: string;
    try { x = run(`git rev-parse ${shq(`${o.a}:${f}`)}`, o.repo); y = run(`git rev-parse ${shq(`${o.b}:${f}`)}`, o.repo); }
    catch { return false; }
    if (x !== y) return false;
  }
  return true;
};

type Run = (cmd: string, cwd: string) => string;

// Publish a directory of images to <artifactBranch>:pr-<n>/<sha>/ from the HOST (a throwaway clone,
// committed as the implement identity). Throws if there is nothing to publish.
export const publishArtifacts = (o: {
  repo: string; artifactBranch: string; pr: number; sha: string; srcDir: string; identity: GitIdentity; run?: Run;
}): number => {
  const run = o.run ?? sh;
  const files = existsSync(o.srcDir) ? readdirSync(o.srcDir) : [];
  if (!files.length) throw new Error(`the render wrote nothing to ${o.srcDir}`);
  const remote = run("git remote get-url origin", o.repo);
  const tmp = mkdtempSync(join(tmpdir(), "afk-artifacts-"));
  try {
    try { run(`git clone -q --depth 1 --branch ${shq(o.artifactBranch)} ${shq(remote)} ${shq(tmp)}`, o.repo); }
    catch {
      rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp);
      run("git init -q", tmp); run(`git remote add origin ${shq(remote)}`, tmp); run(`git checkout -q --orphan ${shq(o.artifactBranch)}`, tmp);
    }
    const dest = join(tmp, artifactPrefix(o.pr, o.sha));
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(o.srcDir, dest, { recursive: true });
    const as = `-c user.name=${shq(o.identity.name)} -c user.email=${shq(o.identity.email)}`;
    run("git add -A", tmp);
    run(`git ${as} commit -q -m ${shq(`artifacts: pr-${o.pr} @ ${o.sha} (loop re-render)`)}`, tmp);
    try { run(`git push -q origin ${shq(`HEAD:refs/heads/${o.artifactBranch}`)}`, tmp); }
    catch {
      // Another loop/agent published to the artifact branch at the same moment: rebase once, retry.
      run(`git ${as} pull -q --rebase origin ${shq(o.artifactBranch)}`, tmp); // rebase re-commits: needs the identity
      run(`git push -q origin ${shq(`HEAD:refs/heads/${o.artifactBranch}`)}`, tmp);
    }
    return files.length;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

// Boot the consumer's image on the PR branch (the local branch must already be at origin's tip),
// restore the persisted render inputs into the bind-mounted worktree, run renderCmd, and on success
// publish the images — all before close(), which removes a worktree whose only changes are ignored.
export const liveRenderAndPublish = async (o: {
  repo: string; pr: number; branch: string; head: string; ui: UiCfg; artifactBranch: string;
  imageName: string; hooks: SandboxHooks; identity: GitIdentity;
}): Promise<{ exitCode: number; output: string }> => {
  const sb = await createSandbox({ branch: o.branch, sandbox: docker({ imageName: o.imageName }), cwd: o.repo, hooks: o.hooks });
  try {
    const wt = sb.worktreePath;
    const at = sh("git rev-parse HEAD", wt);
    if (at !== o.head) throw new Error(`sandbox worktree is at ${at.slice(0, 8)}, not the PR head ${o.head.slice(0, 8)}`);
    if (o.ui.renderInputs?.length) {
      // pr-<n>/render-inputs/<path> → <worktree>/<path>
      // Two steps, not a pipe: a failing `git archive` must not be masked by tar's exit status.
      const tarball = join(tmpdir(), `afk-render-inputs-${o.pr}-${process.pid}.tar`);
      try {
        sh(`git archive --format=tar -o ${shq(tarball)} ${shq(`origin/${o.artifactBranch}`)} ${shq(renderInputsPrefix(o.pr))}`, o.repo);
        sh(`tar -xf ${shq(tarball)} --strip-components=2 -C ${shq(wt)}`, o.repo);
      } finally { rmSync(tarball, { force: true }); }
    }
    rmSync(join(wt, o.ui.artifactDir), { recursive: true, force: true });
    // Bounded like every other sandbox step: a render that hangs (a dev server that never comes up)
    // must not stall the loop. coreutils `timeout` exits 124, which escalates with its failure line.
    const r = await sb.exec(renderCommand(o.ui));
    const output = `${r.stdout}\n${r.stderr}`;
    if (r.exitCode !== 0) return { exitCode: r.exitCode, output };
    publishArtifacts({ repo: o.repo, artifactBranch: o.artifactBranch, pr: o.pr, sha: o.head, srcDir: join(wt, o.ui.artifactDir), identity: o.identity });
    return { exitCode: 0, output };
  } finally {
    await sb.close();
  }
};
