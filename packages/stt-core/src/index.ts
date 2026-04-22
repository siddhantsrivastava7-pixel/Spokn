// ─── Public API ───────────────────────────────────────────────────────────────
// Import this package in your platform bridge or app layer.
// Do not import internal submodules directly — the surface area here is stable.

// Core primitive types
export type {
  Platform,
  CpuTier,
  GpuVendor,
  TranscriptionMode,
  SupportedLanguage,
  LatencyTier,
  BatteryImpact,
  MemoryProfile,
  BackendId,
  DeviceProfile,
  TranscriptionSettings,
  TranscriptSegment,
  Transcript,
  STTModelCapabilities,
  STTModelMetadata,
  TranscriptionInput,
  TranscriptionResult,
  RuntimeTranscriptionRequest,
  RuntimeTranscriptionResponse,
  STTRuntimeAdapter,
  ModelRef,
  // Post-processing & pipeline control
  ConfidenceTier,
  ConfidenceLevel,
  ScoredSegment,
  ProcessingMode,
  TransformationLevel,
  DetectedIntent,
  IntentSignals,
  IntentDetection,
  AudioQualityMetrics,
  SessionContext,
  DecodingHints,
} from "./types";

// Routing types (also re-exported via types/index.ts for convenience)
export type {
  UserSpeechProfile,
  UserStylePreferences,
  ModelSelectionResult,
  ModelSelectionContext,
  ResolvedMode,
  ResolvedTranscriptionMode,
  RejectedCandidate,
  ScoredModel,
} from "./types";

// Top-level pipeline entry point
export { transcribeFile } from "./pipeline/transcribeFile";
export { finalizeTranscript } from "./pipeline/finalizeTranscript";
export type { PipelineLogger, PostProcessingOptions, TranscribeFileParams } from "./pipeline/pipelineTypes";

// Processing-mode presets & latency budget
export { PROCESSING_MODES, presetFor } from "./pipeline/processingModes";
export type { ProcessingModePreset } from "./pipeline/processingModes";
export { LatencyBudget } from "./pipeline/latencyBudget";

// Selective reprocessing (usable standalone)
export { selectiveReprocess, normalizedLevenshtein } from "./pipeline/selectiveReprocess";
export type {
  SelectiveReprocessOptions,
  SelectiveReprocessResult,
} from "./pipeline/selectiveReprocess";

// Confidence scoring
export {
  CONFIDENCE_THRESHOLDS,
  NORMALIZED_CONFIDENCE_THRESHOLDS,
  NORMALIZED_CONFIDENCE_NONE_BASELINE,
  tierFor,
  confidenceLevelFor,
  heuristicTier,
  scoreSegment,
  scoreSegments,
  smoothConfidence,
  aggregateTier,
  normalizeSegmentConfidence,
} from "./analysis/segmentConfidence";
export type { ScoreSegmentsResult } from "./analysis/segmentConfidence";

// Correction modes
export { resolveCorrectionMode, budgetFor } from "./postprocessing/correctionMode";
export type { CorrectionMode, CorrectionBudget } from "./postprocessing/correctionMode";

// Post-processing
export { processTranscript } from "./postprocessing/processTranscript";
export type {
  ProcessTranscriptInput,
  ProcessTranscriptResult,
  ProcessTranscriptConfig,
  CorrectionKind,
  CorrectionLogEntry,
  AdaptiveRulesView,
} from "./postprocessing/processTypes";
export { correctHinglish, looksHinglish } from "./postprocessing/hinglishCorrector";
export { cleanupGrammar } from "./postprocessing/grammarCleanup";
export { splitLongSentences } from "./postprocessing/sentenceReconstruction";
export { expandContractions } from "./postprocessing/contractionExpander";
export {
  detectIntent as detectFormatIntent,
  detectIntentHybrid,
  COMMAND_VERBS,
} from "./postprocessing/intentDetection";
export type { FormatIntent, IntentResult } from "./postprocessing/intentDetection";
export { formatByIntent } from "./postprocessing/formatTranscript";
export { applyReplacements } from "./postprocessing/applyReplacements";
export { tokenize, protectionMask, isProtected } from "./postprocessing/entityProtection";
export type { TextToken } from "./postprocessing/entityProtection";
export {
  HINGLISH_DICTIONARY,
  HINGLISH_BIGRAMS,
  HINGLISH_CONTEXT_TOKENS,
} from "./postprocessing/hinglishDictionary";
export {
  ALWAYS_FILLERS,
  CONTEXTUAL_FILLERS,
  LIKE_BLOCKING_PRECEDING_VERBS,
  YOU_KNOW_MEANINGFUL_FOLLOWERS,
} from "./postprocessing/fillerWords";

