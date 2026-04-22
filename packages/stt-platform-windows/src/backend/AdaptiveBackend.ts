import type { AudioQualityMetrics } from "@stt/core";
import type {
  BackendTranscriptionRequest,
  BackendTranscriptionResponse,
  LocalSTTBackend,
} from "./backendTypes";
import {
  AudioQualityAnalyzer,
  DEFAULT_THRESHOLDS,
  type AudioQualityThresholds,
} from "../preprocessing/AudioQualityAnalyzer";
import {
  preprocessAudio,
  type PreprocessOptions,
  type PreprocessResult,
} from "../preprocessing/AdaptivePreprocessor";
import { resolveFfmpegPath } from "../preprocessing/ffmpegPath";

export type AdaptiveMode = "adaptive" | "always" | "never";

export interface AdaptiveBackendOptions {
  /**
   * How to gate preprocessing:
   *   - "adaptive": run a quality probe; preprocess only when poor
   *   - "always":   preprocess every request (unless ffmpeg is missing)
   *   - "never":    pass-through; no probe, no preprocessing
   */
  mode?: AdaptiveMode;
  /** Explicit ffmpeg path, e.g. Tauri-resolved resource. Falls back to PATH probe. */
  ffmpegPath?: string;
  /** Custom thresholds for the analyzer. */
  thresholds?: Partial<AudioQualityThresholds>;
  /** Below this confidence, and only if we skipped preprocessing, retry once. */
  confidenceRetryThreshold?: number;
  /** Preprocessing filter options. */
  preprocessOptions?: Partial<PreprocessOptions>;

  // ── Test-only injection points (keep prefixed with _ so callers notice) ──
  /** Override ffmpeg resolution — return undefined to force pass-through. */
  _resolveFfmpegPath?: () => Promise<string | undefined>;
  /** Override the quality analyzer — for deterministic tests. */
  _analyzeAudio?: (
    audioPath: string,
    ffmpegPath: string,
  ) => Promise<AudioQualityMetrics>;
  /** Override the preprocessor — for deterministic tests. */
  _preprocessAudio?: (
    audioPath: string,
    ffmpegPath: string,
  ) => Promise<PreprocessResult>;
}

const DEFAULT_CONFIDENCE_RETRY_THRESHOLD = 0.55;

/**
 * Wraps any LocalSTTBackend with adaptive audio preprocessing.
 *
 * Decision flow:
 *   1. Resolve ffmpeg path (explicit → PATH → undefined).
 *   2. If no ffmpeg or mode="never": transcribe raw, attach
 *      `preprocessing: { applied: false, reason: "mode_disabled" }`.
 *   3. If mode="always": preprocess → transcribe. No retry path.
 *   4. If mode="adaptive":
 *      a. Analyze audio quality (single ffmpeg probe).
 *      b. If poor: preprocess → transcribe → attach metrics + "poor_quality".
 *      c. Else: transcribe raw → if confidence < retry threshold, preprocess
 *         and retry once → take whichever result has higher confidence.
 *
 * Never throws on preprocessing failure — always falls back to the raw
 * transcription so the engine is resilient on flaky ffmpeg installs.
 */
export class AdaptiveBackend implements LocalSTTBackend {
  readonly name: string;
  private readonly mode: AdaptiveMode;
  private readonly confidenceRetryThreshold: number;
  private readonly thresholds: AudioQualityThresholds;
  private ffmpegResolved: { path: string | undefined } | undefined;

