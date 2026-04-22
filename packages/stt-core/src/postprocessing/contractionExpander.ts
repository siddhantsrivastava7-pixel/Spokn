import type { CorrectionBudget, CorrectionMode } from "./correctionMode";
import type { TextToken } from "./entityProtection";
import type { CorrectionLogEntry } from "./processTypes";

export interface ContractionExpanderOptions {
  budget: CorrectionBudget;
  mode: CorrectionMode;
  /** Only "formal" activates expansion. */
  tone?: "casual" | "formal" | "neutral";
}

export interface ContractionExpanderResult {
  tokens: TextToken[];
  corrections: CorrectionLogEntry[];
}

/**
 * Canonical contraction → expanded form. Lowercased keys; output preserves
 * leading-uppercase casing when the input was capitalized.
 *
 * One-directional by design: this module never introduces contractions.
 */
const CONTRACTIONS: Record<string, string> = {
  "i'm": "I am",
  "i've": "I have",
  "i'll": "I will",
  "i'd": "I would",
  "we're": "we are",
  "we've": "we have",
  "we'll": "we will",
  "we'd": "we would",
  "you're": "you are",
  "you've": "you have",
  "you'll": "you will",
  "you'd": "you would",
  "they're": "they are",
  "they've": "they have",
  "they'll": "they will",
  "they'd": "they would",
  "he's": "he is",
  "he'll": "he will",
  "he'd": "he would",
  "she's": "she is",
  "she'll": "she will",
  "she'd": "she would",
  "it's": "it is",
  "it'll": "it will",
  "it'd": "it would",
  "that's": "that is",
  "that'll": "that will",
  "there's": "there is",
  "there're": "there are",
  "who's": "who is",
  "what's": "what is",
  "where's": "where is",
  "let's": "let us",
  "don't": "do not",
  "doesn't": "does not",
  "didn't": "did not",
  "isn't": "is not",
  "aren't": "are not",
  "wasn't": "was not",
  "weren't": "were not",
  "haven't": "have not",
  "hasn't": "has not",
  "hadn't": "had not",
  "won't": "will not",
  "wouldn't": "would not",
  "can't": "cannot",
  "couldn't": "could not",
  "shouldn't": "should not",
  "mustn't": "must not",
  "might've": "might have",
  "could've": "could have",
  "would've": "would have",
  "should've": "should have",
};

export function expandContractions(
  tokens: TextToken[],
  mask: boolean[],
  opts: ContractionExpanderOptions,
): ContractionExpanderResult {
  const corrections: CorrectionLogEntry[] = [];
  if (!opts.budget.allowContractionExpansion) {
    return { tokens, corrections };
  }
  if (opts.tone !== "formal") {
    return { tokens, corrections };
  }

  const out = tokens.map((t) => ({ ...t }));
  for (let i = 0; i < out.length; i++) {
    const t = out[i]!;
    if (t.isSeparator || t.text.length === 0) continue;
    if (mask[i]) continue;
    const expanded = expandOne(t.text);
    if (expanded === undefined) continue;
    corrections.push({
      kind: "contraction",
      from: t.text,
      to: expanded,
      mode: opts.mode,
    });
    out[i] = { ...t, text: expanded };
  }
  return { tokens: out, corrections };
}

function expandOne(word: string): string | undefined {
  const lower = word.toLowerCase();
  const expansion = CONTRACTIONS[lower];
  if (!expansion) return undefined;
  // Preserve initial capitalization.
  const firstChar = word[0];
  if (firstChar && firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase()) {
    return expansion[0]!.toUpperCase() + expansion.slice(1);
  }
  return expansion;
}
