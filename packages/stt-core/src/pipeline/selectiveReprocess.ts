import type {
  ScoredSegment,
  STTRuntimeAdapter,
  SupportedLanguage,
} from "../types";
import { tierFor } from "../analysis/segmentConfidence";
import type { LatencyBudget } from "./latencyBudget";

export interface SelectiveReprocessOptions {
  runtimeAdapter: STTRuntimeAdapter;
  audioPath: string;
  language: SupportedLanguage;
  timestamps: boolean;
  sampleRate?: number;
  prompt?: string;
  /** Primary model used for the first pass. Used as the always-works fallback. */
  primaryModelId: string;
  /** Explicit escalation model, if caller wants to force one. */
  reprocessModelId?: string;
  /**
   * Picker consulted when reprocessModelId is unset. Given installed ids,
   * returns the best escalation or undefined if none applies. Keeps this
   * module free of routing concerns.
   */
  pickEscalationModel?: (installedIds: string[]) => string | undefined;
  /** Hard cap on how many LOW segments may be reprocessed. Default 3. */
  maxSegmentsToReprocess?: number;
  /** Max in-flight reprocess calls. Default 2. */
  concurrency?: number;
  /** Optional budget — if remaining < perSegmentEstimateMs * 2, bail out. */
  budget?: LatencyBudget;
  /** Estimated wall-clock cost per segment reprocess. Default 400ms. */
  perSegmentEstimateMs?: number;
  /**
   * Minimum segment duration (ms) to consider for reprocessing. Segments
   * shorter than this are skipped — too little context for a higher-accuracy
   * decode to meaningfully improve. Default 400ms.
   */
  minSegmentDurationMs?: number;
}

const DEFAULT_MIN_SEGMENT_DURATION_MS = 400;

export interface SelectiveReprocessResult {
  /** Segments after reprocessing (original order preserved). */
  segments: ScoredSegment[];
  /** Count of segments actually reprocessed. */
  reprocessedCount: number;
  /** Model used for escalation, if different from primary. */
  escalationModelId?: string;
  /** Reasons stages were skipped (cap, budget, per-segment errors). */
  downgrades: string[];
}

const LEVENSHTEIN_REPLACE_THRESHOLD = 0.2;

/**
 * Runs selective reprocessing on LOW-confidence segments.
 *
 * Defaults to the always-works path: rerun each LOW slice with the *same*
 * primary model but higher-accuracy decoding flags. If a stronger model is
 * explicitly chosen (reprocessModelId) or picked by pickEscalationModel, that
 * is preferred.
 *
 * Errors on individual reprocess calls are caught and logged to downgrades;
 * the original segment is kept. This function never throws on per-segment
 * failures — the top-level pipeline needs continuity.
 */
export async function selectiveReprocess(
  segments: ScoredSegment[],
  opts: SelectiveReprocessOptions,
): Promise<SelectiveReprocessResult> {
  const cap = opts.maxSegmentsToReprocess ?? 3;
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const perSegmentEstimateMs = opts.perSegmentEstimateMs ?? 400;
  const minSegmentDurationMs =
    opts.minSegmentDurationMs ?? DEFAULT_MIN_SEGMENT_DURATION_MS;
  const downgrades: string[] = [];

  // Candidate filter:
  //   1. LOW tier (either legacy `tier` or normalized `confidenceLevel`)
  //   2. Segment duration above the minimum — short slices rarely benefit
  //      from a higher-accuracy rerun and waste the latency budget.
  // Sort by ascending confidence (worst first). Prefer `normalizedConfidence`
  // when present; fall back to legacy `confidence`.
  let shortSkipped = 0;
  const lowIndices = segments
    .map((seg, idx) => ({ seg, idx }))
    .filter((e) => isLowConfidence(e.seg))
    .filter((e) => {
      const durationMs = Math.max(0, e.seg.endMs - e.seg.startMs);
      if (durationMs < minSegmentDurationMs) {
        shortSkipped++;
        return false;
      }
      return true;
    })
    .sort((a, b) => sortKey(a.seg) - sortKey(b.seg))
    .map((e) => e.idx);

  if (shortSkipped > 0) {
    downgrades.push(`skipped_short_segments:${shortSkipped}`);
  }

  if (lowIndices.length === 0) {
    return { segments, reprocessedCount: 0, downgrades };
  }

  let toProcess = lowIndices;
  if (toProcess.length > cap) {
    downgrades.push("reprocess_cap_hit");
    toProcess = toProcess.slice(0, cap);
  }

  // Resolve escalation model. The always-works fallback is the primary itself.
  let escalationModelId = opts.reprocessModelId;
  if (!escalationModelId && opts.pickEscalationModel) {
    try {
      const installed = await opts.runtimeAdapter.getAvailableModelIds();
      escalationModelId = opts.pickEscalationModel(installed);
    } catch {
      // Keep escalation unset; we'll fall back to primary below.
    }
  }
  const modelForReprocess = escalationModelId ?? opts.primaryModelId;

  const out: ScoredSegment[] = segments.slice();
  let reprocessedCount = 0;
  let cursor = 0;

  const runOne = async (): Promise<void> => {
    while (cursor < toProcess.length) {
      const idx = toProcess[cursor++];
      if (idx === undefined) return;

      if (opts.budget && opts.budget.shouldSkip(perSegmentEstimateMs * 2)) {
        downgrades.push("skipped_reprocess_for_budget");
        return;
      }

      const original = out[idx];
      if (!original) continue;

      try {
        const response = await opts.runtimeAdapter.transcribe({
          modelId: modelForReprocess,
          audioPath: opts.audioPath,
          language: opts.language,
          timestamps: opts.timestamps,
          sampleRate: opts.sampleRate,
          prompt: opts.prompt,
          startMs: original.startMs,
          endMs: original.endMs,
          decodingHints: { highAccuracy: true },
        });

        const merged = mergeReprocessed(original, response.segments);
        out[idx] = merged;
        reprocessedCount++;
      } catch (err) {
        downgrades.push(
          `reprocess_error:${idx}:${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`,
        );
        // Keep the original segment as-is.
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, toProcess.length) }, runOne);
  await Promise.all(workers);

  return {
    segments: out,
    reprocessedCount,
    escalationModelId: escalationModelId ?? undefined,
    downgrades,
  };
}