  constructor(
    private readonly inner: LocalSTTBackend,
    private readonly opts: AdaptiveBackendOptions = {},
  ) {
    this.mode = opts.mode ?? "adaptive";
    this.confidenceRetryThreshold =
      opts.confidenceRetryThreshold ?? DEFAULT_CONFIDENCE_RETRY_THRESHOLD;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
    this.name = `adaptive(${inner.name})`;
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  /**
   * Returns the wrapped backend. Callers can use this to reach backend-specific
   * APIs (e.g. WhisperCppBackend.getBinaryPath) without caring whether the
   * adaptive wrapper is active.
   */
  getInner(): LocalSTTBackend {
    return this.inner;
  }

  async transcribe(
    req: BackendTranscriptionRequest,
  ): Promise<BackendTranscriptionResponse> {
    // Chunked/slice requests should NOT be preprocessed — the slice boundaries
    // assume the original audio. Pass straight through.
    if (req.startMs !== undefined || req.endMs !== undefined) {
      return this.inner.transcribe(req);
    }

    const ffmpeg = await this.resolveFfmpeg();

    if (this.mode === "never" || !ffmpeg) {
      const response = await this.inner.transcribe(req);
      return {
        ...response,
        preprocessing: response.preprocessing ?? {
          applied: false,
          reason: "mode_disabled",
        },
      };
    }

    if (this.mode === "always") {
      return await this.transcribeWithPreprocess(req, ffmpeg, undefined, "poor_quality");
    }

    // mode === "adaptive"
    let metrics: AudioQualityMetrics | undefined;
    try {
      metrics = await this.runAnalyze(req.audioPath, ffmpeg);
    } catch {
      // Probe failed — degrade to pass-through.
      const response = await this.inner.transcribe(req);
      return {
        ...response,
        preprocessing: response.preprocessing ?? {
          applied: false,
          reason: "mode_disabled",
        },
      };
    }

    if (metrics.needsPreprocessing) {
      return await this.transcribeWithPreprocess(req, ffmpeg, metrics, "poor_quality");
    }

    // Clean audio path — try raw first, maybe retry with preprocessing.
    const rawResponse = await this.inner.transcribe(req);
    const rawConfidence = rawResponse.confidence ?? 1;
    if (rawConfidence >= this.confidenceRetryThreshold) {
      return {
        ...rawResponse,
        audioQuality: metrics,
        preprocessing: rawResponse.preprocessing ?? {
          applied: false,
          reason: "skipped_clean_audio",
        },
      };
    }

    // Retry once with preprocessing.
    const retry = await this.safeTranscribeWithPreprocess(
      req,
      ffmpeg,
      metrics,
      "low_confidence_retry",
    );
    if (!retry) {
      return {
        ...rawResponse,
        audioQuality: metrics,
        preprocessing: rawResponse.preprocessing ?? {
          applied: false,
          reason: "skipped_clean_audio",
        },
      };
    }
    const retryConfidence = retry.confidence ?? 0;
    // Keep whichever result has the higher overall confidence.
    if (retryConfidence > rawConfidence) return retry;
    return {
      ...rawResponse,
      audioQuality: metrics,
      preprocessing: rawResponse.preprocessing ?? {
        applied: false,
        reason: "skipped_clean_audio",
      },
    };
  }

  private async resolveFfmpeg(): Promise<string | undefined> {
    if (this.opts._resolveFfmpegPath) {
      return this.opts._resolveFfmpegPath();
    }
    if (!this.ffmpegResolved) {
      const res = await resolveFfmpegPath(this.opts.ffmpegPath);
      this.ffmpegResolved = { path: res.path };
    }
    return this.ffmpegResolved.path;
  }

  private async runAnalyze(
    audioPath: string,
    ffmpegPath: string,
  ): Promise<AudioQualityMetrics> {
    if (this.opts._analyzeAudio) {
      return this.opts._analyzeAudio(audioPath, ffmpegPath);
    }
    const analyzer = new AudioQualityAnalyzer({
      ffmpegPath,
      thresholds: this.thresholds,
    });
    return analyzer.analyze(audioPath);
  }

  private async runPreprocess(
    audioPath: string,
    ffmpegPath: string,
  ): Promise<PreprocessResult> {
    if (this.opts._preprocessAudio) {
      return this.opts._preprocessAudio(audioPath, ffmpegPath);
    }
    return preprocessAudio({
      ffmpegPath,
      inputPath: audioPath,
      options: this.opts.preprocessOptions,
    });
  }

  private async transcribeWithPreprocess(
    req: BackendTranscriptionRequest,
    ffmpegPath: string,
    metrics: AudioQualityMetrics | undefined,
    reason: "poor_quality" | "low_confidence_retry",
  ): Promise<BackendTranscriptionResponse> {
    let prep: PreprocessResult | undefined;
    try {
      prep = await this.runPreprocess(req.audioPath, ffmpegPath);
      const response = await this.inner.transcribe({
        ...req,
        audioPath: prep.cleanedPath,
      });
      return {
        ...response,
        audioQuality: metrics,
        preprocessing: {
          applied: true,
          reason,
          stages: prep.stages,
        },
      };
    } catch {
      // Preprocessing failed — fall back to raw input.
      const response = await this.inner.transcribe(req);
      return {
        ...response,
        audioQuality: metrics,
        preprocessing: response.preprocessing ?? {
          applied: false,
          reason: "mode_disabled",
        },
      };
    } finally {
      if (prep) await prep.cleanup().catch(() => {});
    }
  }

  private async safeTranscribeWithPreprocess(
    req: BackendTranscriptionRequest,
    ffmpegPath: string,
    metrics: AudioQualityMetrics | undefined,
    reason: "poor_quality" | "low_confidence_retry",
  ): Promise<BackendTranscriptionResponse | undefined> {
    try {
      return await this.transcribeWithPreprocess(req, ffmpegPath, metrics, reason);
    } catch {
      return undefined;
    }
  }
}
