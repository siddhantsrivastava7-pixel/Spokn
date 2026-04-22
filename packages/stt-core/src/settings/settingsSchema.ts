import type { TranscriptionMode, SupportedLanguage } from "../types";

export const VALID_MODES: TranscriptionMode[] = [
  "auto",
  "fast",
  "balanced",
  "best_accuracy",
];

export const VALID_LANGUAGES: SupportedLanguage[] = [
  "auto",
  "en",
  "hi",
  "hinglish",
  "multilingual",
];

export const CHUNK_DURATION_MIN_MS = 5_000;    // 5 seconds
export const CHUNK_DURATION_MAX_MS = 300_000;  // 5 minutes
export const MAX_DURATION_MIN_MS = 1_000;
export const MAX_DURATION_MAX_MS = 7_200_000;  // 2 hours
