import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// Generator for .sandcastle/forge-client.ts (#40, epic #30). The client is a TYPED wrapper over
// config.ts's forge()/forgeJSON(), one function per verb in forge-verbs.json — so a nonexistent
// verb and an undocumented output field become compile errors (the #21 / #11 classes). The file
// is GENERATED, checked in, and drift-guarded by forge-client.test.ts (regenerate == checked-in),
// so it can never silently diverge from the registry.
//
// Regenerate:  pnpm afk:gen-client
//
// Args stay pragmatic: functions take the required positional (a `number` when the registry says
// so) plus a variadic `...rest` appended verbatim to the shell string — identical to what
// callers passed before. Full per-flag typing is out of scope for this slice; the win here is
// verb-name and return-field safety.

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, "forge-verbs.json");
const OUT = join(HERE, "forge-client.ts");

type Desc = {
  mutating: boolean;
  retryable: boolean;
  output: "json" | "text" | "none";
  requiredArgs: string[];
  jsonFields?: string[];
  array?: boolean;
};

const camel = (verb: string): string =>
  verb.split("-").map((s, i) => (i === 0 ? s : s[0].toUpperCase() + s.slice(1))).join("");
const pascal = (verb: string): string => {
  const c = camel(verb);
  return c[0].toUpperCase() + c.slice(1);
};
// Field → TS type. Covers every jsonField in the registry; a genuinely new field name defaults
// to `string`, which is the safe, most-common case for a forge JSON field.
const fieldType = (f: string): string =>
  f === "number" ? "number" : f === "merged" ? "boolean" : f === "labels" ? "string[]" : "string";

const HEADER = `// GENERATED from .sandcastle/forge-verbs.json by gen-forge-client.ts — DO NOT EDIT BY HAND.
// Regenerate with \`pnpm afk:gen-client\`; forge-client.test.ts fails if this drifts from the registry.`;

export const generateClient = (registry: Record<string, Desc>): string => {
  const interfaces: string[] = [];
  const fns: string[] = [];

  for (const [verb, d] of Object.entries(registry)) {
    const name = camel(verb);
    const hasNum = d.requiredArgs.includes("number");
    const params = hasNum ? "num: number, ...rest: Arg[]" : "...rest: Arg[]";
    const argsArray = hasNum ? "[num, ...rest]" : "rest";
    const call = `\`${verb} \${${argsArray}.join(" ")}\`.trim()`;

    if (d.output === "json") {
      const iface = d.array ? `${pascal(verb)}Item` : pascal(verb);
      const body = (d.jsonFields ?? []).map((f) => `  ${f}: ${fieldType(f)};`).join("\n");
      interfaces.push(`export interface ${iface} {\n${body}\n}`);
      const ret = d.array ? `${iface}[]` : iface;
      fns.push(`export const ${name} = (${params}): ${ret} =>\n  forgeJSON<${ret}>(${call});`);
    } else if (d.output === "text") {
      fns.push(`export const ${name} = (${params}): string =>\n  forge(${call});`);
    } else {
      fns.push(`export const ${name} = (${params}): void => {\n  forge(${call});\n};`);
    }
  }

  return [
    HEADER,
    `import { forge, forgeJSON } from "./config.js";`,
    `\ntype Arg = string | number;`,
    interfaces.join("\n\n"),
    fns.join("\n\n"),
    "",
  ].join("\n\n");
};

export const readRegistry = (): Record<string, Desc> =>
  JSON.parse(readFileSync(REGISTRY, "utf8"));

// When run directly, (re)write the client file.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  writeFileSync(OUT, generateClient(readRegistry()));
  console.log(`wrote ${OUT}`);
}
