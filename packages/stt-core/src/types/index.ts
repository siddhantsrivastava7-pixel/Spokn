// ─── Primitives ──────────────────────────────────────────────────────────────

export type Platform = "ios" | "android" | "windows" | "macos" | "linux" | "web" | "unknown";
export type CpuTier = "low" | "mid" | "high";
export type TranscriptionMode = "auto" | "fast" | "balanced" | "best_accuracy";
export type SupportedLanguage = "auto" | "en" | "hi" | "hinglish" | "multilingual";
export type LatencyTier = "realtime" | "fast" | "normal" | "slow";
export type BatteryImpact = "minimal" | "low" | "medium" | "high";
export type MemoryProfile = "tiny" | "small" | "medium" | "large";
/** Which inference runtime loads and runs this model's weights. */
export type BackendId = "whisper-cpp" | "transformers-js";

// ─── Device ──────────────────────────────────────────────────────────────────

/**
 * Generic device traits used for capability-based model selection.
 * Never contains OS-specific APIs — platform bridges fill this in.
 */
export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "unknown";

export interface DeviceProfile {
  platform: Platform;
  cpuTier: CpuTier;
  ramMB: number;
  storageAvailableMB: number;
  batterySaverActive: boolean;
  lowPowerMode: boolean;
  /** e.g. Apple Neural Engine, Hexagon DSP — accelerates on-device inference */
  hasNeuralEngine?: boolean;
  /** True when a dedicated GPU (non-Intel-integrated) is present */
  hasGpu?: boolean;
  gpuVendor?: GpuVendor;
  /** Dedicated GPU VRAM in MB — 0 for integrated graphics */
  gpuVramMB?: number;
  /** True when NVIDIA CUDA runtime DLLs are detected (enables CUDA whisper build) */
  cudaRuntimeAvailable?: boolean;
  osVersion?: string;
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface TranscriptionSettings {
  mode: TranscriptionMode;
  language: SupportedLanguage;
  /** Skip routing and pin to this model id if set */
  exactModelId?: string;
  timestamps: boolean;
  offlineOnly: boolean;
  /** Hard cap on audio duration the pipeline will accept */
  maxDurationMs?: number;
  /** Target chunk size when splitting long audio */
  chunkDurationMs?: number;
  /** Initial prompt seeded into the decoder to bias vocabulary / style. */
  prompt?: string;
}

// ─── Transcript ───────────────────────────────────────────────────────────────

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  /** 0–1 model confidence for this segment, if available */
  confidence?: number;
  /**
   * Whisper decoder signals. Optional — populated by backends that expose
   * them (e.g. whisper.cpp). Used by `normalizeSegmentConfidence` to build
   * a richer score than `confidence` alone.
   */
  avgLogprob?: number;
  noSpeechProb?: number;
  compressionRatio?: number;
}

/** Locked tier bands: HIGH >= 0.6, MEDIUM 0.3..0.6, LOW < 0.3. */
export type ConfidenceTier = "HIGH" | "MEDIUM" | "LOW";

/**
 * Second normalized tier derived from `normalizedConfidence`. Bands are
 * separate from `ConfidenceTier`'s legacy thresholds and are the banding
 * used for newer downstream decisions (selective reprocess gating, UI).
 *
 *   LOW    < 0.4
 *   MEDIUM 0.4 .. 0.75
 *   HIGH   > 0.75
 */
export type ConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";

/** Segment enriched with a tier + reprocessing state. */
export interface ScoredSegment extends TranscriptSegment {
  tier: ConfidenceTier;
  /** True when this segment was rerun with a different model or higher-accuracy flags. */
  reprocessed?: boolean;
  /** Original (pre-reprocess) text — kept for diff + audit when reprocessed. */
  originalText?: string;
  /**
   * Normalized confidence in [0, 1]. Computed by `normalizeSegmentConfidence`
   * using backend signals when available; falls back to `confidence` or to
   * a model-baseline when the model's `confidenceScale` is "none".
   */
  normalizedConfidence?: number;
  /** Banded view of `normalizedConfidence`. */
  confidenceLevel?: ConfidenceLevel;
  /**
   * Temporally smoothed view of `normalizedConfidence`, damping single-segment
   * outliers using neighbors. Same [0, 1] range. Populated by
   * `smoothConfidence()`; downstream consumers (selective reprocess, formatter)
   * prefer this over `normalizedConfidence` when present.
   */
  smoothedConfidence?: number;
}

export type ProcessingMode = "instant" | "balanced" | "accuracy";

export type TransformationLevel = "low" | "medium" | "high";

