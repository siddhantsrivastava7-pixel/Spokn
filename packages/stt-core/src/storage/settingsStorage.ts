import type { TranscriptionSettings } from "../types";

/**
 * Contract for persisting user transcription settings.
 * Implementations should survive app restarts and handle first-run gracefully
 * (returning null when nothing is stored yet).
 */
export interface SettingsStorage {
  load(): Promise<TranscriptionSettings | null>;
  save(settings: TranscriptionSettings): Promise<void>;
  reset(): Promise<void>;
}
