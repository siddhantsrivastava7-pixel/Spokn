import type { DetectedIntent } from "../types";
import { isListLike } from "../intent/sessionContext";
import type { AdaptiveRules, FeedbackEntry } from "./feedbackTypes";

export interface DeriveAdaptiveRulesOptions {
  /** Minimum number of matching events before a rule fires. Default 3. */
  minSupport?: number;
  /** Cap on per-intent bias magnitude. Default 0.2. */
  maxIntentBias?: number;
}

const DEFAULT_MIN_SUPPORT = 3;
const DEFAULT_MAX_INTENT_BIAS = 0.2;
const BIAS_PER_EVENT = 0.05;

/**
 * Produces an AdaptiveRules snapshot from accumulated feedback events.
 *
 * Signals extracted (all deterministic, threshold-based):
 *   1. **Filler exceptions**: when the user re-inserts a filler word the
 *      corrector removed, count it. Words that pass `minSupport` are added.
 *   2. **Hinglish dictionary overrides**: when the user re-cases a token the
 *      pipeline canonicalized (e.g. "Siddharth" → "Sid" over and over), adopt
 *      their casing after `minSupport` identical re-castings.
 *   3. **Intent bias**: when the user edits a paragraph output into a
 *      list-like one (or vice versa) `minSupport` times, add a small bias.
 *
 * The function is pure: same inputs → same rules. No randomness, no time.
 */
export function deriveAdaptiveRules(
  entries: FeedbackEntry[],
  opts: DeriveAdaptiveRulesOptions = {},
): AdaptiveRules {
  const minSupport = opts.minSupport ?? DEFAULT_MIN_SUPPORT;
  const maxBias = opts.maxIntentBias ?? DEFAULT_MAX_INTENT_BIAS;

  const fillerReinsertCounts = new Map<string, number>();
  const casingCounts = new Map<string, Map<string, number>>();
  const intentShiftCounts: Partial<Record<DetectedIntent, number>> = {};

  for (const entry of entries) {
    const rawTokens = tokensLower(entry.rawText);
    const formattedTokens = tokensLower(entry.formattedOutput);
    const correctedTokens = tokensLower(entry.userCorrected);

    countReinsertedFillers(entry, correctedTokens, fillerReinsertCounts);
    countCasingPreferences(rawTokens, entry.userCorrected, casingCounts);
    countIntentShift(entry, intentShiftCounts);
    // Parameter retained for future signals (e.g. splitting preference).
    void formattedTokens;
  }

  const fillerExceptions: string[] = [];
  for (const [word, n] of fillerReinsertCounts) {
    if (n >= minSupport) fillerExceptions.push(word);
  }
  fillerExceptions.sort();

  const hinglishDictionaryOverrides: Record<string, string> = {};
  for (const [lower, casings] of casingCounts) {
    const [best, count] = pickBest(casings);
    if (best && count >= minSupport) {
      hinglishDictionaryOverrides[lower] = best;
    }
  }

  const intentBias: Partial<Record<DetectedIntent, number>> = {};
  for (const [intent, n] of Object.entries(intentShiftCounts) as Array<[
    DetectedIntent,
    number,
  ]>) {
    if (n < minSupport) continue;
    const raw = (n - minSupport + 1) * BIAS_PER_EVENT;
    intentBias[intent] = Math.max(-maxBias, Math.min(maxBias, raw));
  }

  return {
    schemaVersion: 1,
    fillerExceptions,
    hinglishDictionaryOverrides,
    intentBias,
  };
}

// ── Signal extraction ───────────────────────────────────────────────────────

function countReinsertedFillers(
  entry: FeedbackEntry,
  correctedTokens: string[],
  counts: Map<string, number>,
): void {
  const correctedSet = new Set(correctedTokens);
  for (const c of entry.corrections) {
    if (c.kind !== "filler") continue;
    const removed = c.from.trim().toLowerCase();
    if (!removed) continue;
    // Did the user put it back?
    if (correctedSet.has(removed)) {
      counts.set(removed, (counts.get(removed) ?? 0) + 1);
    }
  }
}

function countCasingPreferences(
  rawTokens: string[],
  userCorrected: string,
  casingCounts: Map<string, Map<string, number>>,
): void {
  // Strip leading/trailing punctuation so "Raj." matches raw "raj".
  const userTokens = userCorrected
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
  const userTokenSet = new Set(userTokens);
  for (const lower of new Set(rawTokens)) {
    if (lower.length < 2) continue;
    for (const userTok of userTokenSet) {
      if (userTok.toLowerCase() !== lower) continue;
      if (userTok === lower) continue; // default (all-lower) isn't a preference
      const inner = casingCounts.get(lower) ?? new Map<string, number>();
      inner.set(userTok, (inner.get(userTok) ?? 0) + 1);
      casingCounts.set(lower, inner);
    }
  }
}

function countIntentShift(
  entry: FeedbackEntry,
  counts: Partial<Record<DetectedIntent, number>>,
): void {
  // Heuristic: if the user's corrected text has list markers and the detected
  // intent was paragraph, they probably wanted a list — credit bullet_list.
  // If the detected intent was a list and the user stripped the markers,
  // credit paragraph (negative bias on that list intent is cleaner to apply
  // directly via a paragraph increment).
  const hasListMarkers = /^\s*(•|-\s*\[\s*\]|-\s+|\d+\.)/m.test(entry.userCorrected);
  const wasListIntent = isListLike(entry.detectedIntent);

  if (!wasListIntent && hasListMarkers) {
    counts["bullet_list"] = (counts["bullet_list"] ?? 0) + 1;
  }
  if (wasListIntent && !hasListMarkers) {
    counts["paragraph"] = (counts["paragraph"] ?? 0) + 1;
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────

function tokensLower(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\-\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function pickBest(counts: Map<string, number>): [string | undefined, number] {
  let best: string | undefined;
  let bestCount = 0;
  for (const [k, n] of counts) {
    if (n > bestCount) {
      best = k;
      bestCount = n;
    }
  }
  return [best, bestCount];
}
