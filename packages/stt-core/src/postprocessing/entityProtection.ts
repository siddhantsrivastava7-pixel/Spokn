/**
 * Identifies tokens that must not be modified by any downstream text transform.
 *
 * A protected token:
 *  - Casing is frozen.
 *  - Cannot be removed by filler detection.
 *  - Cannot have contractions expanded.
 *  - Remains byte-identical in correctedText.
 *
 * Heuristics — deliberately conservative. When in doubt, protect.
 */

/**
 * Characters that form a "word token" for tokenization purposes.
 * Includes letters (including non-Latin), digits, common ASCII internals
 * (hyphen, apostrophe, dot for decimals and URLs, @ for emails).
 */
const WORD_CHAR = /[\p{L}\p{N}._@\-+'’]/u;

export interface TextToken {
  /** The token's characters. */
  text: string;
  /** Index into the original string. */
  start: number;
  /** End index (exclusive). */
  end: number;
  /** True if this span is whitespace/punctuation between words. */
  isSeparator: boolean;
}

const URL_REGEX = /\b(?:https?:\/\/|www\.)\S+/gi;

/**
 * Split a string into alternating word-tokens and separator-tokens, preserving
 * spans. URLs are first carved out as atomic word-tokens so the internal `:/`
 * characters don't break them apart.
 */
export function tokenize(text: string): TextToken[] {
  // Pass 1: find URL spans — these become atomic word-tokens.
  const urlSpans: Array<[number, number]> = [];
  for (const m of text.matchAll(URL_REGEX)) {
    if (m.index !== undefined) {
      urlSpans.push([m.index, m.index + m[0].length]);
    }
  }

  const tokens: TextToken[] = [];
  let i = 0;
  let nextUrl = 0;
  while (i < text.length) {
    if (nextUrl < urlSpans.length && i === urlSpans[nextUrl]![0]) {
      const [start, end] = urlSpans[nextUrl]!;
      tokens.push({
        text: text.slice(start, end),
        start,
        end,
        isSeparator: false,
      });
      i = end;
      nextUrl++;
      continue;
    }
    const spanEnd =
      nextUrl < urlSpans.length ? urlSpans[nextUrl]![0] : text.length;
    const start = i;
    const isWord = WORD_CHAR.test(text[i] ?? "");
    while (i < spanEnd && WORD_CHAR.test(text[i] ?? "") === isWord) {
      i++;
    }
    tokens.push({
      text: text.slice(start, i),
      start,
      end: i,
      isSeparator: !isWord,
    });
  }
  return tokens;
}

/**
 * Returns true when `tok` is a word-token that must not be modified.
 *
 * `prevWordIndex` is the index of the previous word-token in the sequence
 * (for distinguishing position-0 from mid-sentence).
 */
export function isProtected(tok: TextToken, prevWordIndex: number): boolean {
  if (tok.isSeparator) return false;
  if (isNumericToken(tok.text)) return true;
  if (isEmail(tok.text)) return true;
  if (isUrl(tok.text)) return true;
  if (isMidSentenceCapitalized(tok.text, prevWordIndex)) return true;
  return false;
}

/**
 * Build a boolean mask the same length as `tokens` indicating protected tokens.
 */
export function protectionMask(tokens: TextToken[]): boolean[] {
  const mask: boolean[] = [];
  let prevWordIndex = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.isSeparator) {
      mask.push(false);
      continue;
    }
    mask.push(isProtected(t, prevWordIndex));
    prevWordIndex = i;
  }
  return mask;
}

// ── Heuristics ───────────────────────────────────────────────────────────────

function isNumericToken(s: string): boolean {
  // Matches: 42, 3.14, 1,000, 1:30, 10pm, $5, 50%, 2026-04-21
  return /^[+\-$]?\d+([.,:/\-]\d+)*[a-zA-Z%]{0,3}$/.test(s);
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function isUrl(s: string): boolean {
  return /^(https?:\/\/|www\.)\S+/i.test(s);
}

/**
 * A capitalized word appearing mid-sentence is a likely proper noun. We
 * don't know if it's at sentence position 0 (which could be just-capitalized
 * after a period); we approximate with "first word in the input".
 *
 * To avoid false positives we exempt a small set of common capitalized
 * words that appear mid-sentence legitimately (pronoun "I", days, months).
 */
function isMidSentenceCapitalized(s: string, prevWordIndex: number): boolean {
  if (prevWordIndex < 0) return false;
  if (s.length === 0) return false;
  const first = s[0]!;
  if (first !== first.toUpperCase() || first === first.toLowerCase()) return false;
  // Skip one-letter "I"/"A" — they're common and not proper nouns worth protecting.
  if (s.length === 1) return false;
  const lower = s.toLowerCase();
  if (COMMON_CAPITALIZED_EXEMPT.has(lower)) return false;
  return true;
}

const COMMON_CAPITALIZED_EXEMPT = new Set<string>([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]);
