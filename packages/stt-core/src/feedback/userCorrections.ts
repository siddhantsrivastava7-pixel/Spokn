/**
 * Minimal scaffolding for the future feedback loop.
 *
 * A `UserCorrection` is one concrete edit the user made to an output
 * (e.g. they kept typing "Wispr" where the model wrote "Whisper"). When
 * a correction repeats across entries, `deriveReplacementRules` promotes
 * it to an `AdaptiveRules.replacements` entry.
 *
 * No persistence, no ML — the platform bridge stores entries and calls
 * `deriveReplacementRules` to get a rules snapshot.
 */

export interface UserCorrection {
  /** Exact source token or phrase as it appeared in the output. */
  original: string;
  /** The user's preferred replacement. */
  corrected: string;
}

const DEFAULT_MIN_SUPPORT = 2;

export interface DeriveReplacementRulesOptions {
  /** How many times a (original → corrected) pair must repeat. Default 2. */
  minSupport?: number;
}

/**
 * Aggregate repeated corrections into a deterministic replacement map.
 *
 * Rules:
 *   - Keys are lowercased `original` strings (case-insensitive matching).
 *   - When multiple distinct `corrected` forms exist for the same key,
 *     the most frequent wins; ties break by first occurrence.
 *   - `original === corrected` (case-insensitively) is ignored.
 *   - Below `minSupport` occurrences, the pair is dropped.
 */
export function deriveReplacementRules(
  corrections: ReadonlyArray<UserCorrection>,
  options: DeriveReplacementRulesOptions = {},
): Record<string, string> {
  const minSupport = options.minSupport ?? DEFAULT_MIN_SUPPORT;
  if (minSupport < 1) return {};

  interface Tally {
    /** correctedForm -> count */
    counts: Map<string, number>;
    firstSeen: Map<string, number>;
    insertionIndex: number;
  }
  const byKey = new Map<string, Tally>();

  let i = 0;
  for (const c of corrections) {
    const original = c.original?.trim();
    const corrected = c.corrected?.trim();
    if (!original || !corrected) {
      i++;
      continue;
    }
    if (original.toLowerCase() === corrected.toLowerCase()) {
      i++;
      continue;
    }
    const key = original.toLowerCase();
    let tally = byKey.get(key);
    if (!tally) {
      tally = {
        counts: new Map(),
        firstSeen: new Map(),
        insertionIndex: i,
      };
      byKey.set(key, tally);
    }
    tally.counts.set(corrected, (tally.counts.get(corrected) ?? 0) + 1);
    if (!tally.firstSeen.has(corrected)) {
      tally.firstSeen.set(corrected, i);
    }
    i++;
  }

  const out: Record<string, string> = {};
  const keys = [...byKey.entries()].sort(
    (a, b) => a[1].insertionIndex - b[1].insertionIndex,
  );

  for (const [key, tally] of keys) {
    let bestCount = 0;
    let bestFirstSeen = Number.POSITIVE_INFINITY;
    let best: string | undefined;
    for (const [corrected, count] of tally.counts) {
      if (count < minSupport) continue;
      const firstSeen = tally.firstSeen.get(corrected) ?? Number.POSITIVE_INFINITY;
      if (count > bestCount || (count === bestCount && firstSeen < bestFirstSeen)) {
        bestCount = count;
        bestFirstSeen = firstSeen;
        best = corrected;
      }
    }
    if (best !== undefined) out[key] = best;
  }

  return out;
}
