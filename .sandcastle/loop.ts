import { run, claudeCode, type RunOptions, type RunResult } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { cfg, forge, forgeJSON, sh, log, sleep, isExcluded } from "./config.js";

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
  promptArgs: { ISSUE_NUMBER: String(issue), BASE_BRANCH: cfg.defaultBranch },
});
const reviewOpts = (pr: number, branch: string, issue: string): RunOptions => ({
  ...baseRun(`review-${pr}`, branch, ".sandcastle/review.md", cfg.models.review, false),
  promptArgs: { PR_NUMBER: String(pr), ISSUE_NUMBER: issue },
});
const healOpts = (pr: number, branch: string, issue: string): RunOptions => ({
  ...baseRun(`heal-${pr}`, branch, ".sandcastle/heal.md", cfg.models.heal, true),
  promptArgs: { PR_NUMBER: String(pr), ISSUE_NUMBER: issue },
});

const getAgentPRs = (): PR[] => forgeJSON<PR[]>("pr-list").filter((p) => p.headRef.startsWith("agent/issue-"));
const syncBranch = (b: string) => { sh(`git fetch origin ${b}`); sh(`git branch -f ${b} origin/${b}`); };

// A leftover `agent/issue-N` branch (from a failed/incomplete dispatch) gets REUSED by
// Sandcastle at its old tip instead of being recreated from fresh `main` — so every
// retry checks out stale code and fails identically. Delete it before a fresh dispatch.
// Safe: we only dispatch issues with no open PR and no closed-unmerged PR (see pickNextIssue).
function deleteStaleBranch(issue: number) {
  const b = `agent/issue-${issue}`;
  try { if (sh(`git ls-remote --heads origin ${b}`)) { log(`deleting stale ${b}`); sh(`git push origin --delete ${b}`); } } catch {}
  try { sh(`git branch -D ${b}`); } catch {}
}

function escalate(pr: number) {
  forge(`pr-label ${pr} --add-label ${L.needsHuman}`);
  forge(`pr-comment ${pr} --body ${JSON.stringify(`AFK: review requested changes ${MAX_HEAL}x without converging. Parking for a human.`)}`);
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
      return s(a.title) - s(b.title) || a.number - b.number;
    })[0];
}

log(`AFK loop starting (concurrency 1, platform ${cfg.platform}, review ${cfg.reviewMode}${DRY ? ", DRY-RUN" : ""}). Ctrl-C to stop.`);
while (true) {
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

      if (pr.reviewState === "APPROVED") {
        if (EXTERNAL) { log(`PR #${pr.number} APPROVED — awaiting external merge.`); await sleep(POLL_MS); }
        else {
          const pl = forgeJSON<{ status: string }>(`pr-pipeline ${pr.number}`);
          if (["success", "skipped", "none"].includes(pl.status)) {
            log(`PR #${pr.number} APPROVED, pipeline ${pl.status} -> merging`);
            forge(`pr-merge ${pr.number} --squash --delete-branch --no-auto-merge`);
            log(`merged #${pr.number}`);
          } else if (["running", "pending"].includes(pl.status)) {
            log(`PR #${pr.number} approved; pipeline ${pl.status} — waiting`);
            await sleep(POLL_MS);
          } else {
            // failed | canceled — retry flakes, else heal against the pipeline logs
            const tries = Number(forge(`pr-pipeline-retry-count ${pr.number}`)) || 0;
            const failedJobs = forge(`pr-pipeline-failed-jobs ${pr.number}`).split("\n").map((s) => s.trim()).filter(Boolean);
            const onlyFlaky = cfg.flakyJobs.length ? failedJobs.every((j) => cfg.flakyJobs.includes(j)) : true;
            if (onlyFlaky && tries < cfg.maxPipelineRetry) {
              log(`PR #${pr.number} pipeline ${pl.status} — flake retry ${tries + 1}/${cfg.maxPipelineRetry} [${failedJobs.join(", ") || "?"}]`);
              forge(`pr-pipeline-retry-mark ${pr.number}`);
              forge(`pr-pipeline-retry ${pr.number}`);
              await sleep(POLL_MS);
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
        if (EXTERNAL) { log(`PR #${pr.number} awaiting external review.`); await sleep(POLL_MS); }
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
        await sleep(POLL_MS);
      }
    }
  } catch (e) {
    log(`cycle error: ${(e as Error).message}. Sleeping 60s.`);
    await sleep(60_000);
  }
}
