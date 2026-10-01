import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Is the module at `metaUrl` the process entry point (`tsx .sandcastle/<x>.ts`)?
//
// Compare REAL paths. import.meta.url is the resolved path; process.argv[1] is merely absolutised.
// Through any symlink — macOS's /var → /private/var tmpdir, or a consumer checkout under a symlinked
// dir — a naive `import.meta.url === pathToFileURL(argv[1]).href` is false, and the runner silently
// does nothing: `afk:stop` writes no sentinel, `afk:loop` never starts, the contract check prints
// nothing (review of #77). Every runner's main-guard goes through here.
const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

export const isEntryPoint = (metaUrl: string, argv1: string | undefined = process.argv[1]): boolean =>
  !!argv1 && real(argv1) === real(fileURLToPath(metaUrl));
