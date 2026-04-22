import type {
  AudioQualityMetrics,
  DecodingHints,
  ModelRef,
  TranscriptSegment,
} from "@stt/core";

export interface BackendTranscriptionRequest {
  audioPath: string;
  /**
   * Unambiguous model reference. whisper-cpp backends read `.path`;
   * transformers-js backends read `.modelId` (stt-core registry ID).
   * Backends must narrow on `kind` and reject the wrong variant.
   */
  model: ModelRef;
  language?: string;
  /** If true, backend should emit per-segment timestamps. */
  timestamps: boolean;
  startMs?: number;
  endMs?: number;
  prompt?: string;
  /**
   * Advisory decoder-accuracy hints. The backend translates these to its
   * underlying CLI flags (e.g. whisper.cpp --beam-size, --best-of).
   * Absent by default — primary transcription uses whatever the CLI defaults to.
   */
  decodingHints?: DecodingHints;
}

export interface BackendTranscriptionResponse {
  segments: TranscriptSegment[];
  detectedLanguage?: string;
  durationMs: number;
  confidence?: number;
  /** Raw backend output retained for debugging. */
  rawOutput?: string;
  /** Metrics from an adaptive preprocessor, if one wrapped this backend. */
  audioQuality?: AudioQualityMetrics;
  /** Preprocessing decision + reason, if applicable. */
  preprocessing?: {
    applied: boolean;
    reason:
      | "poor_quality"
      | "low_confidence_retry"
      | "skipped_clean_audio"
      | "budget_skip"
      | "mode_disabled";
    stages?: string[];
  };
}

/**
 * Backend abstraction: whisper.cpp is the first implementation.
 * A future backend (e.g. faster-whisper via HTTP or a different binary) can
 * implement this without touching the adapter or the model store.
 */
export interface LocalSTTBackend {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  transcribe(req: BackendTranscriptionRequest): Promise<BackendTranscriptionResponse>;
}
