/**
 * Formatting-style preferences. Used by processTranscript to bias intent detection
 * and gate optional transforms (e.g. contraction expansion).
 */
export interface UserStylePreferences {
  /** Bias intent detection toward bullet / todo / numbered lists. */
  prefersLists?: boolean;
  /** Lower the sentence-splitting threshold. */
  prefersShortSentences?: boolean;
  /**
   * Tone:
   *  - "casual"  — keep contractions as-is.
   *  - "formal"  — expand contractions ("we're" → "we are"). This is the only
   *                transformation that may introduce whitespace between word pieces.
   *  - "neutral" — leave contractions untouched.
   */
  tone?: "casual" | "formal" | "neutral";
}

/**
 * Onboarding and preference signals collected from the user.
 * All fields are optional — routing degrades gracefully when data is absent.
 * This type is filled in by the platform app from onboarding UI;
 * stt-core never collects it directly.
 */
export interface UserSpeechProfile {
  /**
   * Schema version. Absent is treated as v1. Stamped by
   * `migrateUserSpeechProfile` when loading persisted data.
   */
  schemaVersion?: 1;
  /** Free-form region label (e.g. "South India", "Northern France"). Informational only. */
  region?: string;
  /** ISO 3166-1 alpha-2 country code, e.g. "IN", "US", "FR". Used for multilingual risk hints. */
  countryCode?: string;
  /**
   * BCP-47 language tags the user speaks as primary languages, e.g. ["en", "hi"].
   * These are broader than TranscriptionSettings.language — they represent what the
   * user actually speaks, not which engine language to force.
   */
  primaryLanguages?: string[];
  /** Languages the user may occasionally use (secondary, not primary). */
  secondaryLanguages?: string[];
  /** True when the user said they freely mix languages mid-sentence (code-switching). */
  mixesLanguages?: boolean;
  /** User's preferred transcription mode if they expressed a preference during onboarding. */
  preferredMode?: "auto" | "fast" | "balanced" | "best_accuracy";
  /** True when user asked to minimize battery drain (e.g. always-on transcription). */
  prefersLowBatteryUsage?: boolean;
  /** True when user asked to minimize storage use (e.g. storage-constrained device). */
  prefersLowStorageUsage?: boolean;
  /** Formatting-style preferences used by the post-processing pipeline. */
  stylePreferences?: UserStylePreferences;
}
