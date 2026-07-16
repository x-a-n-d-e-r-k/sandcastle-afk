import { pathToFileURL } from "node:url";
import { run, claudeCode, type RunOptions, type RunResult } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { cfg, forge, forgeJSON, sh, log, sleep, loadAgentRules, pruneWorktrees, ensureHostOnDefaultBranch } from "./config.js";
import { pickNextIssue, realPickDeps, MINE, issueNumOf } from "./claim.js";
import { shouldRunTriage, sweepBlockedIssues, isIssueClosed, TRIAGE_MARKER } from "./triage.js";
import { shouldStop, stopSentinelExists, clearStopSentinel, sleepUnlessStopped } from "./stop.js";
import { uiGate, implementUiBlock, reviewUiBlock } from "./ui.js";

const RULES = loadAgentRules();

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
const USAGE_PATTERNS = [
  /usage limit/i, /rate limit/i, /\b429\b/, /too many requests/i,
  /quota/i, /overloaded/i, /capacity/i, /resets? (?:at|in)/i, /try again later/i,
];
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
      if (!USAGE_PATTERNS.some((p) => p.test(msg)) || attempt >= MAX_USAGE_WAITS) throw e;
      attempt++;
      const wait = parseResetMs(msg) ?? Math.min(30 * 60_000, 60_000 * 2 ** (attempt - 1));
      log(`usage/rate limit (attempt ${attempt}/${MAX_USAGE_WAITS}); waiting ${Math.round(wait / 60_000)}m then resuming same branch. [${msg.slice(0, 120)}]`);
      await sleep(wait);
    }
  }
}

const baseRun = (name: string, branch: string, promptFile: string, model: string, withPush: boolean): RunOptions => ({
  name,
  sandbox: docker({ imageName: cfg.imageName }),
  agent: claudeCode(model),
  promptFile,
  branchStrategy: { type: "branch", branch, baseBranch: `origin/${cfg.defaultBranch}` },
  maxIterations: 1,
  hooks: {
    sandbox: {
      onSandboxReady: [
        { command: cfg.install, timeoutMs: 600_000 },
        ...(withPush ? [{ command: "forge git-setup" }] : []),
      ],
    },
  },
  logging: { type: "stdout" } as const,
  idleTimeoutSeconds: cfg.idleTimeoutSeconds,
});

