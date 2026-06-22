import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Repo root, resolved from this file at .sandcastle/config.ts
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(ROOT, "afk.config.json");

if (!existsSync(CONFIG_PATH)) {
  throw new Error("afk.config.json not found at repo root — run `pnpm afk:init` first.");
}

export type Cfg = {
  platform: "github" | "gitlab";
  defaultBranch: string;
  packageManager: string;
  packageManagerVersion: string;
  dockerBaseImage: string;
  install: string;
  preflight: string[];
  e2e: string;
  imageName: string;
  models: { implement: string; review: string; heal: string };
  labels: {
    ready: string;
    needsFeedback: string;
    epic: string;
    idea: string;
    needsHuman: string;
    e2eRegression: string;
  };
  maxHeal: number;
  pollMinutes: number;
  idleTimeoutSeconds: number;
};

export const cfg: Cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

const FORGE = join(ROOT, "bin", "forge");

export const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Host-side git helper (runs in the repo root by default).
export const sh = (c: string, cwd: string = ROOT) => execSync(c, { encoding: "utf8", cwd }).trim();

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
export const EXCLUDE_LABELS = [cfg.labels.epic, cfg.labels.idea, cfg.labels.needsFeedback, cfg.labels.needsHuman];
export const isExcluded = (labels: string[]) =>
  labels.some((l) => EXCLUDE_LABELS.some((x) => l === x || l.startsWith(`${x}:`)));
