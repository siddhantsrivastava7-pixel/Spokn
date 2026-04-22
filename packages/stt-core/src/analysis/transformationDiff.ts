import type { TransformationLevel } from "../types";
import type { CorrectionLogEntry } from "../postprocessing/processTypes";

export interface TransformationDiff {
  level: TransformationLevel;
  /** Fraction of raw-text words missing from formatted text. */
  wordsRemovedPct: number;
  /** Fraction of formatted-text words not present in raw text. */
  wordsAddedPct: number;
  /** True when the output has structurally different block structure. */
  structuralChange: boolean;
  reasons: string[];
}

const HIGH_WORD_DELTA = 0.1;
const MEDIUM_WORD_DELTA = 0.02;

/**
 * Classify how much `formatted` diverges from `raw`.
 *
 * Inputs:
 *  - rawText: pre-post-processing full text
 *  - formattedOutput: final output shown to the user
 *  - corrections: the full audit log (helps attribute the level)
 *
 * The bands:
 *  - low: casing + punctuation only, no structural change, minor delta.
 *  - medium: filler removal, sentence splitting, light formatting.
 *  - high: full templates (email, meeting notes), or word delta > 10%.
 */
export function computeTransformationLevel(
  rawText: string,
  formattedOutput: string,
  corrections: CorrectionLogEntry[],
): TransformationDiff {
  const rawTokens = tokenize(rawText);
  const formattedTokens = tokenize(stripScaffolding(formattedOutput));

  const rawSet = new Map<string, number>();
  for (const t of rawTokens) rawSet.set(t, (rawSet.get(t) ?? 0) + 1);

  let missing = 0;
  for (const t of rawTokens) {
    const count = rawSet.get(t) ?? 0;
    if (count === 0) {
      missing++;
    } else {
      rawSet.set(t, count - 1);
    }
  }
  const formattedSet = new Map<string, number>();
  for (const t of formattedTokens) {
    formattedSet.set(t, (formattedSet.get(t) ?? 0) + 1);
  }
  const rawCounts = new Map<string, number>();
  for (const t of rawTokens) rawCounts.set(t, (rawCounts.get(t) ?? 0) + 1);

  let removed = 0;
  for (const [word, count] of rawCounts) {
    const inFormatted = formattedSet.get(word) ?? 0;
    if (inFormatted < count) removed += count - inFormatted;
  }
  let added = 0;
  for (const [word, count] of formattedSet) {
    const inRaw = rawCounts.get(word) ?? 0;
    if (count > inRaw) added += count - inRaw;
  }
  void missing;

  const wordsRemovedPct = rawTokens.length > 0 ? removed / rawTokens.length : 0;
  const wordsAddedPct = rawTokens.length > 0 ? added / rawTokens.length : 0;

  const hasScaffolding = corrections.some((c) => c.kind === "scaffolding");
  const structuralChange =
    hasScaffolding ||
    /^\s*(•|- \[ \]|\d+\.)/m.test(formattedOutput) ||
    /^(Subject:|Meeting Notes\b|Hi\s)/m.test(formattedOutput);

  const reasons: string[] = [];
  if (hasScaffolding) reasons.push("scaffolding_applied");
  if (wordsRemovedPct > MEDIUM_WORD_DELTA) reasons.push("filler_removed");
  if (corrections.some((c) => c.kind === "split")) reasons.push("sentences_split");
  if (corrections.some((c) => c.kind === "contraction")) reasons.push("contractions_expanded");

  let level: TransformationLevel = "low";
  const totalDelta = wordsRemovedPct + wordsAddedPct;
  if (hasFullTemplate(formattedOutput)) {
    level = "high";
  } else if (structuralChange) {
    // Bullet / numbered / todo lists — medium even if the trigger-phrase
    // stripping produces a large word delta.
    level = "medium";
  } else if (totalDelta > HIGH_WORD_DELTA) {
    level = "high";
  } else if (
    totalDelta > MEDIUM_WORD_DELTA ||
    corrections.some((c) => c.kind === "filler" || c.kind === "split")
  ) {
    level = "medium";
  }

  return {
    level,
    wordsRemovedPct,
    wordsAddedPct,
    structuralChange,
    reasons,
  };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\-\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Remove obvious scaffolding tokens so the word-delta math reflects content. */
function stripScaffolding(text: string): string {
  return text
    .replace(/^Subject:\s*\w+/im, "")
    .replace(/^Meeting Notes\s*/m, "")
    .replace(/^Best,\s*$/m, "")
    .replace(/^\[User\]\s*$/m, "")
    .replace(/^Hi\s+\S+,\s*$/m, "")
    .replace(/^\s*(•|- \[ \]|\d+\.)\s*/gm, "")
    .trim();
}

function hasFullTemplate(text: string): boolean {
  return (
    /^Subject:/m.test(text) ||
    /^Meeting Notes/m.test(text)
  );
}
