import type { Transcript, TranscriptSegment } from "../types";
import { buildFullText } from "./transcriptUtils";
import { generateId } from "../utils/idGenerator";

/**
 * Merges two or more transcripts into one.
 * Useful when a long recording is processed as independent pieces and
 * the results need to be combined for storage or display.
 *
 * Transcripts must share the same modelId; if not, the first one wins for metadata.
 */
export function mergeTranscripts(transcripts: Transcript[]): Transcript {
  if (transcripts.length === 0) {
    throw new Error("Cannot merge an empty transcript list");
  }
  if (transcripts.length === 1) return transcripts[0];

  const base = transcripts[0];

  // Concatenate segments in order, preserving timestamps
  const allSegments: TranscriptSegment[] = transcripts.flatMap((t) => t.segments);
  allSegments.sort((a, b) => a.startMs - b.startMs);

  const totalDurationMs = transcripts.reduce((sum, t) => sum + t.durationMs, 0);

  // Post-processing doesn't re-run on merge, so correctedText can't be
  // re-derived from the merged segments. Fall back to concatenating each
  // transcript's correctedText to preserve their cleanups.
  const mergedRawText = buildFullText(allSegments);
  const mergedCorrectedText = transcripts
    .map((t) => t.correctedText ?? t.fullText)
    .filter((s) => s && s.trim().length > 0)
    .join(" ");

  return {
    id: generateId(),
    rawText: mergedRawText,
    correctedText: mergedCorrectedText || mergedRawText,
    // Deprecated alias — mirrors correctedText during migration.
    fullText: mergedCorrectedText || mergedRawText,
    language: base.language,
    modelId: base.modelId,
    mode: base.mode,
    durationMs: totalDurationMs,
    segments: allSegments,
    createdAt: new Date().toISOString(),
    metadata: {
      ...base.metadata,
      mergedFrom: transcripts.map((t) => t.id),
    },
  };
}
