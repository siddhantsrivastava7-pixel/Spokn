// Frontend-local types that mirror the shapes returned by the Node backend.
// The frontend never imports from @stt/core directly — all data flows via HTTP.

export type ConfidenceTier = "HIGH" | "MEDIUM" | "LOW";
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

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
  tier?: ConfidenceTier;
  reprocessed?: boolean;
  originalText?: string;
}

export interface IntentSignals {
  triggers: string[];
  structural: string[];
  lengthPattern?: "short_segments" | "uniform_short" | "mixed" | "long_form";
}

export interface IntentDetection {
  intent: DetectedIntent;
  confidence: number;
  signals: IntentSignals;
  carriedFromSession?: boolean;
}

export interface Transcript {
  id: string;
  /** Untouched model output, segment-joined. */
  rawText: string;
  /**
   * Deterministic pipeline cleanup (punctuation, casing, filler removal,
   * adaptive replacements). Plain text — no scaffolding, no snippet expansion,
   * no user edits. This is what the UI seeds its editable `typingText` from.
   */
  correctedText: string;
  /** @deprecated Use `correctedText` (aliased here for backward compat). */
  fullText: string;
  language: string;
  modelId: string;
  mode: string;
  durationMs: number;
  segments: TranscriptSegment[];
  createdAt: string;
  metadata: Record<string, unknown>;

  // Post-processing fields — all optional, backward-compatible.
  formattedOutput?: string;
  detectedIntent?: IntentDetection;
  qualityTier?: ConfidenceTier;
  transformationLevel?: TransformationLevel;
  processingMode?: ProcessingMode;
  latencyMs?: number;
  latencyBreakdown?: Record<string, number>;
  downgrades?: string[];
  isFinal?: boolean;
  version?: number;

  // Adaptive preprocessing metadata.
  audioQuality?: {
    rmsDb: number;
    peakDb: number;
    clippingRatio: number;
    silenceRatio: number;
    estimatedNoiseFloorDb: number;
    needsPreprocessing: boolean;
    reasons: string[];
  };
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

  // Fallback metadata.
  fallbackUsed?: boolean;
  fallbackStage?: string;
  fallbackError?: string;
  modelFallbackChain?: string[];
}

export interface SelectedModel {
  id: string;
  displayName: string;
  sizeMB: number;
}

export interface ResolvedMode {
  mode: string;
  reason: string;
}

export interface RejectedCandidate {
  modelId: string;
  reason: string;
}

export interface ModelSelectionResult {
  selectedModel: SelectedModel;
  resolvedMode: ResolvedMode;
  selectionReasons: string[];
  fallbackCandidates: SelectedModel[];
  rejectedCandidates: RejectedCandidate[];
  appliedBiases: string[];
}

export interface TranscribeResult {
  transcript: Transcript;
  processingTimeMs: number;
  modelId: string;
  chunksProcessed: number;
  routing: ModelSelectionResult;
}

export interface DeviceInfo {
  platform: string;
  cpuTier: string;
  ramMB: number;
  storageAvailableMB: number;
  batterySaverActive: boolean;
  osVersion?: string;
}

export interface HealthStatus {
  ok: boolean;
  device: DeviceInfo;
  installedModels: string[];
  backendAvailable: boolean;
  backendPath: string;
  binaryVariant: "cpu" | "vulkan" | "cuda";
  gpuAcceleration: boolean;
}

export interface TranscribeRequest {
  audioPath?: string;
  audioFile?: File;
  durationMs?: number;
  settings: AppSettings;
  userSpeechProfile?: UserSpeechProfileInput;
  /** Optional; defaults to "balanced" on the backend. */
  processingMode?: ProcessingMode;
  /** Fine-grained post-processing overrides. Omit for sensible defaults. */
  postProcessing?: PostProcessingRequest;
}

export interface PostProcessingRequest {
  selectiveReprocess?: boolean;
  maxSegmentsToReprocess?: number;
  hinglishCorrection?: boolean | "auto";
  grammarCleanup?: boolean;
  sentenceSplitting?: boolean;
  removeFillers?: boolean;
  contractionExpansion?: boolean;
  intentDetection?: boolean;
  formatTransformation?: boolean;
  stylePreferences?: {
    prefersLists?: boolean;
    prefersShortSentences?: boolean;
    tone?: "casual" | "formal" | "neutral";
  };
}

export interface AppSettings {
  mode: "auto" | "fast" | "balanced" | "best_accuracy";
  language: string;
  timestamps: boolean;
  offlineOnly: boolean;
  /** Seed text to bias the whisper decoder toward specific vocabulary. */
  prompt?: string;
}

export interface UserSpeechProfileInput {
  countryCode?: string;
  primaryLanguages?: string[];
  mixesLanguages?: boolean;
}

export interface LogEntry {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  timestamp: string;
  detail?: string;
}

export interface ModeRecommendation {
  selectedModel: SelectedModel;
  resolvedMode: ResolvedMode;
  selectionReasons: string[];
  fallbackCandidates: SelectedModel[];
  rejectedCandidates: RejectedCandidate[];
  appliedBiases: string[];
}

export interface PerModeRecommendations {
  fast: ModeRecommendation;
  balanced: ModeRecommendation;
  best_accuracy: ModeRecommendation;
  auto: ModeRecommendation;
}

export interface ApiError {
  error: string;
  errorType?: string;
  stack?: string;
}