/**
 * Merges the reprocess response back onto the original segment.
 *
 * - Joins returned sub-segments into a single text (preserves order).
 * - If the new text differs meaningfully (normalized Levenshtein > 0.2),
 *   replace. Otherwise keep the original text.
 * - Either way, mark reprocessed: true and stash originalText for audit.
 * - Re-tier using the new best-available confidence.
 */
function mergeReprocessed(
  original: ScoredSegment,
  reprocessSegments: Array<{ text: string; confidence?: number }>,
): ScoredSegment {
  const joinedText = reprocessSegments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();

  const newConfidence =
    averageConfidence(reprocessSegments.map((s) => s.confidence)) ??
    original.confidence;

  const distance =
    joinedText && original.text
      ? normalizedLevenshtein(original.text.trim(), joinedText)
      : 0;

  const replace = joinedText.length > 0 && distance > LEVENSHTEIN_REPLACE_THRESHOLD;

  return {
    ...original,
    text: replace ? joinedText : original.text,
    confidence: newConfidence,
    tier: newConfidence !== undefined ? tierFor(newConfidence) : original.tier,
    reprocessed: true,
    originalText: original.text,
  };
}

function averageConfidence(values: Array<number | undefined>): number | undefined {
  const nums = values.filter((v): v is number => typeof v === "number");
  if (nums.length === 0) return undefined;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * A segment qualifies as LOW when either:
 *   - the legacy `tier` is LOW, or
 *   - the new `confidenceLevel` is LOW.
 * We honor both so older scoring paths keep working while the normalized
 * level gradually becomes the source of truth.
 */
function isLowConfidence(seg: ScoredSegment): boolean {
  if (seg.confidenceLevel === "LOW") return true;
  return seg.tier === "LOW";
}

/**
 * Sort key: lower is worse — reprocess worst segments first.
 * Preference: smoothedConfidence → normalizedConfidence → legacy confidence.
 * Using the smoothed value damps a single lucky/unlucky segment so we spend
 * the reprocess budget on genuinely troubled regions, not spikes.
 */
function sortKey(seg: ScoredSegment): number {
  if (typeof seg.smoothedConfidence === "number") return seg.smoothedConfidence;
  if (typeof seg.normalizedConfidence === "number") return seg.normalizedConfidence;
  return seg.confidence ?? 0;
}

/**
 * Normalized Levenshtein distance in [0, 1]. 0 = identical, 1 = fully different.
 * Token-level (not char-level) — matches our "meaningfully different" intuition
 * and is cheaper on longer inputs.
 */
export function normalizedLevenshtein(a: string, b: string): number {
  const aTokens = a.toLowerCase().split(/\s+/).filter(Boolean);
  const bTokens = b.toLowerCase().split(/\s+/).filter(Boolean);
  if (aTokens.length === 0 && bTokens.length === 0) return 0;
  const dist = tokenLevenshtein(aTokens, bTokens);
  return dist / Math.max(aTokens.length, bTokens.length);
}

function tokenLevenshtein(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]!;
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = Math.min(prev, dp[j]!, dp[j - 1]!) + 1;
      }
      prev = temp;
    }
  }
  return dp[n]!;
}
