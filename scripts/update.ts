import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync, chmodSync, rmSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// pnpm afk:update [--dry-run] [--base-latest] [--from <url|path>] [--force]
//   Pulls layer (sandcastle-afk) updates into THIS project without clobbering
//   local config/secrets, and optionally bumps the @ai-hero/sandcastle base dep.
//
//   --dry-run      report what would change; write nothing
//   --base-latest  set @ai-hero/sandcastle to npm's latest (instead of the layer's pin)
//   --from <src>   layer source: a git URL or a local path (overrides afk.config.json)
//   --force        proceed even if the loop is running or the project tree is dirty

const ROOT = process.cwd();
const DEFAULT_LAYER = "https://github.com/x-a-n-d-e-r-k/sandcastle-afk";

// ---- args ------------------------------------------------------------------
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const flagValue = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const DRY = has("--dry-run");
const BASE_LATEST = has("--base-latest");
const FORCE = has("--force");
const FROM = flagValue("--from");

const sh = (c: string, opts: { cwd?: string } = {}) =>
  execSync(c, { encoding: "utf8", cwd: opts.cwd ?? ROOT }).trim();
const tryf = <T>(f: () => T, d: T): T => { try { return f(); } catch { return d; } };
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

// Layer-tracked files under these dirs are mirrored into the project. Generated
// files and secrets are never layer-tracked, so they're already excluded — the
// explicit skip-list below is defense-in-depth.
const MANAGED_DIRS = ["bin/", ".sandcastle/", "skills/", "scripts/"];
// Single root-level files the layer owns. The example config is documentation of the layer's config
// contract, not the consumer's config — a stale copy hid new required keys (#77).
const MANAGED_FILES = new Set(["afk.config.example.json"]);
const SKIP_FILES = new Set([
  "afk.config.json",
  ".sandcastle/.env",
  ".sandcastle/.env.review",
]);
const isSkipped = (rel: string) =>
  SKIP_FILES.has(rel) ||
  rel.startsWith(".sandcastle/.env") ||
  rel === "afk.config.json";

// ---- 1. resolve the layer source -------------------------------------------
const projectCfg = existsSync(join(ROOT, "afk.config.json"))
  ? tryf(() => readJson(join(ROOT, "afk.config.json")), {} as Record<string, unknown>)
  : {};
const sourceUrl = FROM || (projectCfg.layerRepo as string | undefined) || DEFAULT_LAYER;
const isUrl = /^(https?:|git@|ssh:|git:)/.test(sourceUrl);

let layerDir = sourceUrl;
let cleanup: (() => void) | null = null;
if (isUrl) {
  layerDir = join(tmpdir(), `afk-layer-${Date.now()}`);
  console.log(`Cloning layer ${sourceUrl} ...`);
  sh(`git clone --depth 1 ${JSON.stringify(sourceUrl)} ${JSON.stringify(layerDir)}`);
  cleanup = () => rmSync(layerDir, { recursive: true, force: true });
} else if (!existsSync(layerDir)) {
  console.error(`Layer path does not exist: ${layerDir}`);
  process.exit(1);
}

