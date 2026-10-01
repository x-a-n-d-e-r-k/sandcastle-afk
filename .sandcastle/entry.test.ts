// Runner main-guards compare REAL paths (entry.ts). A naive comparison is false through any symlink,
// and the runner silently does nothing (`afk:stop` wrote no sentinel) — review of #77.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isEntryPoint } from "./entry.js";

test("isEntryPoint: true for the same file reached through a symlinked directory; false otherwise", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "afk-entry-")));
  try {
    mkdirSync(join(dir, "real"));
    const file = join(dir, "real", "runner.ts");
    writeFileSync(file, "");
    symlinkSync(join(dir, "real"), join(dir, "link"));
    const metaUrl = pathToFileURL(file).href;      // what import.meta.url looks like (resolved)
    const viaLink = join(dir, "link", "runner.ts"); // what argv[1] looks like through a symlink
    assert.notEqual(metaUrl, pathToFileURL(viaLink).href, "the naive comparison is false here");
    assert.equal(isEntryPoint(metaUrl, viaLink), true);
    assert.equal(isEntryPoint(metaUrl, file), true);
    assert.equal(isEntryPoint(metaUrl, join(dir, "real", "other.ts")), false);
    assert.equal(isEntryPoint(metaUrl, undefined), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
