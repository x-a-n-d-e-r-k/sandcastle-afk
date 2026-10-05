import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { presses, shieldSigint, shouldSupervise, parentGone, CHILD_ENV } from "./soft-stop.js";

test("presses: a SIGINT relayed within the window is the same keypress", () => {
  let t = 0;
  const press = presses(750, () => t);
  assert.equal(press(), 1);
  t = 5;
  assert.equal(press(), null); // tsx / npm relaying the terminal's SIGINT
  t = 2000;
  assert.equal(press(), 2);
});

test("shieldSigint: a SIGINT listener added afterwards never runs, and still unregisters", () => {
  const proc = new EventEmitter() as unknown as NodeJS.Process;
  const calls: string[] = [];
  proc.on("SIGINT", () => calls.push("loop"));
  const { restore } = shieldSigint(proc);
  const foreign = () => calls.push("sandcastle");
  proc.on("SIGINT", foreign);
  proc.on("SIGTERM", () => calls.push("term")); // other signals are untouched
  proc.emit("SIGINT");
  proc.emit("SIGTERM");
  assert.deepEqual(calls, ["loop", "term"]);
  proc.removeListener("SIGINT", foreign); // sandcastle's unregister passes its original handler
  assert.equal(proc.listenerCount("SIGINT"), 1);
  restore();
  proc.on("SIGINT", () => calls.push("after-restore"));
  proc.emit("SIGINT");
  assert.deepEqual(calls, ["loop", "term", "loop", "after-restore"]);
});

test("shouldSupervise: only at a terminal, and never inside the supervised child", () => {
  assert.equal(shouldSupervise({}, true), true);
  assert.equal(shouldSupervise({}, false), false);
  assert.equal(shouldSupervise({ [CHILD_ENV]: "1" }, true), false);
});

test("parentGone: the supervisor's pid changing means it went away", () => {
  assert.equal(parentGone(42, () => 42), false);
  assert.equal(parentGone(42, () => 1), true);
});

// ---- real signals ----------------------------------------------------------------------------------

const softStop = pathToFileURL(join(import.meta.dirname, "soft-stop.ts")).href;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A stand-in for loop.ts: the loop's handler, the shield, then sandcastle's per-sandbox shutdown
// (SIGINT → teardown + exit(1), plus an 'exit' teardown) and an in-flight "agent run" grandchild in
// the same process group (as `docker exec` is). It exits 0 at the "safe point" after the run.
const LOOP = `
import { spawn } from "node:child_process";
import { presses, shieldSigint, shouldSupervise, superviseInOwnGroup, CHILD_ENV } from ${JSON.stringify(softStop)};
if (process.env.SUPERVISE === "1" && process.env[CHILD_ENV] !== "1") {
  process.exit(await superviseInOwnGroup({ log: console.log }));
}
let stop = false;
const press = presses();
process.on("SIGINT", () => {
  const n = press();
  if (n === null) return;
  if (n >= 2) { console.log("hard"); process.exit(130); }
  stop = true; console.log("soft");
});
process.on("SIGHUP", () => { stop = true; console.log("hup-soft"); });
shieldSigint();
process.on("SIGINT", () => { console.log("sandcastle-sigint"); process.exit(1); });
process.on("exit", () => console.log("exit-teardown"));
const run = spawn(process.execPath, ["-e", "setTimeout(() => {}, Number(process.argv[1]))", process.env.RUN_MS ?? "1500"], { stdio: "ignore" });
run.on("exit", (code, sig) => {
  console.log("run-ended " + (sig ?? code));
  if (stop) process.exit(0);
});
console.log("ready");
`;

const startLoop = (env: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-soft-stop-"));
  const file = join(dir, "loop.mts");
  writeFileSync(file, LOOP);
  // detached: its own process group, so process.kill(-pid) is exactly a terminal's Ctrl-C.
  const p = spawn(process.execPath, ["--import", "tsx", file], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env, [CHILD_ENV]: "" },
    cwd: import.meta.dirname,
  });
  let out = "";
  p.stdout!.on("data", (d) => { out += d; });
  p.stderr!.on("data", (d) => { out += d; });
  const exited = new Promise<number | null>((r) => p.on("exit", (c) => r(c)));
  const ready = async () => { for (let i = 0; i < 100 && !out.includes("ready"); i++) await sleep(50); };
  return { p, exited, ready, out: () => out };
};

test("one Ctrl-C (whole process group) is a soft stop: the in-flight run finishes, then exit 0", { timeout: 20000 }, async () => {
  const l = startLoop({ SUPERVISE: "1", RUN_MS: "1500" });
  await l.ready();
  process.kill(-l.p.pid!, "SIGINT");
  const code = await l.exited;
  const out = l.out();
  assert.equal(code, 0, out);
  assert.match(out, /soft/);
  assert.match(out, /run-ended 0/); // the run was NOT killed by the terminal's SIGINT
  assert.doesNotMatch(out, /sandcastle-sigint|hard/);
});

test("a second Ctrl-C is a hard stop: exit 130 with the exit-hook teardown", { timeout: 20000 }, async () => {
  const l = startLoop({ SUPERVISE: "1", RUN_MS: "10000" });
  await l.ready();
  process.kill(-l.p.pid!, "SIGINT");
  await sleep(1000);
  process.kill(-l.p.pid!, "SIGINT");
  const code = await l.exited;
  const out = l.out();
  assert.equal(code, 130, out);
  assert.match(out, /soft[\s\S]*hard[\s\S]*exit-teardown/);
  assert.doesNotMatch(out, /sandcastle-sigint/);
});

test("unsupervised, a relayed duplicate SIGINT is still one keypress (soft)", { timeout: 20000 }, async () => {
  const l = startLoop({ SUPERVISE: "0", RUN_MS: "1500" });
  await l.ready();
  process.kill(l.p.pid!, "SIGINT");
  process.kill(l.p.pid!, "SIGINT");
  const code = await l.exited;
  const out = l.out();
  assert.equal(code, 0, out);
  assert.match(out, /soft/);
  assert.doesNotMatch(out, /sandcastle-sigint|hard/);
});

test("terminal closed (SIGHUP to the supervisor) is a soft stop: the run finishes, then exit 0", { timeout: 20000 }, async () => {
  const l = startLoop({ SUPERVISE: "1", RUN_MS: "1500" });
  await l.ready();
  process.kill(l.p.pid!, "SIGHUP");
  const code = await l.exited;
  const out = l.out();
  assert.equal(code, 0, out);
  assert.match(out, /hup-soft[\s\S]*run-ended 0/);
});
