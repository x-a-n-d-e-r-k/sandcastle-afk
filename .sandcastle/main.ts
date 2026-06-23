import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { cfg, forgeJSON, sh, log, isExcluded, priorityRank, loadAgentRules } from "./config.js";

// Single dispatch: implement the next eligible agent-ready issue -> open a PR.
//   pnpm afk        (loops? no — use `pnpm afk:loop` for continuous)
type Issue = { number: number; title: string; labels: string[] };
type PR = { number: number; headRef: string; labels: string[] };

const issues = forgeJSON<Issue[]>(`issue-list --label ${cfg.labels.ready}`);
const openHeads = new Set(
  forgeJSON<PR[]>("pr-list").filter((p) => p.headRef.startsWith("agent/issue-")).map((p) => p.headRef),
);
const next = issues
  .filter((i) => !isExcluded(i.labels))
  .filter((i) => !openHeads.has(`agent/issue-${i.number}`))
  .sort((a, b) => {
    const s = (t: string) => (/^fix/i.test(t) ? 0 : 1);
    return priorityRank(a.labels) - priorityRank(b.labels) || s(a.title) - s(b.title) || a.number - b.number;
  })[0];

if (!next) {
  console.log("No eligible agent-ready issues (none open, or all have an open PR). Nothing to do.");
  process.exit(0);
}

log(`Dispatching #${next.number}: ${next.title}`);
sh(`git fetch origin ${cfg.defaultBranch}`);

const r = await run({
  name: `issue-${next.number}`,
  sandbox: docker({ imageName: cfg.imageName }),
  agent: claudeCode(cfg.models.implement),
  promptFile: ".sandcastle/implement.md",
  promptArgs: { ISSUE_NUMBER: String(next.number), BASE_BRANCH: cfg.defaultBranch, AGENT_RULES: loadAgentRules() },
  branchStrategy: { type: "branch", branch: `agent/issue-${next.number}`, baseBranch: `origin/${cfg.defaultBranch}` },
  maxIterations: 1,
  hooks: { sandbox: { onSandboxReady: [{ command: cfg.install, timeoutMs: 600_000 }, { command: "forge git-setup" }] } },
  logging: { type: "stdout" },
  idleTimeoutSeconds: cfg.idleTimeoutSeconds,
});

console.log(`\nDone #${next.number}: branch ${r.branch}, commits ${r.commits.length}`);
