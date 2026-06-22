// Merge sandcastle-afk's deps + afk:* scripts into the target repo's package.json
// WITHOUT clobbering existing keys.  node merge-package-json.cjs <src-package.json>
const fs = require("fs");
const path = require("path");
const src = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const p = "package.json";
const dst = fs.existsSync(p)
  ? JSON.parse(fs.readFileSync(p, "utf8"))
  : { name: path.basename(process.cwd()), version: "0.0.0", private: true };
dst.dependencies ||= {};
dst.devDependencies ||= {};
dst.scripts ||= {};
const add = (a, b) => { for (const k in b) if (!(k in a)) a[k] = b[k]; };
add(dst.dependencies, src.dependencies || {});
add(dst.devDependencies, src.devDependencies || {});
const added = [];
for (const k of Object.keys(src.scripts || {})) {
  if (k.startsWith("afk") && !(k in dst.scripts)) { dst.scripts[k] = src.scripts[k]; added.push(k); }
}
fs.writeFileSync(p, JSON.stringify(dst, null, 2) + "\n");
console.log(`  package.json merged (scripts added: ${added.join(", ") || "none — already present"})`);