// Intent
export { classifyIntent, findTriggerMatches } from "./intent/intentClassifier";
export { transformToFormat } from "./intent/formatTransformer";
export { splitIntoItems, capitalizeFirst } from "./intent/textSegmenters";
export { computeStructuralSignals } from "./intent/structuralHeuristics";
export type { StructuralSignals } from "./intent/structuralHeuristics";
export {
  DEFAULT_STICKY_WINDOW_MS,
  RECENT_INTENT_WINDOW,
  isWithinStickyWindow,
  recentIntentBias,
  isListLike,
  updateSessionContext,
} from "./intent/sessionContext";
export type { IntentClassifierInput, TriggerMatch } from "./intent/intentTypes";

// Transformation analysis
export { computeTransformationLevel } from "./analysis/transformationDiff";
export type { TransformationDiff } from "./analysis/transformationDiff";

// Feedback loop
export { deriveAdaptiveRules } from "./feedback/adaptiveRules";
export type {
  DeriveAdaptiveRulesOptions,
} from "./feedback/adaptiveRules";
export { migrateAdaptiveRules } from "./feedback/migrateAdaptiveRules";
export { migrateUserSpeechProfile } from "./types/migrateUserSpeechProfile";
export {
  deriveReplacementRules,
} from "./feedback/userCorrections";
export type {
  UserCorrection,
  DeriveReplacementRulesOptions,
} from "./feedback/userCorrections";
export type {
  AdaptiveRules,
  FeedbackEntry,
  FeedbackStore,
} from "./feedback/feedbackTypes";

// Settings
export { DEFAULT_SETTINGS } from "./settings/defaultSettings";
export { validateSettings, mergeWithDefaults } from "./settings/validateSettings";
export {
  VALID_MODES,
  VALID_LANGUAGES,
  CHUNK_DURATION_MIN_MS,
  CHUNK_DURATION_MAX_MS,
} from "./settings/settingsSchema";

// Model registry
export {
  getAllModels,
  getModelById,
  getModelsByMode,
  getModelsCompatibleWithDevice,
  getModelsCompatibleWithLanguage,
  queryModels,
  registerModel,
} from "./models/modelRegistry";

// Model capability helpers
export {
  isCompatibleWithDevice,
  incompatibilityReason,
  supportsLanguage,
  supportsMode,
} from "./models/modelCapabilities";

// Routing — primary entry points
export { chooseModel } from "./routing/chooseModel";
export { resolveMode } from "./routing/chooseMode";
export { getPerModeRecommendations } from "./routing/getPerModeRecommendations";
export type { PerModeRecommendations } from "./routing/getPerModeRecommendations";

// Routing — sub-modules (useful for custom routing extensions)
export { filterCompatibleModels } from "./routing/filterCompatibleModels";
export { scoreModel, rankCandidates } from "./routing/scoreModel";
export { computeMultilingualNeed, scoreLanguageFit } from "./routing/languageProfile";
export {
  getMultilingualRisk,
  regionMultilingualAdjustment,
  scoreRegionFit,
} from "./routing/regionHeuristics";
export { scoreBatteryFit, scoreStorageFit } from "./routing/preferenceHeuristics";

// Audio helpers
export { planChunks, needsChunking } from "./audio/chunkAudio";
export { mergeChunkResponses } from "./audio/mergeChunks";
export { getNormalizationTarget, isAlreadyNormalized } from "./audio/normalizeAudio";
export { DEFAULT_NORMALIZATION } from "./audio/audioTypes";
export type { AudioChunk, ChunkPlan, NormalizationOptions } from "./audio/audioTypes";

// Transcript utilities
export {
  buildFullText,
  averageConfidence,
  sliceSegments,
  wordCount,
} from "./transcript/transcriptUtils";
export { mergeTranscripts } from "./transcript/transcriptMerge";
export {
  serializeTranscript,
  deserializeTranscript,
  exportAsPlainText,
  exportAsSRT,
} from "./transcript/transcriptSerializer";

// Storage contracts (interfaces only — platform bridges implement these)
export type { ModelStorage } from "./storage/modelStorage";
export type { TranscriptStorage } from "./storage/transcriptStorage";
export type { SettingsStorage } from "./storage/settingsStorage";

// Utils
export { generateId } from "./utils/idGenerator";
export { formatDuration, nowISO } from "./utils/timeUtils";
