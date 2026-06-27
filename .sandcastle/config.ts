import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Repo root, resolved from this file at .sandcastle/config.ts
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Host env-autoload (#8). LOOP_ID and friends live in .sandcastle/.env, which upstream
// only injects into the Docker sandbox — never the HOST daemon (loop.ts) that reads
// LOOP_ID. Load it here so host-side code sees those vars. `loadEnvFile` (Node ≥20.12)
// does NOT override already-set vars, so an explicit `export LOOP_ID=` still wins.
const ENV_FILE = join(ROOT, ".sandcastle", ".env");
const loadEnvFile = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
if (existsSync(ENV_FILE) && typeof loadEnvFile === "function") {
  try { loadEnvFile(ENV_FILE); } catch { /* malformed .env — keep ambient env */ }
}

// Per-clone loop identity for concurrent backlog claiming (#8). Unset => single-loop
// mode (no claims, owns everything — today's behavior). The full claim label is
// `working:<LOOP_ID>`; `working` (the base) folds into the pickup-exclusion set below.
export const LOOP_ID = (process.env.LOOP_ID ?? "").trim();
export const WORKING = "working";

const CONFIG_PATH = join(ROOT, "afk.config.json");

if (!existsSync(CONFIG_PATH)) {
  throw new Error("afk.config.json not found at repo root — run `pnpm afk:init` first.");
}

export type Cfg = {
  platform: "github" | "gitlab";
  reviewMode: "internal" | "external";
  defaultBranch: string;
  packageManager: string;
  packageManagerVersion: string;
  dockerBaseImage: string;
  install: string;
  preflight: string[];
  e2e: string;
  imageName: string;
  models: { implement: string; review: string; heal: string; triage: string };
  labels: {
    ready: string;
    needsFeedback: string;
    epic: string;
    idea: string;
    needsHuman: string;
    e2eRegression: string;
  };
  maxHeal: number;
  maxPipelineRetry: number;
  flakyJobs: string[];
  priorityLabels: string[];
  agentRules: string[];
  pollMinutes: number;
  idleTimeoutSeconds: number;
  triageIntervalMinutes: number;
};

export const cfg: Cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

const FORGE = join(ROOT, "bin", "forge");

export const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Host-side git helper (runs in the repo root by default).
export const sh = (c: string, cwd: string = ROOT) => execSync(c, { encoding: "utf8", cwd }).trim();

// Worktrees that live under .sandcastle/worktrees/ are sandcastle's own. Parse
// them out of `git worktree list --porcelain`. Exported for testing the
// leak-removal logic without touching a live repo.
export const parseSandcastleWorktrees = (porcelain: string): string[] =>
  porcelain
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim())
    .filter((p) => p.includes("/.sandcastle/worktrees/"));

// Clear leftover sandcastle worktrees before any host branch op. Two distinct leaks:
//
//   (a) DIR-GONE — a torn-down sandbox container leaves an orphaned entry whose
//       working dir (the container's /home/agent/workspace) is gone. `git worktree
//       prune` drops these.
//   (b) DIR-PRESENT — a run interrupted during sandbox setup (Ctrl-C / crash)
//       leaves a fully present HOST worktree at .sandcastle/worktrees/agent-issue-N
//       with the agent branch checked out. prune CANNOT clear it (the dir still
//       exists), so that checked-out branch makes `git branch -f`/`git branch -D`
//       fail ("cannot force update/delete the branch ... used by worktree") and
//       wedges syncBranch/deleteStaleBranch every cycle — the loop then errors and
//       sleeps 60s forever. This was the gap behind the recurring blocker.
//
// At concurrency=1 the loop only touches host git between its own container runs,
// so no sandcastle worktree is ever legitimately live here — force-remove any that
// remain (unlock first if git reports it locked). Safe: the agent's real work lives
// on its pushed branch / PR; the worktree is a disposable local checkout.
export const pruneWorktrees = (run: (c: string) => string = sh) => {
  try {
    run("git worktree prune"); // (a) dir-gone
    for (const p of parseSandcastleWorktrees(run("git worktree list --porcelain"))) {
      log(`removing leaked sandcastle worktree ${p}`);
      try {
        run(`git worktree remove --force ${JSON.stringify(p)}`); // (b) dir-present
      } catch {
        try { run(`git worktree unlock ${JSON.stringify(p)}`); } catch {}
        try { run(`git worktree remove --force ${JSON.stringify(p)}`); }
        catch (e) { log(`could not remove leaked worktree ${p}: ${(e as Error).message}`); }
      }
    }
    run("git worktree prune"); // drop any entry left dangling by the removals
  } catch {}
};

