import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryPoint } from "./entry.js";

// Deliberately NOT importing config.ts: that validates afk.config.json at load (#77), and stopping a
// running loop must work even when the config is invalid (e.g. right after an `afk:update --force`).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

// Graceful-stop sentinel: `pnpm afk:stop` writes it; the running loop polls it
// and exits cleanly after its current step. Gitignored (.sandcastle/.stop-requested).
export const STOP_SENTINEL = join(ROOT, ".sandcastle", ".stop-requested");

// A graceful stop is requested by EITHER an in-process signal (first Ctrl-C) or
// the on-disk sentinel (pnpm afk:stop from any terminal — the loop runs detached).
export const shouldStop = (signalled: boolean, sentinelExists: boolean): boolean => signalled || sentinelExists;

export const requestStop = (sentinel: string = STOP_SENTINEL): void => {
  writeFileSync(sentinel, "");
};
export const stopSentinelExists = (sentinel: string = STOP_SENTINEL): boolean => existsSync(sentinel);
export const clearStopSentinel = (sentinel: string = STOP_SENTINEL): void => {
  try {
    rmSync(sentinel, { force: true });
  } catch {
    /* already gone — nothing to clear */
  }
};

// Sleep up to totalMs in stepMs slices, returning as soon as isStopped() is true.
// Returns ms actually waited (for deterministic testing with an injected sleeper).
export const sleepUnlessStopped = async (
  totalMs: number,
  isStopped: () => boolean,
  stepMs = 1000,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<number> => {
  let waited = 0;
  while (waited < totalMs && !isStopped()) {
    const step = Math.min(stepMs, totalMs - waited);
    await sleepFn(step);
    waited += step;
  }
  return waited;
};

// `pnpm afk:stop` -> `tsx .sandcastle/stop.ts`: request a graceful stop.
const isMain = isEntryPoint(import.meta.url);
if (isMain) {
  requestStop();
  log(`stop requested — wrote ${STOP_SENTINEL}. The loop will exit after its current step completes.`);
}
