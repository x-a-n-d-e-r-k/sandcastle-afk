import { run, claudeCode, type RunOptions, type RunResult } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { cfg, forge, forgeJSON, sh, log, sleep, isExcluded, priorityRank, loadAgentRules, ROOT } from "./config.js";

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

// --- graceful shutdown ------------------------------------------------------
// First Ctrl-C requests a clean stop: the in-flight step finishes, then the loop
// exits at the top of the next iteration. A second Ctrl-C forces an immediate
// exit. An in-progress sleep is cut short so an idle/waiting loop stops promptly
// (a sandbox run in progress still finishes — Ctrl-C twice to interrupt that).
let stopRequested = false;
let wakeFromSleep: (() => void) | null = null;
process.on("SIGINT", () => {
  if (stopRequested) { log("forcing exit (second Ctrl-C)."); process.exit(130); }
  stopRequested = true;
  log("stop requested — finishing the current step, then exiting. Ctrl-C again to force.");
  wakeFromSleep?.();
});
// Stop-aware sleep: resolves on timeout OR immediately when a stop is requested.
const napUntilWork = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(() => { wakeFromSleep = null; resolve(); }, ms);
    wakeFromSleep = () => { clearTimeout(t); wakeFromSleep = null; resolve(); };
  });

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
  promptArgs: { ISSUE_NUMBER: String(issue), BASE_BRANCH: cfg.defaultBranch, AGENT_RULES: RULES },
});
const reviewOpts = (pr: number, branch: string, issue: string): RunOptions => ({
  ...baseRun(`review-${pr}`, branch, ".sandcastle/review.md", cfg.models.review, false),
  promptArgs: { PR_NUMBER: String(pr), ISSUE_NUMBER: issue, AGENT_RULES: RULES },
});
const healOpts = (pr: number, branch: string, issue: string): RunOptions => ({
  ...baseRun(`heal-${pr}`, branch, ".sandcastle/heal.md", cfg.models.heal, true),
  promptArgs: { PR_NUMBER: String(pr), ISSUE_NUMBER: issue, AGENT_RULES: RULES },
});
const resolveConflictsOpts = (pr: number, branch: string, issue: string): RunOptions => ({
  ...baseRun(`resolve-${pr}`, branch, ".sandcastle/resolve-conflicts.md", cfg.models.heal, true),
  promptArgs: { PR_NUMBER: String(pr), ISSUE_NUMBER: issue, BASE_BRANCH: cfg.defaultBranch, AGENT_RULES: RULES },
});

const getAgentPRs = (): PR[] => forgeJSON<PR[]>("pr-list").filter((p) => p.headRef.startsWith("agent/issue-"));
// A leftover sandbox worktree holding this branch (e.g. from a hard second
// Ctrl-C mid-run) makes `git branch -f` fail and wedges the loop in a 60s error
// cycle. Remove any such worktree first so the loop self-heals. Best-effort.
function removeWorktreeFor(b: string) {
  try {
    for (const blk of sh(`git worktree list --porcelain`).split("\n\n")) {
      if (blk.includes(`branch refs/heads/${b}`)) {
        const p = blk.split("\n")[0].replace(/^worktree /, "").trim();
        if (p && p !== ROOT) { log(`clearing leftover worktree for ${b}: ${p}`); sh(`git worktree remove --force ${JSON.stringify(p)}`); }
      }
    }
  } catch { /* best-effort */ }
}
const syncBranch = (b: string) => { sh(`git fetch origin ${b}`); removeWorktreeFor(b); sh(`git branch -f ${b} origin/${b}`); };

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

function pickNextIssue(allPRs: PR[]): Issue | undefined {
  const issues = forgeJSON<Issue[]>(`issue-list --label ${L.ready}`);
  const openHeads = new Set(allPRs.map((p) => p.headRef));
  // A closed-but-unmerged PR means its issue was rejected by closing — don't re-dispatch it.
  const rejected = new Set(
    forgeJSON<PR[]>("pr-list --state closed")
      .filter((p) => !p.merged && p.headRef.startsWith("agent/issue-"))
      .map((p) => p.headRef),
  );
  return issues
    .filter((i) => !isExcluded(i.labels))
    .filter((i) => !openHeads.has(`agent/issue-${i.number}`))
    .filter((i) => !rejected.has(`agent/issue-${i.number}`))
    .sort((a, b) => {
      const s = (t: string) => (/^fix/i.test(t) ? 0 : 1);
      return priorityRank(a.labels) - priorityRank(b.labels) || s(a.title) - s(b.title) || a.number - b.number;
    })[0];
}