export type DetectedIntent =
  | "paragraph"
  | "bullet_list"
  | "numbered_list"
  | "todo_list"
  | "email"
  | "message"
  | "meeting_notes";

export interface IntentSignals {
  /** Exact phrase triggers matched (e.g. "grocery list", "to-do"). */
  triggers: string[];
  /** Structural pattern names (e.g. "noun_phrase_run", "comma_chain", "and_chain", "imperative"). */
  structural: string[];
  /** Coarse description of segment length distribution. */
  lengthPattern?: "short_segments" | "uniform_short" | "mixed" | "long_form";
}

export interface IntentDetection {
  intent: DetectedIntent;
  /** 0..1 aggregate classifier confidence. */
  confidence: number;
  signals: IntentSignals;
  /** True when intent was carried from prior session context rather than directly detected. */
  carriedFromSession?: boolean;
}

export interface AudioQualityMetrics {
  rmsDb: number;
  peakDb: number;
  clippingRatio: number;
  silenceRatio: number;
  estimatedNoiseFloorDb: number;
  needsPreprocessing: boolean;
  reasons: string[];
}

export interface SessionContext {
  lastIntent?: DetectedIntent;
  /** ISO 8601 timestamp of the last detected intent. */
  lastIntentAt?: string;
  /** Window in ms during which lastIntent can be carried forward. Default 60000. */
  stickyWindowMs?: number;
  /** Rolling window of recent intents, most-recent first. */
  recentIntents?: DetectedIntent[];
}

export interface Transcript {
  id: string;
  /**
   * Untouched model output, segment-joined. Never edited by post-processing.
   * Use this when you need the "what the model actually heard" view.
   */
  rawText: string;
  /**
   * Deterministic cleanup applied to `rawText` by the post-processing pipeline:
   * punctuation, casing, filler removal, adaptive replacements. Plain text,
   * no scaffolding, no snippet expansion, no user edits.
   *
   * This is the canonical backend output. UI layers seed their editable
   * `typingText` from here.
   */
  correctedText: string;
  /**
   * @deprecated Use `correctedText` for the cleaned canonical text, or
   * `rawText` for the untouched model output. `fullText` is kept as an alias
   * for `correctedText` during migration and will be removed in a future
   * release. Do NOT write to it — the pipeline mirrors `correctedText` here.
   */
  fullText: string;
  /** BCP-47 or "unknown" */
  language: string;
  modelId: string;
  mode: TranscriptionMode;
  durationMs: number;
  segments: TranscriptSegment[] | ScoredSegment[];
  /** ISO 8601 */
  createdAt: string;
  metadata: Record<string, unknown>;

  // ── Post-processing output (all optional, backward-compatible) ────────────
  /** Formatted output reshaped per detected intent. Absent when post-processing didn't run. */
  formattedOutput?: string;
  /** Intent detection result. */
  detectedIntent?: IntentDetection;
  /** Aggregate confidence tier across all segments. */
  qualityTier?: ConfidenceTier;
  /** Audio quality metrics from the adaptive preprocessor, if it ran. */
  audioQuality?: AudioQualityMetrics;
  /** Preprocessing decision + reason. */
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

  // ── Performance + safety ───────────────────────────────────────────────────
  /** Total wall-clock time, ms. Populated even on fallback. */
  latencyMs?: number;
  /** Per-stage timings. Keys match LatencyBudget marks. */
  latencyBreakdown?: Record<string, number>;
  /** Which processing mode was applied. */
  processingMode?: ProcessingMode;
  /** Severity of transformation applied to rawText. */
  transformationLevel?: TransformationLevel;
  /** Reasons any optional stage was skipped (budget, long audio, etc.). */
  downgrades?: string[];

  // ── Streaming / partial ────────────────────────────────────────────────────
  /** True for the final emission; false for partials v1/v2. */
  isFinal?: boolean;
  /** Version number — 1 = raw pass, 2 = post-reprocess, 3 = post-processing done. */
  version?: number;

  // ── Reliability / fallback ─────────────────────────────────────────────────
  /** True when any stage failed and we returned the best-available transcript. */
  fallbackUsed?: boolean;
  /** Which stage failed (if any): "preprocess" | "transcribe" | "reprocess" | "postprocess". */
  fallbackStage?: string;
  /** Redacted error message. */
  fallbackError?: string;
  /** Models tried in order when the primary failed. */
  modelFallbackChain?: string[];
}

// ─── Models ───────────────────────────────────────────────────────────────────

/**
 * Unambiguous reference to a model ready for a specific backend.
 *
 * Shared vocabulary for platform-bridge adapter implementations — stt-core
 * itself uses registry `modelId: string` and never constructs one of these.
 * Adapters build a `ModelRef` from a `modelId` right before invoking their
 * backend so the backend can branch on `kind` without string-sniffing.
 */
