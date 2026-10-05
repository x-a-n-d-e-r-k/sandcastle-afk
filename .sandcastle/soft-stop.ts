import { spawn, type ChildProcess } from "node:child_process";

// Ctrl-C semantics for the loop: the FIRST press is a soft stop (finish the current run, exit at the
// next safe point), the SECOND is a hard stop. Three things defeated that, so every Ctrl-C was hard:
//
// 1. sandcastle registers its own SIGINT listener per sandbox (registerShutdown → removeContainer, then
//    process.exit(1)). Node runs every SIGINT listener, so the first press exited the loop whenever a
//    run was in flight. → shieldSigint(): SIGINT listeners added by anyone else are kept registered but
//    never run. Their cleanup is not lost: a hard stop is process.exit(), and sandcastle tears its
//    containers down from its 'exit' hook too.
// 2. One keypress arrives TWICE: the terminal signals the whole foreground process group, and the tsx /
//    npm wrapper relays the same SIGINT to its child. → presses(): signals within PRESS_WINDOW_MS of the
//    previous one are the same keypress.
// 3. The container exec clients (`docker exec …`) are spawned in the terminal's process group, so the
//    terminal's SIGINT killed the in-flight agent run even on a "soft" stop. → superviseInOwnGroup():
//    when attached to a terminal, the loop re-runs itself in its own process group (out of the
//    terminal's reach) and a thin foreground supervisor forwards one SIGINT per keypress.

export const PRESS_WINDOW_MS = 750;
export const CHILD_ENV = "AFK_LOOP_CHILD";

type Listener = (...args: unknown[]) => void;
type Shielded = Listener & { listener?: Listener };

// Wrap SIGINT listeners registered from now on (sandcastle's, mainly) so they don't run. `wrapper.listener`
// is the original: EventEmitter.removeListener matches on it, so sandcastle's own unregister still works.
// The loop's handler must be registered BEFORE this (or via the returned `on`), so it is not wrapped.
export const shieldSigint = (proc: NodeJS.Process = process): { restore: () => void } => {
  const methods = ["on", "addListener", "prependListener"] as const;
  const originals = methods.map((m) => proc[m]);
  methods.forEach((m, i) => {
    const original = originals[i] as (this: NodeJS.Process, ev: string | symbol, l: Listener) => NodeJS.Process;
    (proc as unknown as Record<string, unknown>)[m] = function (this: NodeJS.Process, ev: string | symbol, l: Listener) {
      if (ev !== "SIGINT") return original.call(this, ev, l);
      const wrapper: Shielded = () => { /* shielded: the loop owns Ctrl-C */ };
      wrapper.listener = l;
      return original.call(this, ev, wrapper);
    };
  });
  return { restore: () => methods.forEach((m, i) => { (proc as unknown as Record<string, unknown>)[m] = originals[i]; }) };
};

// Count keypresses, not signals: a SIGINT within windowMs of the previous one is the same keypress.
export const presses = (windowMs = PRESS_WINDOW_MS, now: () => number = Date.now) => {
  let count = 0;
  let last = -Infinity;
  return (): number | null => {
    const t = now();
    const dup = t - last < windowMs;
    last = t;
    if (dup) return null;
    return ++count;
  };
};

// Supervise only an interactive loop that isn't already the supervised child: off a terminal there is
// no Ctrl-C to protect against, and nesting would recurse.
export const shouldSupervise = (env: NodeJS.ProcessEnv = process.env, isTTY = !!process.stdin.isTTY): boolean =>
  isTTY && env[CHILD_ENV] !== "1";

// Re-run this process in its own process group and wait for it. Ctrl-C reaches only this supervisor; it
// forwards one SIGINT per keypress (the child's own handler does soft-then-hard), and SIGTERM / SIGHUP
// as-is. Resolves with the exit code to use.
export const superviseInOwnGroup = (o: {
  log: (m: string) => void;
  spawnChild?: () => ChildProcess;
}): Promise<number> => {
  const child = (o.spawnChild ?? (() => spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    detached: true, // own process group: the terminal's SIGINT no longer reaches it or its docker exec clients
    stdio: "inherit",
    env: { ...process.env, [CHILD_ENV]: "1" },
  })))();
  const press = presses();
  const onInt = () => { if (press() !== null) child.kill("SIGINT"); };
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  const onTerm = forward("SIGTERM");
  const onHup = forward("SIGHUP");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);
  return new Promise((resolve) => {
    child.on("exit", (code, sig) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      process.off("SIGHUP", onHup);
      resolve(code ?? (sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 1));
    });
    child.on("error", (e) => { o.log(`could not start the supervised loop: ${e.message}`); resolve(1); });
  });
};

// The supervised child: if the supervisor is gone (e.g. SIGKILLed), stop softly — nothing would
// relay a Ctrl-C any more, and an orphaned loop should not run on unseen.
export const parentGone = (startPpid: number, ppid: () => number = () => process.ppid): boolean =>
  ppid() !== startPpid;
