import type { DetectedIntent } from "../types";
import type { CorrectionLogEntry } from "../postprocessing/processTypes";

/**
 * A single feedback event: the user edited a formatted output into the
 * `userCorrected` form. Keeping the pre-edit state lets us diff and derive
 * deterministic rule updates.
 */
export interface FeedbackEntry {
  id: string;
  /** ISO 8601 timestamp. */
  recordedAt: string;
  rawText: string;
  formattedOutput: string;
  userCorrected: string;
  detectedIntent: DetectedIntent;
  intentConfidence: number;
  corrections: CorrectionLogEntry[];
  /** Optional: BCP-47 or stt-core SupportedLanguage the transcript was in. */
  language?: string;
}

/**
 * Pure rule deltas derived from accumulated feedback. Passed into
 * `transcribeFile({ adaptiveRules: ... })` to nudge the next transcription.
 *
 * Caps: intent biases are clamped at ±0.2 at consumption time; no individual
 * user can fully override base logic.
 */
export interface AdaptiveRules {
  /**
   * Schema version. Absent is treated as v1. Stamped by
   * `migrateAdaptiveRules` when loading persisted data.
   */
  schemaVersion?: 1;
  /** Filler words the user consistently re-inserts — we stop removing them. */
  fillerExceptions: string[];
  /** Preferred casings for dictionary tokens (e.g. "siddharth" → "Sid"). */
  hinglishDictionaryOverrides: Record<string, string>;
  /** Per-intent score adjustments. Signed; cap applied downstream. */
  intentBias: Partial<Record<DetectedIntent, number>>;
  /**
   * Deterministic word/phrase substitutions derived from repeated user
   * corrections (see `deriveReplacementRules`). Lowercased keys, exact-case
   * replacement values. Applied as a final post-processing pass.
   */
  replacements?: Record<string, string>;
}

/**
 * Platform-side store contract. Implementations MUST be append-only and
 * MUST NOT throw on read if the underlying file is missing — return empty.
 */
export interface FeedbackStore {
  append(entry: FeedbackEntry): Promise<void>;
  list(limit?: number): Promise<FeedbackEntry[]>;
  clear(): Promise<void>;
}
