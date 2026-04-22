import type { ScoredSegment, TranscriptSegment } from "../types";

/**
 * Coarse-grained formatting intent. Separate from the richer `DetectedIntent`
 * taxonomy in intent/intentClassifier — this one drives `formatByIntent` in
 * `formatTranscript.ts` and is intentionally small so all branches stay
 * deterministic and fast (O(segments)).
 */
export type FormatIntent = "PARAGRAPH" | "LIST" | "COMMAND" | "NOTE";

/**
 * Multi-intent result from `detectIntentHybrid`. `primary` drives the main
 * formatter; `secondary` (if present) unlocks hybrid formatting paths such
 * as "list of commands".
 */
export interface IntentResult {
  primary: FormatIntent;
  secondary?: FormatIntent;
}

/** Imperative verbs used by both intent detection and list-command formatting. */
export const COMMAND_VERBS: ReadonlySet<string> = new Set([
  "buy", "send", "create", "open", "call", "remind", "schedule", "set",
  "start", "stop", "play", "pause", "email", "text", "message", "add",
  "remove", "delete", "book", "order", "find", "search", "turn",
]);

const LIST_KEYWORDS: ReadonlySet<string> = new Set([
  "list", "lists", "items", "points", "todo", "todos", "agenda",
  "checklist", "bullets",
]);

const HYBRID_COMMA_CHAIN_MAX_WORDS = 20;

// ── Thresholds ──────────────────────────────────────────────────────────────
const SHORT_SEGMENT_WORD_MAX = 6;
const SHORT_SEGMENT_PAUSE_MIN_MS = 300;
const LIST_MIN_SEGMENTS = 3;
const LIST_SHORT_RATIO_MIN = 0.6;
const LIST_PAUSE_RATIO_MIN = 0.5;
const LIST_AVG_WORDS_MAX_SHORT = 4;
const LIST_AVG_WORDS_MAX_PAUSE = 8;
const REPETITION_RATIO_MIN = 0.5;
const COMMAND_MAX_WORDS = 12;
const PARAGRAPH_MIN_WORDS = 12;
const PARAGRAPH_MAX_PAUSE_RATIO = 0.3;

/**
 * Detect the coarse formatting intent from segments + full text.
 *
 * Deterministic, no NLP libs. Signal pipeline (all O(segments)):
 *   1. Explicit LIST keyword → LIST
 *   2. For multi-segment inputs, compute shortRatio, pauseRatio,
 *      avgWordsPerSeg, and a "repeated first word" signal.
 *   3. Any of: many-short, very-short-avg, moderate-pauses-with-short-avg,
 *      or repeated-structure → LIST.
 *   4. Imperative verb + small total → COMMAND.
 *   5. Long continuous segments with few pauses → PARAGRAPH.
 *   6. Fallback → NOTE.
 */
export function detectIntent(
  segments: ReadonlyArray<TranscriptSegment | ScoredSegment>,
  fullText: string,
): FormatIntent {
  const text = fullText.trim();
  if (!text) return "NOTE";

  const words = tokenizeWords(text);
  if (words.length === 0) return "NOTE";

  if (hasListKeyword(words)) return "LIST";

  const signals = computeSignals(segments, words);

  if (signals.segCount >= LIST_MIN_SEGMENTS) {
    if (signals.shortRatio >= LIST_SHORT_RATIO_MIN) return "LIST";
    if (signals.avgWordsPerSeg > 0 && signals.avgWordsPerSeg <= LIST_AVG_WORDS_MAX_SHORT) {
      return "LIST";
    }
    if (
      signals.pauseRatio >= LIST_PAUSE_RATIO_MIN &&
      signals.avgWordsPerSeg <= LIST_AVG_WORDS_MAX_PAUSE
    ) {
      return "LIST";
    }
    if (signals.repeatedFirstWord) return "LIST";
  }

  if (looksLikeCommand(words)) return "COMMAND";

  if (signals.segCount <= 1 && words.length >= PARAGRAPH_MIN_WORDS) {
    return "PARAGRAPH";
  }
  if (
    signals.avgWordsPerSeg >= PARAGRAPH_MIN_WORDS &&
    signals.pauseRatio < PARAGRAPH_MAX_PAUSE_RATIO
  ) {
    return "PARAGRAPH";
  }

  return "NOTE";
}

// ── Signal extraction ───────────────────────────────────────────────────────

interface IntentSignals {
  segCount: number;
  avgWordsPerSeg: number;
  shortRatio: number;
  pauseRatio: number;
  repeatedFirstWord: boolean;
}

