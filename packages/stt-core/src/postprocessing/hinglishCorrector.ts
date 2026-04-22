import type { CorrectionBudget, CorrectionMode } from "./correctionMode";
import type { TextToken } from "./entityProtection";
import {
  HINGLISH_BIGRAMS,
  HINGLISH_CONTEXT_TOKENS,
  HINGLISH_DICTIONARY,
} from "./hinglishDictionary";
import type { CorrectionLogEntry } from "./processTypes";

export interface HinglishCorrectorOptions {
  /** Extra dictionary entries (e.g. from adaptive rules). Overrides defaults. */
  overrides?: Record<string, string>;
  /** Budget governing how much work we're allowed to do on this text. */
  budget: CorrectionBudget;
  /** Correction mode label — copied into audit entries. */
  mode: CorrectionMode;
}

export interface HinglishCorrectorResult {
  tokens: TextToken[];
  corrections: CorrectionLogEntry[];
}

const HINGLISH_CONTEXT_WINDOW = 6;

/**
 * Corrects a token stream's Hinglish style in-place (returns new tokens).
 *
 * Rules applied, in order, subject to per-segment budget:
 *  1. Two-word dictionary hits (bigrams) — merge adjacent tokens if they match.
 *  2. Single-word dictionary hits — canonical casing for Indian names + tech terms.
 *  3. "me" → "mein" when surrounding text looks Hinglish.
 *  4. Spacing around "na" / "haina" — handled by grammarCleanup later.
 *
 * Respects a protection mask so numbers, emails, URLs, and proper nouns stay
 * byte-identical.
 */
export function correctHinglish(
  tokens: TextToken[],
  mask: boolean[],
  opts: HinglishCorrectorOptions,
): HinglishCorrectorResult {
  const corrections: CorrectionLogEntry[] = [];
  const dict: Record<string, string> = {
    ...HINGLISH_DICTIONARY,
    ...(opts.overrides ?? {}),
  };

  // Index word tokens for neighborhood lookups.
  const wordPositions: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i]!.isSeparator) wordPositions.push(i);
  }

  const lowerTokens = tokens.map((t) =>
    t.isSeparator ? "" : t.text.toLowerCase(),
  );

  // Detect Hinglish context anywhere in the text — enables the "me"→"mein" rule
  // and informs downstream formatting.
  const hasHinglishMarkers = lowerTokens.some((t) =>
    HINGLISH_CONTEXT_TOKENS.has(t),
  );

  // Pass 1: bigrams. Operate on consecutive word tokens (skipping separators
  // that are pure whitespace — preserve them intact). If a bigram matches,
  // replace the pair of word tokens plus collapse the separator in between to
  // the bigram's canonical form as a single token.
  const out: TextToken[] = [...tokens];

  for (let k = 0; k < wordPositions.length - 1; k++) {
    const iA = wordPositions[k]!;
    const iB = wordPositions[k + 1]!;
    if (mask[iA] || mask[iB]) continue;
    const a = lowerTokens[iA]!;
    const b = lowerTokens[iB]!;
    const bigram = `${a} ${b}`;
    const replacement = HINGLISH_BIGRAMS[bigram];
    if (!replacement) continue;
    // Is the span between iA and iB just whitespace?
    const between = tokens
      .slice(iA + 1, iB)
      .map((t) => t.text)
      .join("");
    if (!/^\s+$/.test(between)) continue;
    const before = `${out[iA]!.text} ${out[iB]!.text}`;
    // Replace iA's text with the canonical form; null out iB by emptying.
    out[iA] = { ...out[iA]!, text: replacement };
    // Mark everything between and including iB as removed (empty separator).
    for (let j = iA + 1; j <= iB; j++) {
      out[j] = { ...out[j]!, text: "" };
    }
    corrections.push({
      kind: "hinglish",
      from: before,
      to: replacement,
      mode: opts.mode,
    });
  }

  // Pass 2: single-word dictionary.
  for (let i = 0; i < out.length; i++) {
    const t = out[i]!;
    if (t.isSeparator || t.text.length === 0) continue;
    if (mask[i]) continue;
    const lower = t.text.toLowerCase();
    const canonical = dict[lower];
    if (!canonical || canonical === t.text) continue;
    corrections.push({
      kind: "hinglish",
      from: t.text,
      to: canonical,
      mode: opts.mode,
    });
    out[i] = { ...t, text: canonical };
  }

  // Pass 3: "me" → "mein" in Hinglish context only.
  if (hasHinglishMarkers) {
    for (let i = 0; i < out.length; i++) {
      const t = out[i]!;
      if (t.isSeparator || t.text.length === 0) continue;
      if (mask[i]) continue;
      const lower = t.text.toLowerCase();
      if (lower !== "me") continue;
      if (!hasNearbyHinglishMarker(lowerTokens, i, HINGLISH_CONTEXT_WINDOW)) continue;
      corrections.push({
        kind: "hinglish",
        from: t.text,
        to: "mein",
        mode: opts.mode,
      });
      out[i] = { ...t, text: "mein" };
    }
  }

  return { tokens: out, corrections };
}

function hasNearbyHinglishMarker(
  lowerTokens: string[],
  index: number,
  radius: number,
): boolean {
  const start = Math.max(0, index - radius);
  const end = Math.min(lowerTokens.length, index + radius + 1);
  for (let j = start; j < end; j++) {
    if (j === index) continue;
    if (HINGLISH_CONTEXT_TOKENS.has(lowerTokens[j]!)) return true;
  }
  return false;
}

/**
 * Heuristic: true when the text looks Hinglish enough that we want to enable
 * the "me" → "mein" rule and surface the "Detected: Hinglish" UI indicator.
 * Called from processTranscript to decide the `hinglish === "auto"` branch.
 */
export function looksHinglish(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const tok of HINGLISH_CONTEXT_TOKENS) {
    if (new RegExp(`\\b${escapeRegex(tok)}\\b`).test(lower)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
