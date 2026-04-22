import type {
  AudioQualityMetrics,
  ConfidenceTier,
  IntentDetection,
  ProcessingMode,
  ScoredSegment,
  TranscriptionMode,
  Transcript,
  TranscriptSegment,
  TransformationLevel,
} from "../types";
import { buildFullText } from "../transcript/transcriptUtils";
import { generateId } from "../utils/idGenerator";
import { nowISO } from "../utils/timeUtils";

export interface FinalizeParams {
  segments: TranscriptSegment[] | ScoredSegment[];
  language: string;
  durationMs: number;
  modelId: string;
  mode: TranscriptionMode;
  metadata?: Record<string, unknown>;

  /**
   * Deterministic post-processing output. When provided, the final transcript's
   * `correctedText` is set to this value and `fullText` is aliased to it for
   * backward compatibility. When absent (e.g. pre-post-processing emissions),
   * `correctedText` falls back to `rawText` so consumers always have a value.
   */
  correctedText?: string;

  // New optional fields — all backward-compatible.
  formattedOutput?: string;
  detectedIntent?: IntentDetection;
  qualityTier?: ConfidenceTier;
  audioQuality?: AudioQualityMetrics;
  preprocessing?: Transcript["preprocessing"];
  latencyMs?: number;
  latencyBreakdown?: Record<string, number>;
  processingMode?: ProcessingMode;
  transformationLevel?: TransformationLevel;
  downgrades?: string[];
  isFinal?: boolean;
  version?: number;
  fallbackUsed?: boolean;
  fallbackStage?: string;
  fallbackError?: string;
  modelFallbackChain?: string[];
  /** Pre-existing id (partial emissions preserve it); generated when absent. */
  id?: string;
}

/**
 * Assembles a normalized Transcript from raw segments produced by the pipeline.
 * Sorting, deduplication, and text normalization happen here so callers
 * always receive a consistent output shape.
 */
export function finalizeTranscript(params: FinalizeParams): Transcript {
  const {
    segments,
    language,
    durationMs,
    modelId,
    mode,
    metadata = {},
    id,
    isFinal,
    version,
    correctedText: correctedFromParams,
    ...rest
  } = params;

  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  const deduped = deduplicateSegments(sorted);
  const rawText = buildFullText(deduped);
  // When post-processing produced a correctedText, use it. Otherwise fall back
  // to rawText so consumers always have a non-empty canonical string.
  const correctedText = correctedFromParams ?? rawText;

  const transcript: Transcript = {
    id: id ?? generateId(),
    rawText,
    correctedText,
    // Deprecated alias — mirrors correctedText during migration. Remove when
    // all consumers have migrated to correctedText/rawText.
    fullText: correctedText,
    language,
    modelId,
    mode,
    durationMs,
    segments: deduped,
    createdAt: nowISO(),
    metadata,
    isFinal: isFinal ?? true,
    version: version ?? 3,
  };

  // Copy optional fields only when defined — keeps omitted ones truly absent.
  const assignable = transcript as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) {
      assignable[key] = value;
    }
  }

  return transcript;
}

function deduplicateSegments<T extends TranscriptSegment>(segments: T[]): T[] {
  const seen = new Set<string>();
  return segments.filter((seg) => {
    const key = `${seg.startMs}:${seg.endMs}:${seg.text.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
