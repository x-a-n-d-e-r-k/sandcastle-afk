import { pathToFileURL } from "node:url";
import { run, claudeCode, type RunOptions, type RunResult } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { ROOT, cfg, sh, log, sleep, loadAgentRules, pruneWorktrees, ensureHostOnDefaultBranch, reviewAgentEnv, checkReviewCredential, renderPreflight, phaseRules, ORPHAN_LABEL, requireGitIdentity, gitSetupCommand, type GitIdentity } from "./config.js";
import * as forge from "./forge-client.js";
import { pickNextIssue, realPickDeps, MINE, issueNumOf } from "./claim.js";
import { shouldRunTriage, sweepBlockedIssues, isIssueClosed, TRIAGE_MARKER } from "./triage.js";
import { shouldStop, stopSentinelExists, clearStopSentinel, sleepUnlessStopped } from "./stop.js";
import { uiGate, implementUiBlock, reviewUiBlock, artifactBranch, artifactPrefix, headShaOf, renderedHeads, persistedRenderInputs } from "./ui.js";
import { rerenderBeforeEscalating, liveRenderAndPublish, uiFilesUnchanged } from "./rerender.js";
import { handleConflict, mechanicalMerge, baseTip, branchContains, type ConflictResult } from "./conflicts.js";
import { healWithBudget, type HealDeps } from "./heal.js";
import { closeLinkedIssue, guardedMerge, landedOnBase, assertGitSupportsMergeTree, type IssueCloseDeps } from "./merge-guard.js";
import { isUsageError, dispatchIssue, checkpointAfterFailure, hasCheckpoint, countResumes, RESUME_MARKER, resumePrompt } from "./checkpoint.js";

const RULES = loadAgentRules();
// Phases that run long commands also get the liveness rule (#53); triage keeps plain house rules.
const PHASE_RULES = phaseRules(RULES, cfg.idleTimeoutSeconds);
// The preflight gate travels in the prompt, not as a file: the gitignored .sandcastle/preflight.sh
// is never in the sandbox worktree (#55). Every phase that runs preflight gets it; triage doesn't.
const PREFLIGHT = renderPreflight(cfg.preflight);

// ---------------------------------------------------------------------------
// AFK orchestrator daemon (concurrency = 1), forge-agnostic.
//   pnpm afk:loop                  # run forever
//   AFK_DRY_RUN=1 pnpm afk:loop    # plan one cycle and exit
// ---------------------------------------------------------------------------

const POLL_MS = cfg.pollMinutes * 60_000;
const MAX_HEAL = cfg.maxHeal;
const MAX_USAGE_WAITS = 8;
const DRY = !!process.env.AFK_DRY_RUN;
const L = cfg.labels;

type Issue = { number: number; title: string; labels: string[] };
type PR = { number: number; headRef: string; reviewState: string; labels: string[]; merged?: boolean };
const EXTERNAL = cfg.reviewMode === "external";

// --- usage-limit guard (best-effort patterns; tune on first real limit) -----
function parseResetMs(msg: string): number | null {
  const iso = msg.match(/resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i);
  if (iso) { const t = Date.parse(iso[1]); if (!Number.isNaN(t)) return Math.max(0, t - Date.now()); }
  const hrs = msg.match(/in\s+(\d+)\s*h(?:our)?/i); if (hrs) return Number(hrs[1]) * 3_600_000;
  const mins = msg.match(/in\s+(\d+)\s*m(?:in)?/i); if (mins) return Number(mins[1]) * 60_000;
  return null;
}
async function runGuarded(opts: RunOptions): Promise<RunResult> {
  let attempt = 0;
  while (true) {
    try { return await run(opts); }
    catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (!isUsageError(msg) || attempt >= MAX_USAGE_WAITS) throw e;
      attempt++;
      const wait = parseResetMs(msg) ?? Math.min(30 * 60_000, 60_000 * 2 ** (attempt - 1));
      log(`usage/rate limit (attempt ${attempt}/${MAX_USAGE_WAITS}); waiting ${Math.round(wait / 60_000)}m then resuming same branch. [${msg.slice(0, 120)}]`);
      await sleep(wait);
    }
  }
}

const INSTALL_TIMEOUT_MS = 600_000;
const SETUP_TIMEOUT_MS = 600_000;

