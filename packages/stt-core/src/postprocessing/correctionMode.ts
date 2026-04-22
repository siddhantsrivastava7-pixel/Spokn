import type { ScoredSegment } from "../types";

/**
 * Per-segment edit aggressiveness. Derived from confidence tier + reprocessed
 * state so a single transcript can mix modes when quality varies across segments.
 *
 * No mode inserts new words. The strict no-hallucination invariant holds across
 * all three: only removal (fillers), casing, punctuation, spacing, and sentence
 * boundary splits are permitted on content. Contraction expansion is a narrow
 * exception gated by explicit `tone === "formal"` opt-in.
 */
export type CorrectionMode = "strict" | "neutral" | "assertive";

export interface CorrectionBudget {
  allowCasing: boolean;
  allowPunctuation: boolean;
  allowFillerRemoval: boolean;
  allowSentenceSplit: boolean;
  allowRepeatedStopwordCollapse: boolean;
  /** Effective only when UserStylePreferences.tone === "formal". */
  allowContractionExpansion: boolean;
}

export function resolveCorrectionMode(seg: ScoredSegment): CorrectionMode {
  if (seg.tier === "HIGH") return "assertive";
  if (seg.tier === "MEDIUM") return "neutral";
  // LOW: trust reprocessed text more — raise to neutral. Otherwise strict.
  return seg.reprocessed ? "neutral" : "strict";
}

export function budgetFor(mode: CorrectionMode): CorrectionBudget {
  switch (mode) {
    case "strict":
      return {
        allowCasing: true,
        allowPunctuation: true,
        allowFillerRemoval: false,
        allowSentenceSplit: false,
        allowRepeatedStopwordCollapse: false,
        allowContractionExpansion: false,
      };
    case "neutral":
      return {
        allowCasing: true,
        allowPunctuation: true,
        allowFillerRemoval: true,
        allowSentenceSplit: true,
        allowRepeatedStopwordCollapse: false,
        allowContractionExpansion: false,
      };
    case "assertive":
      return {
        allowCasing: true,
        allowPunctuation: true,
        allowFillerRemoval: true,
        allowSentenceSplit: true,
        allowRepeatedStopwordCollapse: true,
        allowContractionExpansion: true,
      };
  }
}
