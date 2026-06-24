import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

// pnpm afk:rules — resolve cfg.agentRules (local paths + URLs) into a single
// cached file, .sandcastle/agent-rules.md, which the runners inject into every
// agent prompt. Re-run to refresh (e.g. when an upstream ruleset URL changes).
const ROOT = process.cwd();
const cfg = JSON.parse(readFileSync(join(ROOT, "afk.config.json"), "utf8"));
const sources: string[] = cfg.agentRules ?? [];
const dest = join(ROOT, ".sandcastle", "agent-rules.md");

if (sources.length === 0) {
  if (existsSync(dest)) rmSync(dest);
  console.log("agentRules is empty — no house rules injected.");
  process.exit(0);
}

// Wrapped in an async IIFE so the top-level await runs under CJS-default host
// repos too (tsx transforms to CJS there, where top-level await is illegal).
void (async () => {
  const parts: string[] = [];
  for (const s of sources) {
    if (/^https?:\/\//.test(s)) {
      const r = await fetch(s);
      if (!r.ok) throw new Error(`fetch ${s} -> ${r.status}`);
      parts.push(`<!-- source: ${s} -->\n${(await r.text()).trim()}`);
      console.log(`fetched ${s}`);
    } else {
      parts.push(`<!-- source: ${s} -->\n${readFileSync(join(ROOT, s), "utf8").trim()}`);
      console.log(`read ${s}`);
    }
  }
  writeFileSync(dest, parts.join("\n\n---\n\n") + "\n");
  console.log(`wrote ${dest} (${sources.length} source${sources.length > 1 ? "s" : ""})`);
})();