// The sandbox startup sequence (#48). Pure + exported so the ordering — install FIRST (project
// deps), then consumer `setupCommands` (agent tooling), then `forge git-setup` (push creds +
// the pinned commit identity, #52 — only when the phase pushes, i.e. `pushAs` is set) — is
// unit-testable without booting Docker. Each setup command runs via `sh -c` with the container
// env; the consumer makes it best-effort with a trailing `|| true`.
export const sandboxReadyHooks = (install: string, setupCommands: string[], pushAs: GitIdentity | null) => [
  { command: install, timeoutMs: INSTALL_TIMEOUT_MS },
  ...setupCommands.map((command) => ({ command, timeoutMs: SETUP_TIMEOUT_MS })),
  ...(pushAs ? [{ command: gitSetupCommand(pushAs) }] : []),
];

const baseRun = (name: string, branch: string, promptFile: string, model: string, withPush: boolean): RunOptions => ({
  name,
  sandbox: docker({ imageName: cfg.imageName }),
  agent: claudeCode(model),
  promptFile,
  branchStrategy: { type: "branch", branch, baseBranch: `origin/${cfg.defaultBranch}` },
  maxIterations: 1,
  hooks: {
    sandbox: {
      onSandboxReady: sandboxReadyHooks(cfg.install, cfg.setupCommands ?? [], withPush ? requireGitIdentity(cfg.gitIdentity) : null),
    },
  },
  logging: { type: "stdout" } as const,
  idleTimeoutSeconds: cfg.idleTimeoutSeconds,
});

// Exported for the credential test (#32): assert the reviewer token is present in the review
// run's agent env and ABSENT from every other phase — without booting Docker.
export const implementOpts = (issue: number, resume = false): RunOptions => ({
  ...baseRun(`issue-${issue}`, `agent/issue-${issue}`, ".sandcastle/implement.md", cfg.models.implement, true),
  // Not diff-conditional: at implement time the agent hasn't written the code yet, so there is
  // no diff to match. Injected whenever `ui` is configured; the host gate (uiGate) does the
  // conditional enforcement once a diff exists. Empty string when `ui` is unset.
  promptArgs: {
    ISSUE_NUMBER: String(issue), BASE_BRANCH: cfg.defaultBranch, AGENT_RULES: PHASE_RULES,
    // Resuming from a checkpoint commit left by a killed attempt (#53); "" on a fresh dispatch.
    RESUME: resume ? resumePrompt(issue) : "",
    UI_VERIFICATION: implementUiBlock(cfg.ui), PREFLIGHT,
  },
});
export const reviewOpts = (pr: number, branch: string, issue: string): RunOptions => ({
  ...baseRun(`review-${pr}`, branch, ".sandcastle/review.md", cfg.models.review, false),
  // The ONLY phase that gets the reviewer credential — this is the harness enforcing the
  // independent-review property, not the prompt (#32). reviewAgentEnv() is {} when the token
  // is unset (external mode); internal mode is guaranteed the token by checkReviewCredential().
  agent: claudeCode(cfg.models.review, { env: reviewAgentEnv() }),
  promptArgs: {
    PR_NUMBER: String(pr), ISSUE_NUMBER: issue, AGENT_RULES: PHASE_RULES,
    UI_VERIFICATION: reviewUiBlock(uiGate(pr, branch, cfg.ui), cfg.ui), PREFLIGHT,
  },
});
export const healOpts = (pr: number, branch: string, issue: string): RunOptions => ({
  ...baseRun(`heal-${pr}`, branch, ".sandcastle/heal.md", cfg.models.heal, true),
  // A heal can rewrite UI, invalidating the pre-heal screenshots (they key on the old head
  // SHA now, #35), so the healing agent must know to re-render and re-publish. Empty when the
  // consumer has no `ui` config.
  promptArgs: { PR_NUMBER: String(pr), ISSUE_NUMBER: issue, AGENT_RULES: PHASE_RULES, UI_VERIFICATION: implementUiBlock(cfg.ui), PREFLIGHT },
});
export const resolveConflictsOpts = (pr: number, branch: string, issue: string): RunOptions => ({
  ...baseRun(`resolve-${pr}`, branch, ".sandcastle/resolve-conflicts.md", cfg.models.heal, true),
  promptArgs: { PR_NUMBER: String(pr), ISSUE_NUMBER: issue, BASE_BRANCH: cfg.defaultBranch, AGENT_RULES: PHASE_RULES, UI_VERIFICATION: implementUiBlock(cfg.ui), PREFLIGHT },
});