function computeSignals(
  segments: ReadonlyArray<TranscriptSegment | ScoredSegment>,
  words: string[],
): IntentSignals {
  const segCount = segments.length;
  if (segCount === 0) {
    return { segCount: 0, avgWordsPerSeg: words.length, shortRatio: 0, pauseRatio: 0, repeatedFirstWord: false };
  }

  const avgWordsPerSeg = words.length / segCount;

  let shortCount = 0;
  let pauseCount = 0;
  const firstWords = new Map<string, number>();

  for (let i = 0; i < segCount; i++) {
    const seg = segments[i]!;
    const segWords = tokenizeWords(seg.text);
    if (segWords.length > 0 && segWords.length <= SHORT_SEGMENT_WORD_MAX) {
      shortCount++;
    }
    const first = segWords[0];
    if (first) firstWords.set(first, (firstWords.get(first) ?? 0) + 1);
    const next = segments[i + 1];
    if (next && next.startMs - seg.endMs >= SHORT_SEGMENT_PAUSE_MIN_MS) {
      pauseCount++;
    }
  }

  const pauseRatio = segCount > 1 ? pauseCount / (segCount - 1) : 0;
  const shortRatio = shortCount / segCount;

  let repeatedFirstWord = false;
  if (segCount >= 3) {
    for (const c of firstWords.values()) {
      if (c / segCount >= REPETITION_RATIO_MIN) {
        repeatedFirstWord = true;
        break;
      }
    }
  }

  return { segCount, avgWordsPerSeg, shortRatio, pauseRatio, repeatedFirstWord };
}

function hasListKeyword(words: string[]): boolean {
  for (const w of words) {
    if (LIST_KEYWORDS.has(w)) return true;
  }
  return false;
}

function looksLikeCommand(words: string[]): boolean {
  if (words.length === 0 || words.length > COMMAND_MAX_WORDS) return false;
  const first = words[0];
  return first !== undefined && COMMAND_VERBS.has(first);
}

function tokenizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// ── Hybrid (multi-intent) detection ─────────────────────────────────────────

/**
 * Detect both a primary and an optional secondary intent.
 *
 * Additive to `detectIntent` — existing single-return consumers are not
 * affected. A few cases where secondary is meaningful:
 *
 *   - "buy milk, eggs and call mom"     → LIST + COMMAND
 *   - "email ryan, mark and tara"       → LIST + COMMAND
 *   - "the roadmap is set. call me"     → PARAGRAPH + COMMAND
 *
 * Ordering of checks is deterministic. A short comma/and-chain (≤ 20 words)
 * promotes the utterance to LIST even when it also starts with an
 * imperative verb — the structured intent wins on format, the verb
 * survives as secondary so the formatter can inherit it per bullet.
 */
export function detectIntentHybrid(
  segments: ReadonlyArray<TranscriptSegment | ScoredSegment>,
  fullText: string,
): IntentResult {
  const text = fullText.trim();
  if (!text) return { primary: "NOTE" };

  const words = tokenizeWords(text);
  if (words.length === 0) return { primary: "NOTE" };

  const listKeyword = hasListKeyword(words);
  const commaChain = hasCommaAndChain(text, words.length);
  const command = looksLikeCommand(words);
  const multiSegListSignals =
    segments.length >= LIST_MIN_SEGMENTS && hasMultiSegmentListSignals(segments, words);

  const listLike = listKeyword || commaChain || multiSegListSignals;

  let primary: FormatIntent;
  if (listLike) {
    primary = "LIST";
  } else if (command) {
    primary = "COMMAND";
  } else {
    primary = detectIntent(segments, fullText);
  }

  let secondary: FormatIntent | undefined;
  if (primary === "LIST" && command) secondary = "COMMAND";
  else if (primary === "COMMAND" && listLike) secondary = "LIST";
  else if (primary === "PARAGRAPH" && command) secondary = "COMMAND";
  else if (primary === "PARAGRAPH" && listLike) secondary = "LIST";

  return secondary ? { primary, secondary } : { primary };
}

function hasCommaAndChain(text: string, wordCount: number): boolean {
  if (wordCount > HYBRID_COMMA_CHAIN_MAX_WORDS) return false;
  const commas = (text.match(/,/g) ?? []).length;
  const hasAnd = /\band\b/i.test(text);
  if (commas >= 2) return true;
  return commas >= 1 && hasAnd;
}

function hasMultiSegmentListSignals(
  segments: ReadonlyArray<TranscriptSegment | ScoredSegment>,
  words: string[],
): boolean {
  const s = computeSignals(segments, words);
  if (s.shortRatio >= LIST_SHORT_RATIO_MIN) return true;
  if (s.avgWordsPerSeg > 0 && s.avgWordsPerSeg <= LIST_AVG_WORDS_MAX_SHORT) return true;
  if (s.pauseRatio >= LIST_PAUSE_RATIO_MIN && s.avgWordsPerSeg <= LIST_AVG_WORDS_MAX_PAUSE) {
    return true;
  }
  if (s.repeatedFirstWord) return true;
  return false;
}
