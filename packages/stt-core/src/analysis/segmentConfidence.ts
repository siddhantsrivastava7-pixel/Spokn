import type {
  ConfidenceLevel,
  ConfidenceTier,
  ScoredSegment,
  STTModelCapabilities,
  TranscriptSegment,
} from "../types";

/**
 * Locked confidence thresholds. Every consumer of confidence tiering — the
 * reprocessing scheduler, the correction-budget resolver, and the UI — must
 * read these constants so decisions stay consistent across the pipeline.
 */
export const CONFIDENCE_THRESHOLDS = {
  HIGH_MIN: 0.6,
  MEDIUM_MIN: 0.3,
} as const;

export interface ScoreSegmentsResult {
  segments: ScoredSegment[];
  qualityTier: ConfidenceTier;
  counts: Record<ConfidenceTier, number>;
}

export function tierFor(confidence: number): ConfidenceTier {
  if (confidence >= CONFIDENCE_THRESHOLDS.HIGH_MIN) return "HIGH";
  if (confidence >= CONFIDENCE_THRESHOLDS.MEDIUM_MIN) return "MEDIUM";
  return "LOW";
}

/**
 * Fallback tier for segments the runtime did not attach a confidence to.
 * Very short segments and repeated-token segments are suspicious → MEDIUM;
 * otherwise we trust the model → HIGH. This is intentionally conservative:
 * we never drop to LOW without a real confidence signal, because LOW
 * triggers the expensive reprocessing path.
 */
export function heuristicTier(seg: TranscriptSegment): ConfidenceTier {
  const durationMs = seg.endMs - seg.startMs;
  if (durationMs > 0 && durationMs < 300) return "MEDIUM";
  if (hasRepeatedTokens(seg.text)) return "MEDIUM";
  return "HIGH";
}

function hasRepeatedTokens(text: string): boolean {
  const tokens = text.trim().toLowerCase().split(/\s+/);
  if (tokens.length < 2) return false;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] && tokens[i] === tokens[i - 1]) return true;
  }
  return false;
}

export function scoreSegment(seg: TranscriptSegment): ScoredSegment {
  const tier =
    typeof seg.confidence === "number"
      ? tierFor(seg.confidence)
      : heuristicTier(seg);
  return { ...seg, tier };
}

/**
 * Thresholds for the normalized confidence band (`ConfidenceLevel`).
 * These are deliberately distinct from `CONFIDENCE_THRESHOLDS` — the legacy
 * bands drive existing correction-budget logic, while these drive newer
 * gating (selective reprocess, UI cues).
 */
export const NORMALIZED_CONFIDENCE_THRESHOLDS = {
  HIGH_MIN: 0.75,
  MEDIUM_MIN: 0.4,
} as const;

/** Baseline returned for models whose confidenceScale is "none". */
export const NORMALIZED_CONFIDENCE_NONE_BASELINE = 0.6;

export function confidenceLevelFor(normalized: number): ConfidenceLevel {
  if (normalized > NORMALIZED_CONFIDENCE_THRESHOLDS.HIGH_MIN) return "HIGH";
  if (normalized >= NORMALIZED_CONFIDENCE_THRESHOLDS.MEDIUM_MIN) return "MEDIUM";
  return "LOW";
}

/**
 * Normalize per-segment confidence into a single 0..1 scalar.
 *
 * Rules:
 *   - If the model declares `confidenceScale: "none"`, return the MEDIUM
 *     baseline (0.6). Thresholds are not meaningful for these backends.
 *   - If Whisper-style signals are present (avgLogprob / noSpeechProb /
 *     compressionRatio), combine them:
 *        score = sigmoid(avgLogprob) * 0.6
 *              + (1 - noSpeechProb)  * 0.3
 *              + compressionPenalty  * 0.1
 *   - Else fall back to `confidence` if present (treat as already-normalized).
 *   - Else return the MEDIUM baseline so downstream never sees NaN.
 *
 * Output is clamped to [0, 1].
 */
export function normalizeSegmentConfidence(
  segment: TranscriptSegment,
  modelCapabilities?: Pick<STTModelCapabilities, "confidenceScale">,
): number {
  if (modelCapabilities?.confidenceScale === "none") {
    return NORMALIZED_CONFIDENCE_NONE_BASELINE;
  }

  const hasDetailedSignals =
    typeof segment.avgLogprob === "number" ||
    typeof segment.noSpeechProb === "number" ||
    typeof segment.compressionRatio === "number";

  if (hasDetailedSignals) {
    const logprobPart = sigmoid(segment.avgLogprob ?? 0) * 0.6;
    const speechPart = (1 - clamp01(segment.noSpeechProb ?? 0)) * 0.3;
    const compressionPart = compressionPenalty(segment.compressionRatio) * 0.1;
    return clamp01(logprobPart + speechPart + compressionPart);
  }

  if (typeof segment.confidence === "number") {
    return clamp01(segment.confidence);
  }

  return NORMALIZED_CONFIDENCE_NONE_BASELINE;
}