// Idle-triage `needs-feedback` re-evaluation agent (#414). Issue-ops only: it reads each
// parked issue and mutates labels/comments via forge — it MUST NOT open a PR or push an
// `agent/issue-N` implement branch. So: withPush=false (no `forge git-setup`), a fixed
// non-implement branch, the triage.md prompt, no PR/`Closes` step. A set
// AFK_TRIAGE_DRY_RUN is forwarded into the run env so the agent performs no mutations.
export const triageOpts = (): RunOptions => {
  const dry = process.env.AFK_TRIAGE_DRY_RUN;
  return {
    ...baseRun("triage", "afk/triage", ".sandcastle/triage.md", cfg.models.triage, false),
    ...(dry ? { agent: claudeCode(cfg.models.triage, { env: { AFK_TRIAGE_DRY_RUN: dry } }) } : {}),
    promptArgs: { AGENT_RULES: RULES },
  };
};

const getAgentPRs = (): PR[] => forge.prList().filter((p) => p.headRef.startsWith("agent/issue-"));
const syncBranch = (b: string) => { ensureHostOnDefaultBranch(); sh(`git fetch origin ${b}`); pruneWorktrees(); sh(`git branch -f ${b} origin/${b}`); };

// A leftover `agent/issue-N` branch (from a failed/incomplete dispatch) gets REUSED by
// Sandcastle at its old tip instead of being recreated from fresh `main` — so every
// retry checks out stale code and fails identically. Delete it before a fresh dispatch.
// Safe: we only dispatch issues with no open PR and no closed-unmerged PR (see pickNextIssue).
function deleteStaleBranch(issue: number) {
  const b = `agent/issue-${issue}`;
  try { if (sh(`git ls-remote --heads origin ${b}`)) { log(`deleting stale ${b}`); sh(`git push origin --delete ${b}`); } } catch {}
  try { sh(`git branch -D ${b}`); } catch {}
}

// PR classification before the conflict path (#61). An orphan — its source branch doesn't exist
// on origin — reads as "conflicting" on GitLab, which used to burn maxHeal resolve-conflicts runs
// against a branch that isn't there and then escalate with a misleading message. `head` comes
// from forge pr-head-exists; "error" means it couldn't be determined: fail closed and touch
// nothing this cycle. hasConflicts is only asked once the head is known to exist.
export type PrClass = "skip" | "orphan" | "conflicted" | "ok";
export const classifyPr = (head: boolean | "error", hasConflicts: () => boolean): PrClass => {
  if (head === "error") return "skip";
  if (head === false) return "orphan";
  return hasConflicts() ? "conflicted" : "ok";
};

export type OrphanDeps = {
  comment: (body: string) => void;
  label: (label: string) => void;
  close: () => void;
  releaseClaim: () => void;
  log: (m: string) => void;
};

// Close an owned orphan PR so its issue is re-dispatched. Labels FIRST: the label is what lets
// pickNextIssue dispatch the issue again, so a PR must never end up closed without it (that
// strands the issue — the bug this fixes). Never marks a conflict retry, resolves or escalates.
export function handleOrphan(pr: { number: number; headRef: string }, d: OrphanDeps): void {
  d.log(`PR #${pr.number}: source branch ${pr.headRef} is missing on origin -> closing as orphan`);
  d.label(ORPHAN_LABEL);
  d.comment(`AFK: source branch ${pr.headRef} does not exist on origin — closing this orphaned PR; the issue will be re-dispatched.`);
  d.close();
  d.releaseClaim();
}

// Live forge wiring for closing a PR's linked issue and releasing this loop's claim (#70).
const issueCloseDeps: IssueCloseDeps = {
  issueState: (n) => forge.issueView(n).state,
  closeIssue: (n, comment) => forge.issueClose(n, "--comment", JSON.stringify(comment)),
  releaseClaim: (n) => { if (MINE) forge.issueEdit(n, "--remove-label", MINE); },
  log,
};

