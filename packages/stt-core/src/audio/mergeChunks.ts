import type { RuntimeTranscriptionResponse, TranscriptSegment } from "../types";

/**
 * Merges ordered chunk responses into a single flat segment list.
 * Adjusts segment timestamps by each chunk's start offset so segments are
 * relative to the beginning of the full audio file, not the chunk.
 */
export function mergeChunkResponses(
  responses: Array<{ response: RuntimeTranscriptionResponse; chunkStartMs: number }>
): { segments: TranscriptSegment[]; language: string; totalDurationMs: number } {
  const allSegments: TranscriptSegment[] = [];
  let detectedLanguage = "unknown";
  let totalDurationMs = 0;

  for (const { response, chunkStartMs } of responses) {
    for (const seg of response.segments) {
      allSegments.push({
        ...seg,
        startMs: seg.startMs + chunkStartMs,
        endMs: seg.endMs + chunkStartMs,
      });
    }

    if (response.language && response.language !== "unknown") {
      detectedLanguage = response.language;
    }

    totalDurationMs = Math.max(
      totalDurationMs,
      chunkStartMs + response.durationMs
    );
  }

  return { segments: allSegments, language: detectedLanguage, totalDurationMs };
}
