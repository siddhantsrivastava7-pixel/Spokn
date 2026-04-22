import type {
  TranscriptionSettings,
  TranscriptionInput,
  DeviceProfile,
  STTRuntimeAdapter,
  UserSpeechProfile,
  ProcessingMode,
  SessionContext,
  Transcript,
  UserStylePreferences,
} from "../types";
import type { AdaptiveRules } from "../feedback/feedbackTypes";

/**
 * Pluggable logger surface for debugMode. Defaults to console.
 * Each call is a single structured log line.
 */
export interface PipelineLogger {
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
}

export interface PostProcessingOptions {
  /** default true when audio has per-segment confidence */
  confidenceScoring?: boolean;
  /** default: presetFor(processingMode).selectiveReprocess */
  selectiveReprocess?: boolean;
  /** Hard cap on LOW segments to rerun. Default 3. */
  maxSegmentsToReprocess?: number;
  /** Explicit escalation model id (must be installed). */
  reprocessModelId?: string;
  /** Max in-flight reprocess calls. Default 2. */
  reprocessConcurrency?: number;
  /** "auto" = on when settings.language ∈ {hi,hinglish} or userSpeechProfile.mixesLanguages */
  hinglishCorrection?: boolean | "auto";
  grammarCleanup?: boolean;
  sentenceSplitting?: boolean;
  removeFillers?: boolean;
  /** Effective only when stylePreferences.tone === "formal". */
  contractionExpansion?: boolean;
  intentDetection?: boolean;
  formatTransformation?: boolean;
  sessionContext?: SessionContext;
  /** Defaults to userSpeechProfile.stylePreferences when absent. */
  stylePreferences?: UserStylePreferences;
  /** Override the latency budget for this call. */
  latencyBudgetMs?: number;
}

export interface TranscribeFileParams {
  input: TranscriptionInput;
  settings: TranscriptionSettings;
  deviceProfile: DeviceProfile;
  runtimeAdapter: STTRuntimeAdapter;
  /** Optional onboarding profile for smarter model selection. */
  userSpeechProfile?: UserSpeechProfile;
  /** Processing mode preset. Default "balanced". */
  processingMode?: ProcessingMode;
  /** Partial-output callback — receives v1, v2 (and the final is also the Promise result). */
  onPartial?: (partial: Transcript) => void;
  /** Verbose per-stage logging when true. */
  debugMode?: boolean;
  /** Pluggable logger. Defaults to console. */
  logger?: PipelineLogger;
  /** If audio duration > this, disable selective reprocess + force light post-processing. Default 120_000. */
  audioDurationGuardMs?: number;
  /** Fine-grained overrides for each post-processing stage. */
  postProcessing?: PostProcessingOptions;
  /**
   * Rule deltas derived from the local feedback loop. Passed into the
   * post-processing pass as bias + exceptions. Leave undefined to disable.
   */
  adaptiveRules?: AdaptiveRules;
}

export interface PipelineContext {
  modelId: string;
  resolvedLanguage: string;
  chunked: boolean;
  chunkCount: number;
  startedAt: number;
}

export interface SegmentTranscriptionParams {
  audioPath: string;
  modelId: string;
  language: import("../types").SupportedLanguage;
  timestamps: boolean;
  startMs?: number;
  endMs?: number;
  sampleRate?: number;
  prompt?: string;
  runtimeAdapter: STTRuntimeAdapter;
}
