import type { TranscriptionSettings } from "../types";

export const DEFAULT_SETTINGS: Readonly<TranscriptionSettings> = {
  mode: "auto",
  language: "auto",
  timestamps: true,
  offlineOnly: true,
  chunkDurationMs: 60_000, // 1-minute chunks by default
};