const implementOpts = (issue: number): RunOptions => ({
  ...baseRun(`issue-${issue}`, `agent/issue-${issue}`, ".sandcastle/implement.md", cfg.models.implement, true),
  // Not diff-conditional: at implement time the agent hasn't written the code yet, so there is
  // no diff to match. Injected whenever `ui` is configured; the host gate (uiGate) does the
  // conditional enforcement once a diff exists. Empty string when `ui` is unset.
  promptArgs: {
    ISSUE_NUMBER: String(issue), BASE_BRANCH: cfg.defaultBranch, AGENT_RULES: RULES,
    UI_VERIFICATION: implementUiBlock(cfg.ui),
  },
});
const reviewOpts = (pr: number, branch: string, issue: string): RunOptions => ({
  ...baseRun(`review-${pr}`, branch, ".sandcastle/review.md", cfg.models.review, false),
  promptArgs: {
    PR_NUMBER: String(pr), ISSUE_NUMBER: issue, AGENT_RULES: RULES,
    UI_VERIFICATION: reviewUiBlock(uiGate(pr, branch, cfg.ui), cfg.ui),
  },
});
const healOpts = (pr: number, branch: string, issue: string): RunOptions => ({
  ...baseRun(`heal-${pr}`, branch, ".sandcastle/heal.md", cfg.models.heal, true),
  promptArgs: { PR_NUMBER: String(pr), ISSUE_NUMBER: issue, AGENT_RULES: RULES },
});
const resolveConflictsOpts = (pr: number, branch: string, issue: string): RunOptions => ({
  ...baseRun(`resolve-${pr}`, branch, ".sandcastle/resolve-conflicts.md", cfg.models.heal, true),
  promptArgs: { PR_NUMBER: String(pr), ISSUE_NUMBER: issue, BASE_BRANCH: cfg.defaultBranch, AGENT_RULES: RULES },
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

const getAgentPRs = (): PR[] => forgeJSON<PR[]>("pr-list").filter((p) => p.headRef.startsWith("agent/issue-"));
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

function escalate(pr: number, reason = `review requested changes ${MAX_HEAL}x without converging`) {
  forge(`pr-label ${pr} --add-label ${L.needsHuman}`);
  forge(`pr-comment ${pr} --body ${JSON.stringify(`AFK: ${reason}. Parking for a human.`)}`);
}

// Deterministic blocker-sweep backstop, bound to forge. Runs synchronously between
// loop runs (concurrency=1) so it never races a live container. issue-list omits body,
// so we issue-view each blocked issue (and each blocker) for body + closed-state.
function runTriageSweep() {
  const blockedNums = forgeJSON<Issue[]>(`issue-list --label blocked`).map((i) => i.number);
  type Detail = { number: number; body?: string; labels: string[]; state: string };
  const detail = (n: number) => forgeJSON<Detail>(`issue-view ${n}`);
  const promoted = sweepBlockedIssues({
    listBlocked: () => blockedNums.map(detail),
    isClosed: (n) => isIssueClosed(detail(n)),
    promote: (n) => { forge(`issue-edit ${n} --add-label ${L.ready} --remove-label blocked`); },
    hasMarkerComment: (n) => forge(`issue-comments ${n}`).includes(TRIAGE_MARKER),
    comment: (n, body) => { forge(`issue-comment ${n} --body ${JSON.stringify(body)}`); },
  });
  if (promoted.length) log(`triage: promoted ${promoted.length} unblocked issue(s): ${promoted.join(", ")}`);
}

async function main(): Promise<void> {
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
      const all = getAgentPRs();
      // Multi-loop (#8): only drive PRs whose issue THIS clone owns (carries our claim).
      // Query the claim label directly (not the `ready` set) so ownership survives even if
      // `ready` is stripped once a PR opens. Single-loop (MINE === "") leaves it null so
      // isMine is always true and the loop owns every PR (unchanged behavior).
      const ownedIssues = MINE
        ? new Set(forgeJSON<Issue[]>(`issue-list --label ${MINE}`).map((i) => i.number))
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
        const pr = active[0];
        const branch = pr.headRef;
        const issue = branch.match(/issue-(\d+)/)?.[1] ?? "";

        // Conflicts with the base branch block BOTH review and merge, so resolve them
        // first. A sandbox pass merges the base branch in and fixes the markers; capped
        // like heal so a conflict the agent can't resolve escalates to a human instead
        // of wedging the loop (the failure mode that needs manual rescue otherwise). A
        // conflicted PR can't be reviewed or merged, so skip the rest of this cycle.
        if (forge(`pr-has-conflicts ${pr.number}`) === "true") {
          const tries = Number(forge(`pr-conflict-retry-count ${pr.number}`)) || 0;
          if (tries >= MAX_HEAL) {
            log(`PR #${pr.number} conflict-resolve cap (${tries}/${MAX_HEAL}) -> escalating to ${L.needsHuman}`);
            escalate(pr.number, `could not resolve conflicts with ${cfg.defaultBranch} after ${MAX_HEAL} attempts`);
          } else {
            log(`PR #${pr.number} conflicts with ${cfg.defaultBranch} -> resolve ${tries + 1}/${MAX_HEAL}`);
            forge(`pr-conflict-retry-mark ${pr.number}`);
            syncBranch(branch);
            await runGuarded(resolveConflictsOpts(pr.number, branch, issue));
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
            const vg = uiGate(pr.number, branch, cfg.ui);
            if (vg.required && vg.blocked) {
              log(`PR #${pr.number} APPROVED but visual verification is missing -> escalating`);
              escalate(pr.number, vg.reason);
              await sleepUnlessStopped(POLL_MS, stopNow);
              continue;
            }
            const pl = forgeJSON<{ status: string }>(`pr-pipeline ${pr.number}`);
            if (["success", "skipped", "none"].includes(pl.status)) {
              log(`PR #${pr.number} APPROVED, pipeline ${pl.status}${vg.required ? `, ${vg.artifacts.length} screenshot(s)` : ""} -> merging`);
              forge(`pr-merge ${pr.number} --squash --delete-branch --no-auto-merge`);
              log(`merged #${pr.number}`);
            } else if (["running", "pending"].includes(pl.status)) {
              log(`PR #${pr.number} approved; pipeline ${pl.status} — waiting`);
              await sleepUnlessStopped(POLL_MS, stopNow);
            } else {
              // failed | canceled — retry flakes, else heal against the pipeline logs
              const tries = Number(forge(`pr-pipeline-retry-count ${pr.number}`)) || 0;
              const failedJobs = forge(`pr-pipeline-failed-jobs ${pr.number}`).split("\n").map((s) => s.trim()).filter(Boolean);
              const onlyFlaky = cfg.flakyJobs.length ? failedJobs.every((j) => cfg.flakyJobs.includes(j)) : true;
              if (onlyFlaky && tries < cfg.maxPipelineRetry) {
                log(`PR #${pr.number} pipeline ${pl.status} — flake retry ${tries + 1}/${cfg.maxPipelineRetry} [${failedJobs.join(", ") || "?"}]`);
                forge(`pr-pipeline-retry-mark ${pr.number}`);
                forge(`pr-pipeline-retry ${pr.number}`);
                await sleepUnlessStopped(POLL_MS, stopNow);
              } else {
                const heals = Number(forge(`pr-changes-count ${pr.number}`)) || 0;
                if (heals >= MAX_HEAL) {
                  log(`PR #${pr.number} heal cap (${heals}/${MAX_HEAL}) -> escalating`);
                  escalate(pr.number);
                } else {
                  log(`PR #${pr.number} pipeline failing after retries -> heal ${heals + 1}/${MAX_HEAL}`);
                  syncBranch(branch);
                  await runGuarded(healOpts(pr.number, branch, issue));
                  forge(`pr-clear-changes ${pr.number}`);
                  syncBranch(branch);
                  log(`re-reviewing #${pr.number}`);
                  await runGuarded(reviewOpts(pr.number, branch, issue));
                }
              }
            }
          }
        } else if (pr.reviewState === "CHANGES_REQUESTED") {
          const heals = Number(forge(`pr-changes-count ${pr.number}`)) || 0;
          if (heals >= MAX_HEAL) {
            log(`PR #${pr.number} heal cap (${heals}/${MAX_HEAL}) -> escalating to ${L.needsHuman}`);
            escalate(pr.number);
          } else {
            log(`PR #${pr.number} CHANGES_REQUESTED -> heal ${heals + 1}/${MAX_HEAL}`);
            syncBranch(branch);
            await runGuarded(healOpts(pr.number, branch, issue));
            forge(`pr-clear-changes ${pr.number}`);
            syncBranch(branch);
            if (EXTERNAL) log(`healed #${pr.number}; awaiting external re-review.`);
            else { log(`re-reviewing #${pr.number}`); await runGuarded(reviewOpts(pr.number, branch, issue)); }
          }
        } else {
          if (EXTERNAL) { log(`PR #${pr.number} awaiting external review.`); await sleepUnlessStopped(POLL_MS, stopNow); }
          else { log(`PR #${pr.number} needs review -> reviewing`); syncBranch(branch); await runGuarded(reviewOpts(pr.number, branch, issue)); }
        }
      } else {
        const next = await pickNextIssue(all, realPickDeps(L.ready, DRY));
        if (next) {
          log(`dispatching #${next.number}: ${next.title}`);
          sh(`git fetch origin ${cfg.defaultBranch}`);
          deleteStaleBranch(next.number);
          await runGuarded(implementOpts(next.number));
          log(`opened PR for #${next.number}`);
        } else {
          if (shouldRunTriage(Date.now(), lastTriageAt, cfg.triageIntervalMinutes * 60_000)) {
            lastTriageAt = Date.now();
            log("idle — running triage pass");
            runTriageSweep();
            // LLM re-evaluation of `needs-feedback` issues (#414). Runs after the
            // deterministic blocker sweep; issue-ops only (no PR, no push).
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
