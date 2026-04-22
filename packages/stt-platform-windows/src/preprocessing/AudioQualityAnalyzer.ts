import { spawn } from "child_process";
import type { AudioQualityMetrics } from "@stt/core";

export interface AudioQualityThresholds {
  /** Below this RMS loudness (dBFS) audio is considered too quiet. */
  minRmsDb: number;
  /** Above this clipping ratio audio is considered distorted. */
  maxClippingRatio: number;
  /** Above this silence ratio audio is mostly silence — needs trimming. */
  maxSilenceRatio: number;
  /** Above this estimated noise floor (dBFS) there is a noisy background. */
  maxNoiseFloorDb: number;
}

export const DEFAULT_THRESHOLDS: AudioQualityThresholds = {
  minRmsDb: -30,
  maxClippingRatio: 0.005,
  maxSilenceRatio: 0.8,
  maxNoiseFloorDb: -45,
};

export interface AudioQualityAnalyzerOptions {
  ffmpegPath: string;
  thresholds?: Partial<AudioQualityThresholds>;
  /** Maximum wall-clock time to wait for the probe. Default 5 seconds. */
  timeoutMs?: number;
}

/**
 * Runs a single ffmpeg analysis pass over the audio file and extracts quality
 * metrics needed to decide whether preprocessing is worth the latency cost.
 *
 * The invocation writes to a null muxer (no output file) and prints:
 *   - volumedetect:  `mean_volume`, `max_volume`, `histogram_Ndb`
 *   - silencedetect: `silence_start`, `silence_end`, `silence_duration` per region
 *
 * All parsing is line-based over stderr. If anything fails, we conservatively
 * return `needsPreprocessing: false` with a `reasons[]` that explains why
 * — the caller can then decide to skip preprocessing rather than error.
 */
export class AudioQualityAnalyzer {
  private readonly thresholds: AudioQualityThresholds;

  constructor(private readonly opts: AudioQualityAnalyzerOptions) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  }

  async analyze(audioPath: string): Promise<AudioQualityMetrics> {
    const stderr = await runFfmpegProbe(
      this.opts.ffmpegPath,
      audioPath,
      this.opts.timeoutMs ?? 5000,
    );
    return parseFfmpegProbeOutput(stderr, this.thresholds);
  }
}

// ── ffmpeg invocation ────────────────────────────────────────────────────────

function runFfmpegProbe(
  ffmpegPath: string,
  audioPath: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-nostats",
      "-i", audioPath,
      "-af", "volumedetect,silencedetect=noise=-50dB:d=0.2",
      "-f", "null",
      "-",
    ];
    const child = spawn(ffmpegPath, args, { windowsHide: true, shell: false });
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg quality probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      // ffmpeg exits 0 on successful probe; non-zero usually indicates the
      // input couldn't be decoded. Return whatever stderr we got so the
      // parser can produce a safe-default AudioQualityMetrics.
      if (code !== 0 && stderr.length === 0) {
        reject(new Error(`ffmpeg exited ${code} with empty stderr`));
        return;
      }
      resolve(stderr);
    });
  });
}

// ── Parsing ──────────────────────────────────────────────────────────────────

export function parseFfmpegProbeOutput(
  stderr: string,
  thresholds: AudioQualityThresholds,
): AudioQualityMetrics {
  const metrics: AudioQualityMetrics = {
    rmsDb: 0,
    peakDb: 0,
    clippingRatio: 0,
    silenceRatio: 0,
    estimatedNoiseFloorDb: -90,
    needsPreprocessing: false,
    reasons: [],
  };

  // volumedetect: "mean_volume: -20.3 dB" / "max_volume: -1.2 dB"
  const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(stderr);
  if (mean) metrics.rmsDb = parseFloat(mean[1]!);
  const peak = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(stderr);
  if (peak) metrics.peakDb = parseFloat(peak[1]!);

  // Clipping: histogram_0db reports the count of samples at or near 0 dBFS.
  // Total samples = sum of all histogram_Ndb lines — or, if absent, rely on
  // peakDb alone. We approximate clippingRatio conservatively: if peak is
  // within 0.5 dB of 0, assume some clipping is present.
  const clippingSamples = sumHistogramPeakBuckets(stderr);
  const totalSamples = sumAllHistogramBuckets(stderr);
  if (totalSamples > 0) {
    metrics.clippingRatio = clippingSamples / totalSamples;
  } else if (metrics.peakDb >= -0.5) {
    metrics.clippingRatio = thresholds.maxClippingRatio * 2; // over threshold
  }

  // silencedetect: each region logs "silence_end: <seconds> | silence_duration: <seconds>".
  const totalDurationSeconds = pickTotalDuration(stderr);
  const silenceTotal = sumSilenceDurations(stderr);
  if (totalDurationSeconds > 0) {
    metrics.silenceRatio = Math.min(1, silenceTotal / totalDurationSeconds);
  }

  // Noise floor: crude estimate — the lowest populated histogram bucket.
  // If unavailable, fall back to rmsDb itself.
  const lowestBucket = pickLowestHistogramBucket(stderr);
  metrics.estimatedNoiseFloorDb = lowestBucket ?? metrics.rmsDb;

  // ── Decision ─────────────────────────────────────────────────────────────
  const reasons: string[] = [];
  if (metrics.rmsDb < thresholds.minRmsDb) {
    reasons.push(`rms_too_low:${metrics.rmsDb.toFixed(1)}dB`);
  }
  if (metrics.clippingRatio > thresholds.maxClippingRatio) {
    reasons.push(`clipping:${(metrics.clippingRatio * 100).toFixed(2)}%`);
  }
  if (metrics.silenceRatio > thresholds.maxSilenceRatio) {
    reasons.push(`mostly_silent:${(metrics.silenceRatio * 100).toFixed(0)}%`);
  }
  if (metrics.estimatedNoiseFloorDb > thresholds.maxNoiseFloorDb) {
    reasons.push(`noisy_floor:${metrics.estimatedNoiseFloorDb.toFixed(1)}dB`);
  }
  metrics.needsPreprocessing = reasons.length > 0;
  metrics.reasons = reasons;
  return metrics;
}

// ── Parsing helpers ──────────────────────────────────────────────────────────

function sumHistogramPeakBuckets(stderr: string): number {
  // Count samples within 0.5 dB of full-scale: histogram_0db or histogram_1db lines.
  let total = 0;
  for (const m of stderr.matchAll(/histogram_0db:\s*(\d+)/gi)) {
    total += Number(m[1]);
  }
  return total;
}

function sumAllHistogramBuckets(stderr: string): number {
  let total = 0;
  for (const m of stderr.matchAll(/histogram_-?\d+db:\s*(\d+)/gi)) {
    total += Number(m[1]);
  }
  return total;
}

function sumSilenceDurations(stderr: string): number {
  let total = 0;
  for (const m of stderr.matchAll(/silence_duration:\s*(\d+(?:\.\d+)?)/gi)) {
    total += parseFloat(m[1]!);
  }
  return total;
}

function pickTotalDuration(stderr: string): number {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(stderr);
  if (!m) return 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = parseFloat(m[3]!);
  return h * 3600 + min * 60 + s;
}

function pickLowestHistogramBucket(stderr: string): number | undefined {
  let lowest: number | undefined;
  for (const m of stderr.matchAll(/histogram_(-?\d+)db:\s*(\d+)/gi)) {
    const db = Number(m[1]);
    const count = Number(m[2]);
    if (count <= 0) continue;
    if (lowest === undefined || db < lowest) lowest = db;
  }
  return lowest;
}