// Defensive: an interrupted sandbox run can leave the HOST repo checked out on an agent
// branch (often with a half-applied dirty tree). Then `git branch -f`/`git branch -D` on
// that branch fail ("cannot force update/delete the current branch") and the loop wedges
// every cycle — prune can't help because the worktree exists. The loop only touches host
// git between its own container-isolated runs, so the host should always be on
// defaultBranch here; snap it back (force, discarding the junk tree) if not. The agent's
// real work lives on its pushed branch / PR, so discarding the host working tree is safe.
export const ensureHostOnDefaultBranch = () => {
  try {
    if (sh("git rev-parse --abbrev-ref HEAD") !== cfg.defaultBranch) {
      log(`host repo not on ${cfg.defaultBranch} — resetting (work is safe on the pushed branch/PR)`);
      sh(`git checkout -f ${cfg.defaultBranch}`);
    }
  } catch (e) {
    log(`ensureHostOnDefaultBranch failed: ${(e as Error).message}`);
  }
};

// All forge calls go through here. `tokenEnv` lets a single call use a
// different identity (e.g. the reviewer): forge("pr-approve 5", { GH_TOKEN: reviewToken }).
export const forge = (args: string, tokenEnv: Record<string, string> = {}): string =>
  execSync(`${JSON.stringify(FORGE)} ${args}`, {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env, FORGE_PLATFORM: cfg.platform, ...tokenEnv },
  }).trim();

export const forgeJSON = <T = any>(args: string, tokenEnv: Record<string, string> = {}): T =>
  JSON.parse(forge(args, tokenEnv) || "null");

// The exclusion set for issue dispatch (supports "epic:foo" sub-labels too).
// Priority: an ordered list, most-urgent first (e.g. highest, high, low, lowest).
// An issue with none of these labels ranks at the MIDPOINT (between the upper and lower halves).
const PRI = cfg.priorityLabels ?? [];
const MIDRANK = PRI.length ? (PRI.length - 1) / 2 : 0;
export const priorityRank = (labels: string[]): number => {
  const i = PRI.findIndex((p) => labels.includes(p));
  return i === -1 ? MIDRANK : i;
};

// House rules injected into every agent prompt. Resolved from cfg.agentRules
// (paths/URLs) into .sandcastle/agent-rules.md by `pnpm afk:rules` / `afk:init`;
// this just reads the cache (no network at run time). Empty -> "" (no-op).
export const loadAgentRules = (): string => {
  const p = join(ROOT, ".sandcastle", "agent-rules.md");
  if (!existsSync(p)) return "";
  const text = readFileSync(p, "utf8").trim();
  return text ? `# House rules (follow these in addition to the task)\n\n${text}\n` : "";
};

// `working` is included so a claimed issue (`working` or any `working:<id>` sub-label) is
// skipped on fresh pickup — its owning loop resumes it via the claim path, not here.
export const EXCLUDE_LABELS = [cfg.labels.epic, cfg.labels.idea, cfg.labels.needsFeedback, cfg.labels.needsHuman, WORKING];
export const isExcluded = (labels: string[]) =>
  labels.some((l) => EXCLUDE_LABELS.some((x) => l === x || l.startsWith(`${x}:`)));