// Live wiring for the heal budget (#69): counts heal ATTEMPTS, not reviews; marked before each run.
const healBudget = (pr: number, heal: () => Promise<void>): HealDeps => ({
  maxHeal: MAX_HEAL,
  count: () => Number(forge.prHealCount(pr)) || 0,
  mark: () => forge.prHealMark(pr),
  heal,
  escalate: (n) => {
    log(`PR #${pr} heal cap (${n}/${MAX_HEAL} attempts) -> escalating to ${L.needsHuman}`);
    escalate(pr, `${n} heal attempts did not converge (forge pr-heal-reset ${pr} gives it a fresh budget)`);
  },
  log,
});

// After a conflict outcome: a stale flag moves on to the next PR in the same cycle (#68);
// everything else is this cycle's work.
export const afterConflict = (o: ConflictResult): "next-pr" | "end-cycle" =>
  o === "stale-flag" ? "next-pr" : "end-cycle";

function escalate(pr: number, reason: string) {
  forge.prLabel(pr, "--add-label", L.needsHuman);
  forge.prComment(pr, "--body", JSON.stringify(`AFK: ${reason}. Parking for a human.`));
}

// Deterministic blocker-sweep backstop, bound to forge. Runs synchronously between
// loop runs (concurrency=1) so it never races a live container. issue-list omits body,
// so we issue-view each blocked issue (and each blocker) for body + closed-state.
function runTriageSweep() {
  const blockedNums = forge.issueList("--label", "blocked").map((i) => i.number);
  type Detail = { number: number; body?: string; labels: string[]; state: string };
  const detail = (n: number): Detail => forge.issueView(n);
  const promoted = sweepBlockedIssues({
    listBlocked: () => blockedNums.map(detail),
    isClosed: (n) => isIssueClosed(detail(n)),
    promote: (n) => { forge.issueEdit(n, "--add-label", L.ready, "--remove-label", "blocked"); },
    hasMarkerComment: (n) => forge.issueComments(n).includes(TRIAGE_MARKER),
    comment: (n, body) => { forge.issueComment(n, "--body", JSON.stringify(body)); },
  });
  if (promoted.length) log(`triage: promoted ${promoted.length} unblocked issue(s): ${promoted.join(", ")}`);
}