log(`AFK loop starting (concurrency 1, platform ${cfg.platform}, review ${cfg.reviewMode}${DRY ? ", DRY-RUN" : ""}). Ctrl-C to stop.`);
while (true) {
  if (stopRequested) { log("stopped cleanly."); process.exit(0); }
  try {
    sh(`git fetch origin ${cfg.defaultBranch}`);
    const all = getAgentPRs();
    const active = all.filter((p) => !p.labels.includes(L.needsHuman));

    if (DRY) {
      if (active.length) { const pr = active[0]; log(`DRY: in-flight PR #${pr.number} (${pr.headRef}) state=${pr.reviewState}`); }
      else { const n = pickNextIssue(all); log(n ? `DRY: would dispatch #${n.number}: ${n.title}` : "DRY: idle"); }
      process.exit(0);
    }

    if (active.length) {
      const pr = active[0];
      const branch = pr.headRef;
      const issue = branch.match(/issue-(\d+)/)?.[1] ?? "";

      // Conflicts with the base branch block BOTH review and merge, so resolve them
      // first. A sandbox pass merges the base branch in and fixes the markers; capped
      // like heal so a conflict the agent can't resolve escalates to a human instead
      // of wedging the loop (the failure mode that needs manual rescue otherwise).
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
        if (EXTERNAL) { log(`PR #${pr.number} APPROVED — awaiting external merge.`); await napUntilWork(POLL_MS); }
        else {
          const pl = forgeJSON<{ status: string }>(`pr-pipeline ${pr.number}`);
          if (["success", "skipped", "none"].includes(pl.status)) {
            log(`PR #${pr.number} APPROVED, pipeline ${pl.status} -> merging`);
            forge(`pr-merge ${pr.number} --squash --delete-branch --no-auto-merge`);
            log(`merged #${pr.number}`);
          } else if (["running", "pending"].includes(pl.status)) {
            log(`PR #${pr.number} approved; pipeline ${pl.status} — waiting`);
            await napUntilWork(POLL_MS);
          } else {
            // failed | canceled — retry flakes, else heal against the pipeline logs
            const tries = Number(forge(`pr-pipeline-retry-count ${pr.number}`)) || 0;
            const failedJobs = forge(`pr-pipeline-failed-jobs ${pr.number}`).split("\n").map((s) => s.trim()).filter(Boolean);
            const onlyFlaky = cfg.flakyJobs.length ? failedJobs.every((j) => cfg.flakyJobs.includes(j)) : true;
            if (onlyFlaky && tries < cfg.maxPipelineRetry) {
              log(`PR #${pr.number} pipeline ${pl.status} — flake retry ${tries + 1}/${cfg.maxPipelineRetry} [${failedJobs.join(", ") || "?"}]`);
              forge(`pr-pipeline-retry-mark ${pr.number}`);
              forge(`pr-pipeline-retry ${pr.number}`);
              await napUntilWork(POLL_MS);
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
        if (EXTERNAL) { log(`PR #${pr.number} awaiting external review.`); await napUntilWork(POLL_MS); }
        else { log(`PR #${pr.number} needs review -> reviewing`); syncBranch(branch); await runGuarded(reviewOpts(pr.number, branch, issue)); }
      }
    } else {
      const next = pickNextIssue(all);
      if (next) {
        log(`dispatching #${next.number}: ${next.title}`);
        sh(`git fetch origin ${cfg.defaultBranch}`);
        deleteStaleBranch(next.number);
        await runGuarded(implementOpts(next.number));
        log(`opened PR for #${next.number}`);
      } else {
        log(`idle — nothing to do. Sleeping ${cfg.pollMinutes}m.`);
        await napUntilWork(POLL_MS);
      }
    }
  } catch (e) {
    log(`cycle error: ${(e as Error).message}. Sleeping 60s.`);
    await napUntilWork(60_000);
  }
}
