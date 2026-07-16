// The typed forge client (#40) must never drift from the registry, and its type-safety must be
// real (a nonexistent verb / undocumented field = compile error), not decorative.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// config.ts (imported transitively by forge-client) throws without afk.config.json — seed it.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json")))
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));

const { generateClient, readRegistry } = await import("./gen-forge-client.js");
const client = await import("./forge-client.js");

const camel = (v: string): string =>
  v.split("-").map((s, i) => (i === 0 ? s : s[0].toUpperCase() + s.slice(1))).join("");

test("forge-client.ts is in sync with the registry (regenerate == checked-in)", () => {
  const fresh = generateClient(readRegistry());
  const onDisk = readFileSync(join(ROOT, ".sandcastle", "forge-client.ts"), "utf8");
  assert.equal(onDisk, fresh, "forge-client.ts is stale — run `pnpm afk:gen-client` and commit the result");
});

test("the client exports exactly the registry's verbs (no missing verb, no dead function)", () => {
  const want = new Set(Object.keys(readRegistry()).map(camel));
  const got = new Set(
    Object.keys(client).filter((k) => typeof (client as Record<string, unknown>)[k] === "function"),
  );
  // No dispatch verb without a client function (the #21 guard); no function for a nonexistent verb.
  assert.deepEqual([...got].sort(), [...want].sort());
});

// Type-level proof — checked by `pnpm typecheck`, never executed (calling it would run forge).
// Each `@ts-expect-error` is itself an error if the line unexpectedly compiles, so typecheck
// FAILS unless the safety is real. This is what today's `forgeJSON<T>(\`verb ...\`)` strings
// (any verb, any T) could not give.
export function _typeLevelProof(): void {
  // @ts-expect-error — a verb not in the registry is not callable
  client.notARealVerb(1);
  // @ts-expect-error — a field forge does not emit is not readable
  client.issueView(1).notAField;
  // A real call with a real field type-checks (no error expected here):
  const s: string = client.issueView(1).state;
  void s;
}