async function main(): Promise<void> {
  // Fail fast if the reviewer credential is misplaced (in .env, where it leaks to every
  // sandbox) or missing in internal mode — before any container starts (#32).
  checkReviewCredential();
  // Same for the commit identity (#52): refuse to start rather than fail every pushing cycle.
  requireGitIdentity(cfg.gitIdentity);
  // The merge guard's landed check needs git >= 2.38; refuse to start rather than never merge.
  assertGitSupportsMergeTree(sh("git --version"));
  let lastTriageAt: number | null = null;
  log(`AFK loop starting (concurrency 1, platform ${cfg.platform}, review ${cfg.reviewMode}${DRY ? ", DRY-RUN" : ""}). \`pnpm afk:stop\` stops after the current run; Ctrl-C stops sooner (again to force).`);

  // Graceful stop: exit cleanly BEFORE the next iteration so we never tear the loop
  // down mid-step into the half-applied state a hard Ctrl-C leaves (leaked worktree,
  // host stuck on an agent branch) — the very wedges this loop has to recover from.
  // Two triggers:
  //   - `pnpm afk:stop` writes an on-disk sentinel the loop polls. This is the fully
  //     graceful path: it never signals the running container, so the current run
  //     always finishes. Works when the loop is detached (tmux), from any terminal.
  //   - SIGINT (Ctrl-C) sets the flag so the loop stops at the next safe point instead
  //     of dying mid-iteration. A second Ctrl-C force-exits. (Ctrl-C reaches the whole
  //     process group, so it may still cut an in-flight run short — use afk:stop to let
  //     a run finish; any worktree it leaks is reclaimed by pruneWorktrees next start.)
  let signalledStop = false;
  let sigints = 0;
  process.on("SIGINT", () => {
    if (++sigints >= 2) { log("force stop (second Ctrl-C) — exiting now."); process.exit(130); }
    signalledStop = true;
    log("stop requested (Ctrl-C) — will exit at the next safe point. Ctrl-C again to force.");
  });
  const stopNow = () => shouldStop(signalledStop, stopSentinelExists());
  clearStopSentinel(); // ignore a stale sentinel left by a previously force-killed run

  while (true) {
    if (stopNow()) { log("stop requested — exiting cleanly between runs."); clearStopSentinel(); process.exit(0); }
    try {
      ensureHostOnDefaultBranch(); // recover if an interrupted run left the host repo on an agent branch
      pruneWorktrees(); // clear worktrees leaked by torn-down sandbox containers before any branch op
      sh(`git fetch origin ${cfg.defaultBranch}`);
      // Blocker-sweep EVERY cycle, not only when idle (#47): promote blocked issues whose
      // deps have all closed. It's deterministic, synchronous, forge-only (no container, no
      // LLM) and idempotent — cheap enough to run unconditionally. It used to run only in the
      // idle branch, but a non-empty `low` fill queue means the loop never goes idle, so a
      // gated priority chain stayed blocked behind its own fill work and never cascaded.
      runTriageSweep();
      const all = getAgentPRs();
      // Multi-loop (#8): only drive PRs whose issue THIS clone owns (carries our claim).
      // Query the claim label directly (not the `ready` set) so ownership survives even if
      // `ready` is stripped once a PR opens. Single-loop (MINE === "") leaves it null so
      // isMine is always true and the loop owns every PR (unchanged behavior).
      const ownedIssues = MINE
        ? new Set(forge.issueList("--label", MINE).map((i) => i.number))
        : null;
      const isMine = (headRef: string) => {
        if (!ownedIssues) return true;
        const n = issueNumOf(headRef);
        return !Number.isNaN(n) && ownedIssues.has(n);
      };
      const active = all.filter((p) => !p.labels.includes(L.needsHuman) && isMine(p.headRef));

      if (DRY) {
        if (active.length) { const pr = active[0]; log(`DRY: in-flight PR #${pr.number} (${pr.headRef}) state=${pr.reviewState}`); }
        else { const n = await pickNextIssue(all, realPickDeps(L.ready, DRY)); log(n ? `DRY: would dispatch #${n.number}: ${n.title}` : "DRY: idle"); }
        process.exit(0);
      }

      if (active.length) {
        // Drive the first PR that needs work. Most outcomes end the cycle (concurrency 1: one
        // container run at a time); a stale conflict flag yields to the NEXT PR instead, so one
        // stuck flag can't starve every other PR (#68).
        let yielded = 0;
        prs: for (const pr of active) {
          const branch = pr.headRef;
          const issue = branch.match(/issue-(\d+)/)?.[1] ?? "";

          // Conflicts with the base branch block BOTH review and merge, so resolve them
          // first (#54): a host-side `git merge` honours .gitattributes merge drivers the forge's
          // mergeability check ignores, so try it before spending an agent run; only a real
          // conflict goes to the sandbox resolver. Capped at MAX_HEAL CONSECUTIVE failures (any
          // success resets it) so an unresolvable conflict escalates instead of wedging the loop,
          // while a PR that main keeps moving under is never parked for succeeding. A conflicted
          // PR can't be reviewed or merged, so it is this cycle's work — unless the flag is stale (#68),
          // in which case the cycle moves on to the next PR.
          let head: boolean | "error";
          try {
            const out = forge.prHeadExists(pr.number);
            head = out === "true" ? true : out === "false" ? false : "error";
            if (head === "error") log(`PR #${pr.number}: pr-head-exists gave unexpected output "${out}"`);
          } catch (e) {
            log(`PR #${pr.number}: could not verify its source branch (${(e as Error).message.split("\n")[0]})`);
            head = "error";
          }
          const cls = classifyPr(head, () => forge.prHasConflicts(pr.number) === "true");

          if (cls === "skip") {
            log(`PR #${pr.number}: head state unknown -> leaving it untouched this cycle`);
            await sleepUnlessStopped(POLL_MS, stopNow);
          } else if (cls === "orphan") {
            const n = issueNumOf(branch);
            handleOrphan(pr, {
              comment: (body) => forge.prComment(pr.number, "--body", JSON.stringify(body)),
              label: (l) => forge.prLabel(pr.number, "--add-label", l),
              close: () => forge.prClose(pr.number),
              releaseClaim: () => { if (MINE && !Number.isNaN(n)) forge.issueEdit(n, "--remove-label", MINE); },
              log,
            });
          } else if (cls === "conflicted") {
            log(`PR #${pr.number} conflicts with ${cfg.defaultBranch}`);
            const outcome = await handleConflict(pr.number, {
              maxFailures: MAX_HEAL,
              alreadyContainsBase: () => branchContains(ROOT, branch, baseTip(ROOT, cfg.defaultBranch)),
              failures: () => Number(forge.prConflictRetryCount(pr.number)) || 0,
              markAttempt: () => forge.prConflictRetryMark(pr.number),
              markResolved: () => forge.prConflictRetryClear(pr.number),
              mechanical: () => mechanicalMerge({
                repo: ROOT, branch, base: cfg.defaultBranch, identity: requireGitIdentity(cfg.gitIdentity),
              }),
              agent: async () => {
                const sha = baseTip(ROOT, cfg.defaultBranch);
                syncBranch(branch);
                await runGuarded(resolveConflictsOpts(pr.number, branch, issue));
                return branchContains(ROOT, branch, sha);
              },
              escalate: (n) => {
                log(`PR #${pr.number} conflict-resolve cap (${n}/${MAX_HEAL} consecutive) -> escalating to ${L.needsHuman}`);
                escalate(pr.number, `could not resolve conflicts with ${cfg.defaultBranch} after ${MAX_HEAL} consecutive attempts`);
              },
              log,
            });
            if (afterConflict(outcome) === "next-pr") {
              // The head didn't change, so no re-review. Nudge the forge to recompute mergeability
              // (GitLab: a no-op rebase), then move on to the next PR in this same cycle.
              try { forge.prRecheckMergeability(pr.number); }
              catch (e) { log(`PR #${pr.number}: mergeability recheck failed (${(e as Error).message.split("\n")[0]})`); }
              yielded++;
              continue prs;
            }
            // A new head needs a fresh review — except, if the consumer opts out, one that only
            // merged the base branch in mechanically. A failed agent resolve is retried next cycle.
            const rereview = outcome === "agent-resolved" || (outcome === "mechanical" && cfg.rereviewAfterMechanicalMerge !== false);
            if (rereview) {
              syncBranch(branch);
              if (EXTERNAL) log(`resolved conflicts on #${pr.number}; awaiting external review.`);
              else { log(`re-reviewing #${pr.number} after conflict resolve`); await runGuarded(reviewOpts(pr.number, branch, issue)); }
            }
          } else if (pr.reviewState === "APPROVED") {
            if (EXTERNAL) { log(`PR #${pr.number} APPROVED — awaiting external merge.`); await sleepUnlessStopped(POLL_MS, stopNow); }
            else {
              // Visual gate (#19). An approval + green pipeline does NOT prove a UI change
              // renders; both agents can honestly believe a broken layout is fine. If the diff
              // touches ui.verifyGlobs and no screenshots were published, refuse to merge and
              // hand it to a human — the prompts ask for the render, this is what enforces it.
              // No-op for consumers without `ui` configured, and for non-UI diffs.
              //
              // syncBranch first so origin/<head> exists before uiGate diffs against it: this is
              // the one path that can reach APPROVED without the review path having synced (e.g.
              // a human approves within the poll interval), and uiGate's diff would otherwise
              // throw on a missing ref and livelock the cycle.
              if (cfg.ui) syncBranch(branch);
              let vg = uiGate(pr.number, branch, cfg.ui);
              if (vg.required && vg.blocked && cfg.ui) {
                // Before parking: if only the head moved since a published render, replay the
                // render at the new head (#67). Escalates only if that can't be done.
                const ui = cfg.ui, ab = artifactBranch(ui), uiFiles = vg.files;
                const head = vg.kind === "missing" ? headShaOf(branch) : "";
                const rr = await rerenderBeforeEscalating(pr.number, vg, {
                  head,
                  renderedHeads: () => renderedHeads(pr.number, ab),
                  uiUnchangedSince: (sha) => uiFilesUnchanged({ repo: ROOT, files: uiFiles, a: sha, b: head }),
                  inputsConfigured: !!ui.renderInputs?.length,
                  persistedInputs: () => persistedRenderInputs(pr.number, ab),
                  renderAndPublish: () => liveRenderAndPublish({
                    repo: ROOT, pr: pr.number, branch, head, ui, artifactBranch: ab, imageName: cfg.imageName,
                    hooks: { sandbox: { onSandboxReady: sandboxReadyHooks(cfg.install, cfg.setupCommands ?? [], null) } },
                    identity: requireGitIdentity(cfg.gitIdentity),
                  }),
                  recheck: () => uiGate(pr.number, branch, ui),
                  log,
                });
                if (rr.ok === false) {
                  log(`PR #${pr.number} APPROVED but visual verification is missing -> escalating`);
                  escalate(pr.number, rr.reason);
                  await sleepUnlessStopped(POLL_MS, stopNow);
                  break prs;
                }
                vg = rr.gate;
                const n = vg.required ? vg.artifacts.length : 0;
                forge.prComment(pr.number, "--body", JSON.stringify(
                  `AFK: the head moved to ${head.slice(0, 8)} after the last render, so the loop re-ran \`${ui.renderCmd}\` there: ${n} screenshot(s) at \`${ab}:${artifactPrefix(pr.number, head)}\`.`));
              }
              const pl = forge.prPipeline(pr.number);
              if (["success", "skipped", "none"].includes(pl.status)) {
                log(`PR #${pr.number} APPROVED, pipeline ${pl.status}${vg.required ? `, ${vg.artifacts.length} screenshot(s)` : ""} -> merging`);
                // Guarded (#71): never merge a change already on base; verify the merge finalized.
                const landed = () => landedOnBase({ repo: ROOT, base: cfg.defaultBranch, branch, run: sh });
                const outcome = guardedMerge(pr.number, {
                  landed,
                  merge: () => forge.prMerge(pr.number, "--squash", "--delete-branch", "--no-auto-merge"),
                  stillOpen: () => forge.prList().some((p) => p.number === pr.number),
                  finalize: (why) => {
                    const body = why === "already-landed"
                      ? `AFK: this change is already on ${cfg.defaultBranch} — closing instead of merging it again.`
                      : `AFK: the merge landed on ${cfg.defaultBranch} but the forge did not finalize this PR — closing it so it is not merged again.`;
                    forge.prComment(pr.number, "--body", JSON.stringify(body));
                    forge.prClose(pr.number);
                  },
                  closeIssue: () => { if (issue) closeLinkedIssue(Number(issue), pr.number, issueCloseDeps); },
                  log,
                });
                if (outcome === "skipped-error" || outcome === "merge-pending") await sleepUnlessStopped(POLL_MS, stopNow);
              } else if (["running", "pending"].includes(pl.status)) {
                log(`PR #${pr.number} approved; pipeline ${pl.status} — waiting`);
                await sleepUnlessStopped(POLL_MS, stopNow);
              } else {
                // failed | canceled — retry flakes, else heal against the pipeline logs
                const tries = Number(forge.prPipelineRetryCount(pr.number)) || 0;
                const failedJobs = forge.prPipelineFailedJobs(pr.number).split("\n").map((s) => s.trim()).filter(Boolean);
                const onlyFlaky = cfg.flakyJobs.length ? failedJobs.every((j) => cfg.flakyJobs.includes(j)) : true;
                if (onlyFlaky && tries < cfg.maxPipelineRetry) {
                  log(`PR #${pr.number} pipeline ${pl.status} — flake retry ${tries + 1}/${cfg.maxPipelineRetry} [${failedJobs.join(", ") || "?"}]`);
                  forge.prPipelineRetryMark(pr.number);
                  forge.prPipelineRetry(pr.number);
                  await sleepUnlessStopped(POLL_MS, stopNow);
                } else {
                  await healWithBudget(pr.number, "pipeline failing after retries", healBudget(pr.number, async () => {
                    syncBranch(branch);
                    await runGuarded(healOpts(pr.number, branch, issue));
                    forge.prClearChanges(pr.number);
                    syncBranch(branch);
                    log(`re-reviewing #${pr.number}`);
                    await runGuarded(reviewOpts(pr.number, branch, issue));
                  }));
                }
              }
            }
          } else if (pr.reviewState === "CHANGES_REQUESTED") {
            await healWithBudget(pr.number, "CHANGES_REQUESTED", healBudget(pr.number, async () => {
              syncBranch(branch);
              await runGuarded(healOpts(pr.number, branch, issue));
              forge.prClearChanges(pr.number);
              syncBranch(branch);
              if (EXTERNAL) log(`healed #${pr.number}; awaiting external re-review.`);
              else { log(`re-reviewing #${pr.number}`); await runGuarded(reviewOpts(pr.number, branch, issue)); }
            }));
          } else {
            if (EXTERNAL) { log(`PR #${pr.number} awaiting external review.`); await sleepUnlessStopped(POLL_MS, stopNow); }
            else { log(`PR #${pr.number} needs review -> reviewing`); syncBranch(branch); await runGuarded(reviewOpts(pr.number, branch, issue)); }
          }
          break prs; // this PR was this cycle's work
        }
        // Every active PR only had a stale conflict flag: nothing ran, so wait a poll interval
        // for the forge to recompute rather than spinning. (No new dispatch: they're in flight.)
        if (yielded === active.length) {
          log(`all ${yielded} in-flight PR(s) had stale conflict flags — rechecked; sleeping ${cfg.pollMinutes}m`);
          await sleepUnlessStopped(POLL_MS, stopNow);
        }
      } else {
        const next = await pickNextIssue(all, realPickDeps(L.ready, DRY));
        if (next) {
          const n = next.number;
          log(`dispatching #${n}: ${next.title}`);
          sh(`git fetch origin ${cfg.defaultBranch}`);
          // A run killed mid-work (idle timeout, crash) leaves a `wip(#n): checkpoint` commit on
          // its branch; resume from it instead of deleting it, up to maxResume times (#53).
          const kind = await dispatchIssue(n, {
            maxResume: cfg.maxResume,
            hasCheckpoint: () => hasCheckpoint({ issue: n, repo: ROOT, base: cfg.defaultBranch }),
            resumes: () => countResumes(forge.issueComments(n)),
            markResume: (k) => forge.issueComment(n, "--body", JSON.stringify(`${RESUME_MARKER} resuming from checkpoint (${k}/${cfg.maxResume})`)),
            escalate: (k) => {
              log(`#${n} resumed ${k}/${cfg.maxResume} times without finishing -> escalating to ${L.needsHuman}`);
              forge.issueEdit(n, "--add-label", L.needsHuman);
              forge.issueComment(n, "--body", JSON.stringify(`AFK: implement was cut off and resumed from a checkpoint ${k} time(s) (maxResume ${cfg.maxResume}) without opening a PR. The work so far is on \`agent/issue-${n}\`. Parking for a human.`));
            },
            deleteBranch: () => deleteStaleBranch(n),
            keepBranch: () => syncBranch(`agent/issue-${n}`),
            implement: (resume) => runGuarded(implementOpts(n, resume)),
            checkpoint: (err) => checkpointAfterFailure({ issue: n, err, repo: ROOT, identity: requireGitIdentity(cfg.gitIdentity) }),
            log,
          });
          if (kind !== "escalate") log(`opened PR for #${n}`);
        } else {
          if (shouldRunTriage(Date.now(), lastTriageAt, cfg.triageIntervalMinutes * 60_000)) {
            lastTriageAt = Date.now();
            log("idle — running triage pass");
            // The deterministic blocker sweep already ran at the top of this cycle (#47); only
            // the expensive LLM re-evaluation of `needs-feedback` issues (#414) stays idle-gated.
            // Issue-ops only (no PR, no push).
            await runGuarded(triageOpts());
          }
          log(`idle — nothing to do. Sleeping ${cfg.pollMinutes}m.`);
          await sleepUnlessStopped(POLL_MS, stopNow);
        }
      }
    } catch (e) {
      log(`cycle error: ${(e as Error).message}. Sleeping 60s.`);
      await sleepUnlessStopped(60_000, stopNow);
    }
  }
}

// Only run the daemon when this module is the process entry point. Importing it — e.g.
// from the test suite to assert `triageOpts`'s shape — must NOT start the loop.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
