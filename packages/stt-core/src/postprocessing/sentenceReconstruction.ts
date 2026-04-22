import type { CorrectionBudget, CorrectionMode } from "./correctionMode";
import type { TextToken } from "./entityProtection";
import type { CorrectionLogEntry } from "./processTypes";

export interface SentenceSplittingOptions {
  budget: CorrectionBudget;
  mode: CorrectionMode;
  /** Lower splitting threshold when the user prefers short sentences. */
  prefersShortSentences?: boolean;
}

export interface SentenceSplittingResult {
  tokens: TextToken[];
  corrections: CorrectionLogEntry[];
}

const COORDINATING_CONJUNCTIONS = new Set<string>([
  "and",
  "but",
  "so",
]);

const DEFAULT_SPLIT_THRESHOLD = 30;
const SHORT_SPLIT_THRESHOLD = 15;

/**
 * Splits sentences that exceed the word-count threshold at the first
 * coordinating conjunction preceded by a comma.
 *
 * Strict invariant: no words are added. Splitting converts the comma into a
 * period and capitalizes the next word. The conjunction itself is preserved.
 *
 * Example:
 *   "we fixed the bug, and then we shipped the release" (12 words) — no split
 *   "we fixed the critical security bug that blocked the release, and then
 *    we shipped the release to production" (20 words, with assertive budget
 *    and `prefersShortSentences`) → splits at ", and".
 */
export function splitLongSentences(
  tokens: TextToken[],
  mask: boolean[],
  opts: SentenceSplittingOptions,
): SentenceSplittingResult {
  if (!opts.budget.allowSentenceSplit) {
    return { tokens, corrections: [] };
  }

  const threshold = opts.prefersShortSentences
    ? SHORT_SPLIT_THRESHOLD
    : DEFAULT_SPLIT_THRESHOLD;

  const out = tokens.map((t) => ({ ...t }));
  const corrections: CorrectionLogEntry[] = [];

  // Walk sentence-by-sentence. A sentence ends at .!? punctuation.
  let sentenceStart = 0;
  let wordCount = 0;
  for (let i = 0; i <= out.length; i++) {
    const ends =
      i === out.length ||
      (out[i]!.isSeparator && /[.!?]/.test(out[i]!.text));
    if (!ends) {
      if (!out[i]!.isSeparator && out[i]!.text.length > 0) wordCount++;
      continue;
    }
    if (wordCount > threshold) {
      applySplit(out, mask, sentenceStart, i, opts.mode, corrections);
    }
    sentenceStart = i + 1;
    wordCount = 0;
  }

  return { tokens: out, corrections };
}

function applySplit(
  tokens: TextToken[],
  mask: boolean[],
  start: number,
  endExclusive: number,
  mode: CorrectionMode,
  log: CorrectionLogEntry[],
): void {
  // Scan for `, <conj>` boundaries. Split at the first eligible one.
  for (let i = start; i < endExclusive - 2; i++) {
    const sepA = tokens[i]!;
    if (!sepA.isSeparator) continue;
    if (!/,/.test(sepA.text)) continue;

    // Find the next non-empty word.
    const nextWordIdx = findNextWordIndex(tokens, i + 1, endExclusive);
    if (nextWordIdx < 0) return;
    const nextWord = tokens[nextWordIdx]!.text.toLowerCase();
    if (!COORDINATING_CONJUNCTIONS.has(nextWord)) continue;
    if (mask[nextWordIdx]) continue;

    // Convert "," to "." — punctuation edit, no words added.
    const originalSep = sepA.text;
    const newSep = originalSep.replace(/,/, ".");
    if (newSep !== originalSep) {
      log.push({
        kind: "split",
        from: originalSep,
        to: newSep,
        mode,
      });
      tokens[i] = { ...sepA, text: newSep };
    }

    // Capitalize the conjunction start.
    const conj = tokens[nextWordIdx]!;
    const first = conj.text[0]!;
    const capped = first.toUpperCase() + conj.text.slice(1);
    if (capped !== conj.text) {
      log.push({
        kind: "casing",
        from: conj.text,
        to: capped,
        mode,
      });
      tokens[nextWordIdx] = { ...conj, text: capped };
    }
    return;
  }
}

function findNextWordIndex(
  tokens: TextToken[],
  from: number,
  endExclusive: number,
): number {
  for (let i = from; i < endExclusive; i++) {
    const t = tokens[i]!;
    if (!t.isSeparator && t.text.length > 0) return i;
  }
  return -1;
}
