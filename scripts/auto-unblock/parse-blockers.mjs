/**
 * Parse blocker issue IDs from an issue body.
 *
 * Primary:  <!-- blocker-deps: #N, #M --> HTML comment marker.
 * Fallback: lines matching "Blocked by #N" outside fenced code blocks.
 *
 * @param {string | null | undefined} body
 * @returns {number[]} Sorted, deduplicated array of blocker issue IDs.
 */
export function parseBlockers(body) {
  if (!body) return [];

  // Primary: structured HTML comment marker
  const markerMatch = body.match(/<!--\s*blocker-deps:\s*([\s\S]*?)\s*-->/i);
  if (markerMatch) {
    const ids = [...markerMatch[1].matchAll(/#(\d+)/g)].map((m) => parseInt(m[1], 10));
    return [...new Set(ids)].sort((a, b) => a - b);
  }

  // Fallback: "Blocked by #N" text, skipping fenced code blocks
  const lines = body.split('\n');
  let inFence = false;
  const ids = [];

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/blocked by/i.test(line)) {
      for (const m of line.matchAll(/#(\d+)/g)) {
        ids.push(parseInt(m[1], 10));
      }
    }
  }

  return [...new Set(ids)].sort((a, b) => a - b);
}
