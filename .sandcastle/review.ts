import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { cfg, forgeJSON, sh, log, loadAgentRules } from "./config.js";

// Review one PR/MR:  pnpm afk:review <number>
const PR = process.argv[2];
if (!PR) { console.error("usage: pnpm afk:review <pr-number>"); process.exit(1); }

const pr = forgeJSON<{ number: number; headRef: string; body: string }>(`pr-view ${PR}`);
const branch = pr.headRef;
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

const r = await run({
  name: `review-${PR}`,
  sandbox: docker({ imageName: cfg.imageName }),
  agent: claudeCode(cfg.models.review),
  promptFile: ".sandcastle/review.md",
  promptArgs: { PR_NUMBER: PR, ISSUE_NUMBER: issue, AGENT_RULES: loadAgentRules() },
  branchStrategy: { type: "branch", branch, baseBranch: `origin/${cfg.defaultBranch}` },
  maxIterations: 1,
  hooks: { sandbox: { onSandboxReady: [{ command: cfg.install, timeoutMs: 600_000 }] } },
  logging: { type: "stdout" },
  idleTimeoutSeconds: cfg.idleTimeoutSeconds,
});

log(`Review run done for PR #${PR} (issue #${issue}): branch ${r.branch}`);