export type ModelRef =
  | { kind: "whisper-cpp"; path: string }
  | { kind: "transformers-js"; modelId: string };

export interface STTModelCapabilities {
  supportsStreaming: boolean;
  supportsOffline: boolean;
  supportsTimestamps: boolean;
  supportedLanguages: SupportedLanguage[];
  /** Minimum device RAM required to load this model */
  minRamMB: number;
  /** Minimum free storage to store model weights */
  minStorageMB: number;
  minCpuTier: CpuTier;
  recommendedModes: TranscriptionMode[];
  latencyTier: LatencyTier;
  batteryImpact: BatteryImpact;
  memoryProfile: MemoryProfile;
  /**
   * Semantics of the `confidence` field emitted on segments.
   *  - "whisper": 0..1 log-prob-derived value; threshold bands apply.
   *  - "none":    model does not expose a meaningful confidence. All
   *               segments are treated as MEDIUM; tier thresholds + LOW
   *               reprocessing are skipped.
   * Defaults to "whisper" when omitted (backward-compatible).
   */
  confidenceScale?: "whisper" | "none";
}

export interface STTModelMetadata {
  id: string;
  displayName: string;
  /** Approximate on-disk weight size */
  sizeMB: number;
  capabilities: STTModelCapabilities;
  /** Which runtime loads this model. Defaults to "whisper-cpp" if omitted. */
  backendId?: BackendId;
  /**
   * HuggingFace repo ID used by the transformers-js backend.
   * e.g. "FunAudioLLM/SenseVoiceSmall"
   * Not needed for whisper-cpp models (those use a local file path).
   */
  huggingFaceId?: string;
  /** Platforms this model's backend can run on. Omitting means all platforms. */
  supportedPlatforms?: Platform[];
  version?: string;
  releaseDate?: string;
  description?: string;
}

// ─── Pipeline I/O ─────────────────────────────────────────────────────────────

export interface TranscriptionInput {
  /** Platform-agnostic reference; bridges resolve this to a concrete path/URI */
  audioPath: string;
  mimeType?: string;
  durationMs?: number;
  sampleRate?: number;
  channelCount?: number;
}

export interface TranscriptionResult {
  transcript: Transcript;
  processingTimeMs: number;
  modelId: string;
  chunksProcessed: number;
}

// ModelSelectionResult lives in routingTypes.ts — re-exported from index.ts
// for backward-compatible imports. See types/routingTypes.ts for the full shape.
export type {
  ModelSelectionResult,
  ModelSelectionContext,
  ResolvedMode,
  ResolvedTranscriptionMode,
  RejectedCandidate,
  ScoredModel,
} from "./routingTypes";
export type { UserSpeechProfile, UserStylePreferences } from "./userSpeechProfile";

// ─── Runtime Adapter ──────────────────────────────────────────────────────────

/**
 * Slice of audio the runtime adapter should transcribe.
 * startMs/endMs are omitted for full-file jobs.
 */
export interface DecodingHints {
  /** Preset: beam-size 5, best-of 5, temperature 0, strict thresholds. */
  highAccuracy?: boolean;
  beamSize?: number;
  /** 0 = greedy decoding. */
  temperature?: number;
  bestOf?: number;
}

export interface RuntimeTranscriptionRequest {
  modelId: string;
  audioPath: string;
  language: SupportedLanguage;
  startMs?: number;
  endMs?: number;
  timestamps: boolean;
  sampleRate?: number;
  prompt?: string;
  /** Optional decoder accuracy hints. Platform adapter translates to CLI flags. */
  decodingHints?: DecodingHints;
}

export interface RuntimeTranscriptionResponse {
  segments: TranscriptSegment[];
  /** BCP-47 detected or forced language */
  language: string;
  durationMs: number;
  /** Overall confidence across all segments, if the model reports it */
  confidence?: number;
  /** Metrics from the adaptive preprocessor, if it ran. */
  audioQuality?: AudioQualityMetrics;
  /** Preprocessing decision + reason, if the adapter exposes one. */
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
 * The only interface stt-core has with actual model inference.
 * Each platform bridge implements this; stt-core never calls native APIs directly.
 */
export interface STTRuntimeAdapter {
  /** Returns model ids the runtime currently has installed and ready. */
  getAvailableModelIds(): Promise<string[]>;
  isModelInstalled(modelId: string): Promise<boolean>;
  transcribe(request: RuntimeTranscriptionRequest): Promise<RuntimeTranscriptionResponse>;
}