function sigmoid(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return 1 / (1 + Math.exp(-x));
}

function compressionPenalty(ratio: number | undefined): number {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return 1;
  // Tighter 3-bucket scoring — whisper repeats/garbled output pushes the
  // ratio above 1.5 quickly, so we penalize earlier than the canonical 2.4.
  if (ratio > 2) return 0.5;
  if (ratio > 1.5) return 0.75;
  return 1;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * @param confidenceScale — the selected model's declared confidence semantics.
 *   "whisper" (or undefined) applies the threshold bands as before. "none"
 *   short-circuits to MEDIUM for every segment and strips any incidental
 *   `confidence` value so placeholders can't leak downstream.
 *
 * Attaches `normalizedConfidence`, `confidenceLevel`, and `smoothedConfidence`
 * to every scored segment (additive; legacy `tier` unchanged).
 */
export function scoreSegments(
  segments: TranscriptSegment[],
  confidenceScale?: "whisper" | "none",
): ScoreSegmentsResult {
  const caps = { confidenceScale } as Pick<STTModelCapabilities, "confidenceScale">;
  const perSegment: ScoredSegment[] =
    confidenceScale === "none"
      ? segments.map((seg) => {
          const { confidence: _dropped, ...rest } = seg;
          void _dropped;
          const normalizedConfidence = normalizeSegmentConfidence(rest, caps);
          return {
            ...rest,
            tier: "MEDIUM",
            normalizedConfidence,
            confidenceLevel: confidenceLevelFor(normalizedConfidence),
          } as ScoredSegment;
        })
      : segments.map((seg) => {
          const base = scoreSegment(seg);
          const normalizedConfidence = normalizeSegmentConfidence(seg, caps);
          return {
            ...base,
            normalizedConfidence,
            confidenceLevel: confidenceLevelFor(normalizedConfidence),
          };
        });
  const scored = smoothConfidence(perSegment);
  const counts: Record<ConfidenceTier, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const s of scored) counts[s.tier] += 1;
  return {
    segments: scored,
    qualityTier: aggregateTier(counts),
    counts,
  };
}

/**
 * Weighted 3-tap temporal smoothing over `normalizedConfidence` (fallback
 * chain: normalized → confidence → MEDIUM baseline).
 *
 *   smoothed = 0.6 * current + 0.2 * previous + 0.2 * next
 *
 * Edge handling: when a neighbor is absent (first/last segment) the current
 * segment's own value stands in for it, which keeps the weights summing to 1
 * and avoids artificially depressing the edges.
 *
 * Pure + O(n). Never mutates inputs; returns new segment objects with an
 * added `smoothedConfidence` field. Does not touch `normalizedConfidence`.
 */
export function smoothConfidence(segments: ScoredSegment[]): ScoredSegment[] {
  const n = segments.length;
  if (n === 0) return [];
  const baselines = segments.map(baseScoreFor);
  return segments.map((seg, i) => {
    const current = baselines[i]!;
    const prev = i > 0 ? baselines[i - 1]! : current;
    const next = i < n - 1 ? baselines[i + 1]! : current;
    const smoothed = clamp01(0.6 * current + 0.2 * prev + 0.2 * next);
    return { ...seg, smoothedConfidence: smoothed };
  });
}

function baseScoreFor(seg: ScoredSegment): number {
  if (typeof seg.normalizedConfidence === "number") return seg.normalizedConfidence;
  if (typeof seg.confidence === "number") return clamp01(seg.confidence);
  return NORMALIZED_CONFIDENCE_NONE_BASELINE;
}

/**
 * Aggregate tier: LOW if any segment is LOW, MEDIUM if any is MEDIUM,
 * else HIGH. Empty input is treated as HIGH (nothing to worry about).
 */
export function aggregateTier(counts: Record<ConfidenceTier, number>): ConfidenceTier {
  if (counts.LOW > 0) return "LOW";
  if (counts.MEDIUM > 0) return "MEDIUM";
  return "HIGH";
}
