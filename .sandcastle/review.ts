import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { cfg, forgeJSON, sh, log, loadAgentRules } from "./config.js";

// Review one PR/MR:  pnpm afk:review <number>
const PR = process.argv[2];
if (!PR) { console.error("usage: pnpm afk:review <pr-number>"); process.exit(1); }

const pr = forgeJSON<{ number: number; headRef: string; body: string }>(`pr-view ${PR}`);
const branch = pr.headRef;
const m = (pr.body || "").match(/closes #(\d+)/i) ?? branch.match(/issue-(\d+)/);
const issue = m ? m[1] : "";
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
