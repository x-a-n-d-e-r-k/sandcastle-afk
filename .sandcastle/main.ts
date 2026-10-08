import { run, claudeCode, type RunOptions } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { cfg, sh, log, isExcluded, priorityRank, loadAgentRules, phaseRules, renderPreflight, requireGitIdentity, gitSetupCommand, isAgentBranch, shq } from "./config.js";
import * as forge from "./forge-client.js";
import { implementUiBlock } from "./ui.js";
import { isEntryPoint } from "./entry.js";

// Single dispatch: implement the next eligible agent-ready issue -> open a PR.
//   pnpm afk        (loops? no — use `pnpm afk:loop` for continuous)

// Exported so the prompt-arg parity test (#55) can assert this site's shape without Docker.
export const mainImplementOpts = (issue: number): RunOptions => ({
  name: `issue-${issue}`,
  sandbox: docker({ imageName: cfg.imageName }),
  agent: claudeCode(cfg.models.implement),
  promptFile: ".sandcastle/implement.md",
  promptArgs: {
    ISSUE_NUMBER: String(issue), BASE_BRANCH: cfg.defaultBranch, AGENT_RULES: phaseRules(loadAgentRules(), cfg.idleTimeoutSeconds), RESUME: "",
    UI_VERIFICATION: implementUiBlock(cfg.ui), PREFLIGHT: renderPreflight(cfg.preflight),
  },
  branchStrategy: { type: "branch", branch: `agent/issue-${issue}`, baseBranch: `origin/${cfg.defaultBranch}` },
  maxIterations: 1,
  hooks: { sandbox: { onSandboxReady: [{ command: cfg.install, timeoutMs: 600_000 }, { command: gitSetupCommand(requireGitIdentity(cfg.gitIdentity)) }] } },
  logging: { type: "stdout" },
  idleTimeoutSeconds: cfg.idleTimeoutSeconds,
});

async function main(): Promise<void> {
  const issues = forge.issueList("--label", cfg.labels.ready);
  const openHeads = new Set(
    forge.prList().filter((p) => isAgentBranch(p.headRef)).map((p) => p.headRef),
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
  sh(`git fetch origin ${shq(cfg.defaultBranch)}`);

  const r = await run(mainImplementOpts(next.number));

  console.log(`\nDone #${next.number}: branch ${r.branch}, commits ${r.commits.length}`);
}

// Only dispatch when run as the entry point — importing (the test suite) must not.
const isMain = isEntryPoint(import.meta.url);
if (isMain) await main();
