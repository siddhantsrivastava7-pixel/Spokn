import type { Transcript } from "../types";

/**
 * Contract for persisting and querying transcripts.
 * Intentionally minimal — platform bridges add any full-text search,
 * pagination, or sync capabilities they need.
 */
export interface TranscriptStorage {
  save(transcript: Transcript): Promise<void>;

  getById(id: string): Promise<Transcript | null>;

  /** Returns transcripts ordered by createdAt descending. */
  list(options?: { limit?: number; offset?: number }): Promise<Transcript[]>;

  delete(id: string): Promise<void>;
}
