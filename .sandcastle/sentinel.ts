import { execSync } from "node:child_process";
import { cfg, forge, forgeJSON, sh, log, ROOT } from "./config.js";

// ---------------------------------------------------------------------------
// e2e quality sentinel (out-of-band, scheduled — NOT part of the loop).
//   pnpm afk:sentinel
//
// Tests fresh origin/<defaultBranch> in an isolated worktree, applies a flake
// guard, and files DEDUPED agent-ready issues for genuine regressions. The loop
// then fixes them like any other work. Disabled if cfg.e2e is "".
//
// Schedule via your OS, e.g. twice daily:
//   0 7,19 * * *  cd /path/to/repo && pnpm afk:sentinel >> ~/afk-sentinel.log 2>&1
// ---------------------------------------------------------------------------

if (!cfg.e2e) { console.log("cfg.e2e is empty — sentinel disabled."); process.exit(0); }

const WT = ".sandcastle/e2e-worktree";
const N_RERUN = 3;
const FAIL_THRESHOLD = 2;
const shSafe = (c: string, cwd?: string) => {
  try { return execSync(c, { encoding: "utf8", cwd, stdio: ["pipe", "pipe", "pipe"] }).trim(); }
  catch (e) { return ((e as { stdout?: string }).stdout ?? "").toString(); }
};

type Failure = { file: string; title: string };

// === ADAPT-POINT: e2e runner + failure parser =============================
// Defaults to Playwright's JSON reporter. If your e2e tool differs, change
// runE2E()/parseFailures() to emit { file, title } for each failing test.
function parseFailures(json: string): Failure[] {
  const out: Failure[] = [];
  let report: any; try { report = JSON.parse(json); } catch { return out; }
  const walk = (suite: any, file: string) => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      const failed = (spec.tests ?? []).some((t: any) =>
        (t.results ?? []).some((r: any) => r.status !== "passed" && r.status !== "skipped"));
      if (failed) out.push({ file: f, title: spec.title });
    }
    for (const child of suite.suites ?? []) walk(child, f);
  };
  for (const s of report.suites ?? []) walk(s, s.file ?? "");
  return out;
}
function runE2E(grep?: string): Failure[] {
  const g = grep ? ` -g ${JSON.stringify(grep)}` : "";
  return parseFailures(shSafe(`${cfg.e2e} --reporter=json${g}`, `${ROOT}/${WT}`));
}
// ==========================================================================

function existingIssue(f: Failure): boolean {
  const marker = `[e2e] ${f.title}`;
  try {
    const hits = forgeJSON<{ title: string }[]>(`issue-list --label ${cfg.labels.e2eRegression}`);
    return hits.some((i) => i.title.includes(marker));
  } catch { return false; }
}

function fileIssue(f: Failure) {
  const title = `[e2e] ${f.title}`;
  const gates = cfg.preflight.map((c) => `\`${c}\``).join(", ");
  const body = [
    `## e2e regression (detected by the sentinel on \`${cfg.defaultBranch}\`)`,
    ``, `**Spec:** \`${f.file}\``, `**Test:** ${f.title}`,
    `Reproduced ${FAIL_THRESHOLD}+ of ${N_RERUN} re-runs (not a flake).`,
    ``, `## Acceptance criteria`,
    `- [ ] The e2e test \`${f.title}\` passes reliably; the fix addresses the root cause.`,
    ``, `## Gates (for the implementing agent)`,
    `Before opening the PR, all must be green: ${gates}, plus \`${cfg.e2e}\` for the affected spec. PR body must contain \`Closes #<this issue>\`.`,
  ].join("\n");
  const tmp = `${ROOT}/.sandcastle/.sentinel-issue.md`;
  sh(`cat > ${JSON.stringify(tmp)} <<'AFKEOF'\n${body}\nAFKEOF`);
  const url = forge(`issue-create --title ${JSON.stringify(title)} --label ${cfg.labels.ready} --label ${cfg.labels.e2eRegression} --body-file ${JSON.stringify(tmp)}`);
  sh(`rm -f ${JSON.stringify(tmp)}`);
  log(`filed: ${url}`);
}

log(`e2e sentinel: testing fresh origin/${cfg.defaultBranch} in an isolated worktree.`);
sh(`git fetch origin ${cfg.defaultBranch}`);
shSafe(`git worktree remove --force ${WT}`, ROOT);
sh(`git worktree add --detach ${WT} origin/${cfg.defaultBranch}`);
try {
  sh(cfg.install, `${ROOT}/${WT}`);
  const failures = runE2E();
  if (failures.length === 0) { log("e2e GREEN. Nothing to file."); }
  else {
    log(`initial: ${failures.length} failing spec(s). Flake guard (${N_RERUN}x).`);
    const confirmed: Failure[] = [];
    for (const f of failures) {
      let fails = 0;
      for (let i = 0; i < N_RERUN; i++) if (runE2E(f.title).some((x) => x.title === f.title)) fails++;
      log(`  ${f.title}: ${fails}/${N_RERUN}`);
      if (fails >= FAIL_THRESHOLD) confirmed.push(f);
    }
    for (const f of confirmed) existingIssue(f) ? log(`already tracked: ${f.title}`) : fileIssue(f);
    log(`done: ${confirmed.length} confirmed, ${failures.length - confirmed.length} flake(s).`);
  }
} finally {
  shSafe(`git worktree remove --force ${WT}`, ROOT);
  sh(`git worktree prune`);
}
