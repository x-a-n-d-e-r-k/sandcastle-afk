import { run, claudeCode, type RunOptions } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { cfg, sh, log, loadAgentRules, phaseRules, reviewAgentEnv, checkReviewCredential, renderPreflight, isSafeRef } from "./config.js";
import * as forge from "./forge-client.js";
import { uiGate, reviewUiBlock } from "./ui.js";
import { isEntryPoint } from "./entry.js";
import { priorFindingsBlock } from "./review-gate.js";

// Review one PR/MR:  pnpm afk:review <number>

// Exported so the prompt-arg parity test (#55) can assert this site's shape without Docker.
export const cliReviewOpts = (pr: number, branch: string, issue: string, prior = ""): RunOptions => ({
  name: `review-${pr}`,
  sandbox: docker({ imageName: cfg.imageName }),
  agent: claudeCode(cfg.models.review, { env: reviewAgentEnv() }),
  promptFile: ".sandcastle/review.md",
  promptArgs: {
    PR_NUMBER: String(pr), ISSUE_NUMBER: issue, AGENT_RULES: phaseRules(loadAgentRules(), cfg.idleTimeoutSeconds),
    UI_VERIFICATION: reviewUiBlock(uiGate(pr, branch, cfg.ui), cfg.ui), PREFLIGHT: renderPreflight(cfg.preflight),
    PRIOR_BLOCKING_FINDINGS: prior, // the previous blocking review to account for (#81)
  },
  branchStrategy: { type: "branch", branch, baseBranch: `origin/${cfg.defaultBranch}` },
  maxIterations: 1,
  hooks: { sandbox: { onSandboxReady: [{ command: cfg.install, timeoutMs: 600_000 }] } },
  logging: { type: "stdout" },
  idleTimeoutSeconds: cfg.idleTimeoutSeconds,
});

async function main(): Promise<void> {
  const PR = process.argv[2];
  if (!PR) { console.error("usage: pnpm afk:review <pr-number>"); process.exit(1); }

  // Same startup guard as the loop: the reviewer credential must be host-only and present (#32).
  checkReviewCredential();

  const pr = forge.prView(Number(PR));
  const branch = pr.headRef;
  // Forge-supplied and interpolated into host `git` below: refuse anything a shell could interpret (#97).
  if (!isSafeRef(branch)) { console.error(`refusing PR #${PR}: unsafe head branch name ${JSON.stringify(branch)}`); process.exit(1); }
  // The branch fallback is a genuine safety net, but it also hides the defect it rescues:
  // a PR whose body lacks a closing keyword reviews and merges green, then leaves its issue
  // open forever. Keep the fallback; make it loud. (forge pr-create now prevents this at the
  // source — the warning covers PRs opened by other means.)
  const bodyMatch = (pr.body || "").match(/(?:closes|fixes|resolves) #(\d+)/i);
  const branchMatch = branch.match(/issue-(\d+)/);
  const issue = bodyMatch?.[1] ?? branchMatch?.[1] ?? "";
  if (!bodyMatch && branchMatch)
    console.warn(`Warning: PR #${PR} body has no closing keyword; derived issue #${issue} from branch '${branch}'. The issue will NOT auto-close on merge.`);
  if (!issue) console.warn("Warning: could not derive issue number from PR body or branch.");

  sh(`git fetch origin ${branch}`);
  sh(`git branch -f ${branch} origin/${branch}`);

  // The re-review is not stateless (#81): show it the latest blocking review and any rebuttal.
  let prior = "";
  try { const gate = forge.prReviewGate(Number(PR)); prior = priorFindingsBlock(gate.blockingBody, gate.rebuttal); }
  catch (e) { console.warn(`Warning: could not read PR #${PR}'s review state (${(e as Error).message.split("\n")[0]}); reviewing without prior findings.`); }
  const r = await run(cliReviewOpts(Number(PR), branch, issue, prior));

  log(`Review run done for PR #${PR} (issue #${issue}): branch ${r.branch}`);
  if (r.completionSignal === undefined)
    console.warn(`Warning: the review of PR #${PR} ended WITHOUT a verdict (no completion signal) — check the PR for an approve / request-changes before trusting it.`);
}

// Only review when run as the entry point — importing (the test suite) must not.
const isMain = isEntryPoint(import.meta.url);
if (isMain) await main();
