import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// The config contract: every afk.config.json key the layer REQUIRES, with its validator (#77).
//
// Side-effect free on purpose. config.ts throws at import when the consumer's config is invalid,
// so `afk:update` can't import it to ask "would this layer accept my config?". This module can be
// loaded against ANY config — including by update.ts, from the layer it is about to install — and
// the loop enforces exactly this list at startup, so update's check and the loop cannot drift.
//
// Adding a required key? Add its validator to CONFIG_CONTRACT (and an example value to
// afk.config.example.json). Optional keys with a default don't belong here.
// ---------------------------------------------------------------------------

export type GitIdentity = { name: string; email: string };

// `maxResume` (#53): no default — the operator chooses how many checkpoint resumes to allow.
export const assertMaxResume = (v: unknown): void => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new Error(
      "afk.config.json needs `maxResume` (a non-negative integer, no default): how many times an " +
      "implement run killed mid-work (e.g. idle timeout) may resume from its checkpoint commit before " +
      "the issue is escalated to a human. Example: \"maxResume\": 2.",
    );
  }
};

// `gitIdentity` (#52): no default on purpose — a silent fallback to the host clone's identity is
// exactly the drift this exists to stop. Throws naming the key to set.
export const requireGitIdentity = (id: Partial<GitIdentity> | undefined): GitIdentity => {
  const name = id?.name?.trim(), email = id?.email?.trim();
  if (!name || !email) {
    throw new Error(
      'afk.config.json needs `gitIdentity: { "name": "...", "email": "..." }` — the single git author ' +
      "for every pushing phase (implement, heal, resolve). Use your implementer bot account, e.g. " +
      '{ "name": "my-dev-bot", "email": "my-dev-bot@users.noreply.github.com" }.',
    );
  }
  return { name, email };
};

type AnyCfg = Record<string, unknown>;

export const CONFIG_CONTRACT: { key: string; check: (cfg: AnyCfg) => void }[] = [
  { key: "maxResume", check: (c) => assertMaxResume(c.maxResume) },
  { key: "gitIdentity", check: (c) => { requireGitIdentity(c.gitIdentity as Partial<GitIdentity> | undefined); } },
];

export type ContractViolation = { key: string; message: string; example?: unknown };

// Run every validator; collect (don't stop at) the failures, each with the example config's value.
export const checkConfig = (cfg: AnyCfg, example: AnyCfg = {}): ContractViolation[] => {
  const out: ContractViolation[] = [];
  for (const { key, check } of CONFIG_CONTRACT) {
    try { check(cfg); }
    catch (e) { out.push({ key, message: (e as Error).message, ...(key in example ? { example: example[key] } : {}) }); }
  }
  return out;
};

// Throw once, naming EVERY violation — the loop's startup check (fixing one key shouldn't just
// expose the next).
export const assertConfigContract = (cfg: AnyCfg): void => {
  const v = checkConfig(cfg);
  if (v.length) throw new Error(`afk.config.json does not satisfy the layer's config contract:\n${v.map((x) => `  - ${x.key}: ${x.message}`).join("\n")}`);
};

// The report afk:update prints, and its exit code. Dry-run reports and exits 0; an apply with
// violations still copies the files but exits non-zero unless --force (the operator must act
// before `afk:loop` will start).
export const formatContractReport = (v: ContractViolation[], mode: "dry-run" | "apply"): string => {
  if (!v.length) return "";
  const head = mode === "dry-run"
    ? "[dry-run] config changes required (your afk.config.json would not satisfy this layer):"
    : "!!! CONFIG ACTION REQUIRED before `afk:loop` — your afk.config.json does not satisfy this layer:";
  const lines = v.map((x) =>
    `  - ${x.key}: ${x.message}${x.example !== undefined ? `\n      example (afk.config.example.json): "${x.key}": ${JSON.stringify(x.example)}` : ""}`);
  return [head, ...lines].join("\n");
};

export const updateExitCode = (v: ContractViolation[], o: { dry: boolean; force: boolean }): number =>
  v.length && !o.dry && !o.force ? 1 : 0;

// CLI, so afk:update can run THE LAYER'S copy of this file against the consumer's config without
// importing anything that loads config:
//   tsx config-contract.ts --check <dry-run|apply> <force:0|1> <afk.config.json> [<example.json>]
//   → stdout: JSON { violations, report, exitCode }  (the process itself always exits 0)
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv[2] === "--check") {
  const [, , , mode, force, cfgPath, examplePath] = process.argv;
  const read = (p?: string): AnyCfg => { try { return p ? JSON.parse(readFileSync(p, "utf8")) : {}; } catch { return {}; } };
  const violations = checkConfig(read(cfgPath), read(examplePath));
  const m = mode === "apply" ? "apply" : "dry-run";
  process.stdout.write(JSON.stringify({
    violations,
    report: formatContractReport(violations, m),
    exitCode: updateExitCode(violations, { dry: m === "dry-run", force: force === "1" }),
  }));
}
