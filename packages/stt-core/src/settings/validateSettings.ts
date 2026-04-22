import type { TranscriptionSettings } from "../types";
import {
  VALID_MODES,
  VALID_LANGUAGES,
  CHUNK_DURATION_MIN_MS,
  CHUNK_DURATION_MAX_MS,
  MAX_DURATION_MIN_MS,
  MAX_DURATION_MAX_MS,
} from "./settingsSchema";
import { DEFAULT_SETTINGS } from "./defaultSettings";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validates a TranscriptionSettings object and returns structured errors. */
export function validateSettings(settings: TranscriptionSettings): ValidationResult {
  const errors: string[] = [];

  if (!VALID_MODES.includes(settings.mode)) {
    errors.push(`Invalid mode "${settings.mode}". Must be one of: ${VALID_MODES.join(", ")}`);
  }

  if (!VALID_LANGUAGES.includes(settings.language)) {
    errors.push(
      `Invalid language "${settings.language}". Must be one of: ${VALID_LANGUAGES.join(", ")}`
    );
  }

  if (typeof settings.timestamps !== "boolean") {
    errors.push(`"timestamps" must be a boolean`);
  }

  if (typeof settings.offlineOnly !== "boolean") {
    errors.push(`"offlineOnly" must be a boolean`);
  }

  if (settings.chunkDurationMs !== undefined) {
    if (
      settings.chunkDurationMs < CHUNK_DURATION_MIN_MS ||
      settings.chunkDurationMs > CHUNK_DURATION_MAX_MS
    ) {
      errors.push(
        `chunkDurationMs must be between ${CHUNK_DURATION_MIN_MS} and ${CHUNK_DURATION_MAX_MS}`
      );
    }
  }

  if (settings.maxDurationMs !== undefined) {
    if (
      settings.maxDurationMs < MAX_DURATION_MIN_MS ||
      settings.maxDurationMs > MAX_DURATION_MAX_MS
    ) {
      errors.push(
        `maxDurationMs must be between ${MAX_DURATION_MIN_MS} and ${MAX_DURATION_MAX_MS}`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Merges partial user settings over defaults. Does not validate the result. */
export function mergeWithDefaults(
  partial: Partial<TranscriptionSettings>
): TranscriptionSettings {
  return { ...DEFAULT_SETTINGS, ...partial };
}
