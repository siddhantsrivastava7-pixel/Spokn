import type { Transcript, TranscriptSegment } from "../types";

/** Joins all segment texts into a single normalized string. */
export function buildFullText(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");
}

/** Returns the average confidence across segments that report it. */
export function averageConfidence(segments: TranscriptSegment[]): number | undefined {
  const scored = segments.filter((s) => s.confidence !== undefined);
  if (scored.length === 0) return undefined;
  const sum = scored.reduce((acc, s) => acc + s.confidence!, 0);
  return sum / scored.length;
}

/** Returns segments within a given time range [fromMs, toMs]. */
export function sliceSegments(
  segments: TranscriptSegment[],
  fromMs: number,
  toMs: number
): TranscriptSegment[] {
  return segments.filter((s) => s.startMs >= fromMs && s.endMs <= toMs);
}

/** Returns the word count of the transcript full text. */
export function wordCount(transcript: Transcript): number {
  return transcript.fullText.trim().split(/\s+/).filter(Boolean).length;
}
