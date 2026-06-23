import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

// pnpm afk:init [--build] [--labels]
//   detects the stack, writes afk.config.json, renders the Dockerfile,
//   generates .sandcastle/preflight.sh, and installs the agent-ready-issue skill.
//   --build  also builds the sandbox image    --labels  also creates the loop's labels
const ROOT = process.cwd();
const args = process.argv.slice(2);
const sh = (c: string) => execSync(c, { encoding: "utf8" }).trim();
const tryf = (f: () => string, d = "") => { try { return f(); } catch { return d; } };
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const has = (p: string) => existsSync(join(ROOT, p));

// ---- detect ----------------------------------------------------------------
const pkg = has("package.json") ? JSON.parse(read("package.json")) : { scripts: {} };
const scripts: Record<string, string> = pkg.scripts ?? {};

const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
const pmVersion = (pkg.packageManager?.match(/@(.+)$/)?.[1]) ?? "";
const install = pm === "pnpm" ? "pnpm install --frozen-lockfile" : pm === "yarn" ? "yarn install --frozen-lockfile" : "npm ci";

const remote = tryf(() => sh("git remote get-url origin"));
const platform = /gitlab/i.test(remote) ? "gitlab" : "github";
const defaultBranch =
  tryf(() => sh("git symbolic-ref --short refs/remotes/origin/HEAD").replace(/^origin\//, "")) ||
  tryf(() => sh("git branch --show-current")) || "main";

const nodeMajor = tryf(() => read(".nvmrc").trim().replace(/^v/, "").split(".")[0]) ||
  (pkg.engines?.node?.match(/(\d+)/)?.[1]) || "22";
const dockerBaseImage = `node:${nodeMajor}-bookworm`;

const run = (s: string) => `${pm} run ${s}`;
const preflight = ["lint", "typecheck", "test", "test:integration"].filter((s) => scripts[s]).map(run);
const e2e = scripts["test:e2e"] ? run("test:e2e") : "";

const cfg = {
  platform, reviewMode: "internal", defaultBranch, packageManager: pm, packageManagerVersion: pmVersion, dockerBaseImage,
  install, preflight: preflight.length ? preflight : [run("test")], e2e, imageName: "sandcastle-afk",
  models: { implement: "claude-sonnet-4-6", review: "claude-opus-4-8", heal: "claude-sonnet-4-6" },
  labels: { ready: "agent-ready", needsFeedback: "needs-feedback", epic: "epic", idea: "idea", needsHuman: "needs-human", e2eRegression: "e2e-regression" },
  maxHeal: 3, maxPipelineRetry: 2, flakyJobs: [] as string[], pollMinutes: 5, idleTimeoutSeconds: 900,
};

if (!has("afk.config.json")) {
  writeFileSync(join(ROOT, "afk.config.json"), JSON.stringify(cfg, null, 2) + "\n");
  console.log("wrote afk.config.json (detected — REVIEW IT, especially `preflight`):");
} else {
  console.log("afk.config.json exists — leaving it. Using its values for rendering.");
}
const C = JSON.parse(read("afk.config.json"));
console.log(JSON.stringify({ platform: C.platform, defaultBranch: C.defaultBranch, packageManager: C.packageManager, preflight: C.preflight, e2e: C.e2e }, null, 2));

// ---- render Dockerfile -----------------------------------------------------
const GH_INSTALL = `RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*`;
const GLAB_INSTALL = `RUN set -eux; \\
  arch="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"; \\
  ver="$(curl -fsSL 'https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases?per_page=1' | jq -r '.[0].tag_name' | sed 's/^v//')"; \\
  curl -fsSL "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/packages/generic/glab/\${ver}/glab_\${ver}_linux_\${arch}.tar.gz" -o /tmp/glab.tgz; \\
  tar -xzf /tmp/glab.tgz -C /usr/local bin/glab; rm /tmp/glab.tgz; glab --version`;

let pmPrebake = "# (npm needs no pre-bake)";
if ((C.packageManager === "pnpm" || C.packageManager === "yarn") && C.packageManagerVersion) {
  pmPrebake = `RUN corepack enable
ENV COREPACK_HOME=/opt/corepack
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN mkdir -p /opt/corepack && corepack prepare ${C.packageManager}@${C.packageManagerVersion} --activate && chmod -R 777 /opt/corepack`;
}

const dockerfile = read(".sandcastle/Dockerfile.template")
  .replace(/{{BASE_IMAGE}}/g, C.dockerBaseImage)
  .replace(/{{FORGE_CLI_INSTALL}}/g, C.platform === "github" ? GH_INSTALL : GLAB_INSTALL)
  .replace(/{{PM_PREBAKE}}/g, pmPrebake)
  .replace(/{{PLATFORM}}/g, C.platform);
writeFileSync(join(ROOT, ".sandcastle/Dockerfile"), dockerfile);
console.log("rendered .sandcastle/Dockerfile");

// ---- generate preflight.sh -------------------------------------------------
writeFileSync(join(ROOT, ".sandcastle/preflight.sh"), `#!/usr/bin/env bash\nset -e\n${C.preflight.join("\n")}\n`);
chmodSync(join(ROOT, ".sandcastle/preflight.sh"), 0o755);
console.log("generated .sandcastle/preflight.sh");

// ---- install the skill (rendered) ------------------------------------------
const gates = C.preflight.map((c: string) => `\`${c}\``).join(", ");
const renderSkill = (s: string) =>
  s.replace(/{{GATES}}/g, gates)
    .replace(/{{READY_LABEL}}/g, C.labels.ready).replace(/{{NEEDS_FEEDBACK_LABEL}}/g, C.labels.needsFeedback)
    .replace(/{{EPIC_LABEL}}/g, C.labels.epic).replace(/{{IDEA_LABEL}}/g, C.labels.idea);
const skillDst = join(ROOT, ".claude/skills/agent-ready-issue");
mkdirSync(skillDst, { recursive: true });
writeFileSync(join(skillDst, "SKILL.md"), renderSkill(read("skills/agent-ready-issue/SKILL.md.template")));
writeFileSync(join(skillDst, "template.md"), renderSkill(read("skills/agent-ready-issue/template.md.template")));
for (const s of ["create-issue.sh", "retrofit-issue.sh", "list-candidates.sh"]) {
  copyFileSync(join(ROOT, "skills/agent-ready-issue", s), join(skillDst, s));
  chmodSync(join(skillDst, s), 0o755);
}
console.log("installed skill -> .claude/skills/agent-ready-issue/");

// ---- optional: build image + create labels ---------------------------------
if (args.includes("--build")) {
  console.log("building image (this can take a few minutes)...");
  execSync(`npx sandcastle docker build-image --image-name ${C.imageName}`, { stdio: "inherit", env: { ...process.env, NODE_ENV: "development" } });
}
if (args.includes("--labels")) {
  process.env.FORGE_PLATFORM = C.platform;
  const colors: Record<string, string> = { ready: "0E8A16", needsFeedback: "FBCA04", epic: "5319E7", idea: "C5DEF5", needsHuman: "B60205", e2eRegression: "D93F0B" };
  for (const [k, name] of Object.entries(C.labels)) {
    try {
      if (C.platform === "github") execSync(`gh label create ${JSON.stringify(name)} --color ${colors[k] ?? "ededed"} --force`, { stdio: "ignore" });
      else execSync(`glab label create --name ${JSON.stringify(name)} --color "#${colors[k] ?? "ededed"}"`, { stdio: "ignore" });
    } catch {}
  }
  console.log("ensured labels exist");
}

console.log("\nNext: review afk.config.json, then see playbook.md for identities + branch protection. Build with `pnpm afk:init --build`.");