try {
  const syncedSha = tryf(() => sh("git rev-parse HEAD", { cwd: layerDir }), "unknown");

  // ---- 2. safety preconditions ---------------------------------------------
  const loopRunning =
    tryf(() => { sh("pgrep -f loop.ts"); return true; }, false);
  if (loopRunning && !FORCE) {
    console.error("A loop process appears to be running (pgrep matched 'loop.ts').");
    console.error("Updating mid-run is unsafe. Stop it (pnpm afk:stop) or pass --force.");
    process.exit(1);
  }
  const projectDirty = tryf(() => sh("git status --porcelain").length > 0, false);
  if (projectDirty && !FORCE && !DRY) {
    console.error("Project git tree is dirty — the update won't be a clean reviewable diff.");
    console.error("Commit/stash your changes first, or pass --force.");
    process.exit(1);
  }

  // ---- 3. collect layer-owned files ----------------------------------------
  const tracked = sh("git ls-files", { cwd: layerDir })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((rel) => MANAGED_DIRS.some((d) => rel.startsWith(d)) || MANAGED_FILES.has(rel))
    .filter((rel) => !isSkipped(rel));

  const sameFile = (a: string, b: string) => {
    if (!existsSync(a) || !existsSync(b)) return false;
    return tryf(() => readFileSync(a).equals(readFileSync(b)), false);
  };

  // A managed root JSON file (the example config) that differs only in FORMATTING is left alone. A
  // consumer whose preflight runs a formatter (`prettier --check .`) gets it reformatted by an agent to
  // keep the gate green; overwriting it with the layer's bytes on every update just undid that, so the
  // tree was dirty after each update and the reformat came back in the next PR — forever.
  const sameJson = (a: string, b: string) =>
    tryf(() => JSON.stringify(JSON.parse(readFileSync(a, "utf8"))) === JSON.stringify(JSON.parse(readFileSync(b, "utf8"))), false);

  const changed: string[] = [];
  for (const rel of tracked) {
    const src = join(layerDir, rel);
    const dst = join(ROOT, rel);
    if (sameFile(src, dst)) continue;
    if (MANAGED_FILES.has(rel) && rel.endsWith(".json") && existsSync(dst) && sameJson(src, dst)) continue;
    changed.push(rel);
  }

  // ---- 4. resolve base version delta ---------------------------------------
  const layerPkg = readJson(join(layerDir, "package.json"));
  const layerBaseRange: string =
    layerPkg.dependencies?.["@ai-hero/sandcastle"] ??
    layerPkg.devDependencies?.["@ai-hero/sandcastle"] ?? "";
  let targetBase = layerBaseRange;
  if (BASE_LATEST) {
    const latest = tryf(() => sh("npm view @ai-hero/sandcastle version"), "");
    if (latest) targetBase = `^${latest}`;
  }
  const projectPkgPath = join(ROOT, "package.json");
  const projectPkg = existsSync(projectPkgPath) ? readJson(projectPkgPath) : { scripts: {}, dependencies: {} };
  const currentBase: string =
    projectPkg.dependencies?.["@ai-hero/sandcastle"] ??
    projectPkg.devDependencies?.["@ai-hero/sandcastle"] ?? "(none)";
  const baseChanges = targetBase && targetBase !== currentBase;

  // ---- 5. package.json script delta ----------------------------------------
  const layerScripts: Record<string, string> = layerPkg.scripts ?? {};
  const afkScripts = Object.fromEntries(
    Object.entries(layerScripts).filter(([k]) => k.startsWith("afk")),
  );
  const projScripts: Record<string, string> = projectPkg.scripts ?? {};
  const scriptChanges = Object.entries(afkScripts).filter(([k, v]) => projScripts[k] !== v);

  // ---- 5b. config contract (#77) -------------------------------------------
  // Would THIS layer accept the consumer's afk.config.json? Run the layer's own validators (its
  // config-contract.ts, in a child process reusing this process's tsx loader) — the same list the
  // loop enforces at startup — so a new required key is reported here, not as a crash at
  // `afk:loop`. Layers predating the contract file are skipped with a note.
  const contractFile = join(layerDir, ".sandcastle", "config-contract.ts");
  const consumerCfg = join(ROOT, "afk.config.json");
  let contract: { violations: unknown[]; report: string; exitCode: number } | null = null;
  if (!existsSync(consumerCfg)) {
    console.log("No afk.config.json yet — skipping the config-contract check (run `pnpm afk:init`).");
  } else if (!existsSync(contractFile)) {
    console.log("This layer has no config contract (.sandcastle/config-contract.ts) — skipping the config check.");
  } else {
    // Reuse this process's tsx loader flags, but never a debugger flag (port collision).
    const childArgv = process.execArgv.filter((a) => !/^--inspect/.test(a));
    try {
      contract = JSON.parse(execFileSync(process.execPath, [
        ...childArgv, contractFile, "--check", DRY ? "dry-run" : "apply", FORCE ? "1" : "0",
        consumerCfg, join(layerDir, "afk.config.example.json"),
      ], { encoding: "utf8", cwd: ROOT }));
    } catch (e) {
      // Fail CLOSED: a check that can't run (or prints nothing) must not read as "config is fine".
      const why = (e as Error).message.split("\n")[0];
      contract = {
        violations: [{ key: "(contract check)", message: why }],
        report: `${DRY ? "[dry-run] config changes required:" : "!!! CONFIG ACTION REQUIRED before `afk:loop`:"}\n  - could not run the layer's config-contract check (${why}). Validate afk.config.json by hand against afk.config.example.json before starting the loop.`,
        exitCode: DRY || FORCE ? 0 : 1,
      };
    }
  }

  // ---- DRY RUN: report, write nothing --------------------------------------
  if (DRY) {
    console.log(`\n[dry-run] layer source: ${sourceUrl}`);
    console.log(`[dry-run] layer HEAD: ${syncedSha}`);
    console.log(`\n[dry-run] ${changed.length} layer file(s) would change:`);
    for (const rel of changed) console.log(`  ~ ${rel}`);
    if (!changed.length) console.log("  (none — already in sync)");
    console.log(`\n[dry-run] base @ai-hero/sandcastle: ${currentBase} -> ${targetBase || "(unchanged)"}${baseChanges ? "" : " (no change)"}`);
    console.log(`[dry-run] afk:* script changes: ${scriptChanges.length}`);
    for (const [k, v] of scriptChanges) console.log(`  ~ ${k}: ${projScripts[k] ?? "(new)"} -> ${v}`);
    if (contract?.report) console.log(`\n${contract.report}`);
    else if (contract) console.log("\n[dry-run] config: your afk.config.json satisfies this layer's contract.");
    console.log("\n[dry-run] nothing written.");
    cleanup?.(); // process.exit skips the finally below
    process.exit(0);
  }

  // ---- APPLY: copy layer files (no mirror-delete) --------------------------
  for (const rel of changed) {
    const src = join(layerDir, rel);
    const dst = join(ROOT, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    // preserve the source's mode bits (keeps bin/forge and *.sh executable)
    tryf(() => { chmodSync(dst, statSync(src).mode); return 0; }, 0);
  }
  console.log(`Copied ${changed.length} layer file(s).`);

  // ---- merge package.json (deps via helper, afk:* scripts overridden) ------
  const mergeHelper = join(ROOT, "scripts", "merge-package-json.cjs");
  if (existsSync(mergeHelper)) {
    // adds missing deps + missing afk:* scripts without clobbering other keys
    tryf(() => { execSync(`node ${JSON.stringify(mergeHelper)} ${JSON.stringify(join(layerDir, "package.json"))}`, { cwd: ROOT, stdio: "inherit" }); return 0; }, 0);
  }
  // Re-read after the helper, then update afk:* script VALUES + base version.
  const pkg2 = readJson(projectPkgPath);
  pkg2.scripts ||= {};
  pkg2.dependencies ||= {};
  for (const [k, v] of Object.entries(afkScripts)) pkg2.scripts[k] = v;
  let baseFrom = currentBase;
  if (baseChanges) {
    // write into whichever section already holds it; default to dependencies
    if (pkg2.devDependencies?.["@ai-hero/sandcastle"]) pkg2.devDependencies["@ai-hero/sandcastle"] = targetBase;
    else pkg2.dependencies["@ai-hero/sandcastle"] = targetBase;
  }
  writeFileSync(projectPkgPath, JSON.stringify(pkg2, null, 2) + "\n");

  // ---- 6. re-render generated files ----------------------------------------
  let rerendered = false;
  if (existsSync(join(ROOT, "afk.config.json")) && existsSync(join(ROOT, "scripts", "init.ts"))) {
    try {
      // init.ts is idempotent: it leaves an existing afk.config.json untouched
      // and only re-renders the Dockerfile, preflight.sh, and skill from it.
      execSync(`npx tsx scripts/init.ts`, { cwd: ROOT, stdio: "inherit", env: { ...process.env, NODE_ENV: "development" } });
      rerendered = true;
    } catch (e) {
      console.warn("Could not auto re-render generated files:", (e as Error).message);
    }
  }

  // ---- 7. record the sync --------------------------------------------------
  const syncRecord = {
    sourceUrl,
    syncedSha,
    syncedAt: new Date().toISOString(),
    baseVersion: targetBase || currentBase,
  };
  writeFileSync(join(ROOT, ".sandcastle/.layer-sync.json"), JSON.stringify(syncRecord, null, 2) + "\n");
  // ensure the local-state file is gitignored
  const gi = join(ROOT, ".gitignore");
  const giLine = ".sandcastle/.layer-sync.json";
  if (existsSync(gi)) {
    const lines = readFileSync(gi, "utf8").split("\n");
    if (!lines.some((l) => l.trim() === giLine)) writeFileSync(gi, readFileSync(gi, "utf8").replace(/\n?$/, "\n") + giLine + "\n");
  }

  // ---- 8. summary + next steps ---------------------------------------------
  console.log("\n=== afk:update complete ===");
  console.log(`Files updated: ${changed.length}`);
  for (const rel of changed.slice(0, 12)) console.log(`  ~ ${rel}`);
  if (changed.length > 12) console.log(`  ... and ${changed.length - 12} more`);
  console.log(`Base @ai-hero/sandcastle: ${baseFrom}${baseChanges ? ` -> ${targetBase}` : " (unchanged)"}`);
  console.log(`Synced layer SHA: ${syncedSha}`);
  if (!rerendered) {
    console.log("\nGenerated files were NOT auto re-rendered — run `pnpm afk:init` to refresh the Dockerfile + preflight.");
  }
  console.log("\nNext steps:");
  console.log("  1. review `git diff`");
  if (baseChanges) console.log("  2. `pnpm install --frozen-lockfile`  (the base version changed — do this while the loop is STOPPED)");
  console.log(`  ${baseChanges ? 3 : 2}. \`pnpm afk:stop && pnpm afk:loop\``);
  if (contract?.report) {
    // Loud and last: the files are installed, but the loop will refuse to start until this is fixed.
    console.error(`\n${contract.report}`);
    if (contract.exitCode) console.error("\nFix afk.config.json (see afk.config.example.json), then start the loop. (--force exits 0.)");
  }
  process.exitCode = contract?.exitCode ?? 0;
} finally {
  cleanup?.();
}
