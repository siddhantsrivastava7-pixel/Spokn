// Adapters
export { WindowsSTTRuntimeAdapter } from "./adapter/WindowsSTTRuntimeAdapter";
export type { WindowsSTTRuntimeAdapterOptions } from "./adapter/runtimeTypes";
export { MultiBackendWindowsAdapter } from "./adapter/MultiBackendWindowsAdapter";
export type { MultiBackendWindowsAdapterOptions } from "./adapter/MultiBackendWindowsAdapter";

// Backend abstraction
export { WhisperCppBackend } from "./backend/WhisperCppBackend";
export type { WhisperCppBackendOptions } from "./backend/WhisperCppBackend";
export { TransformersJsBackend } from "./backend/TransformersJsBackend";
export type { TransformersJsBackendOptions } from "./backend/TransformersJsBackend";
export { AdaptiveBackend } from "./backend/AdaptiveBackend";
export type { AdaptiveBackendOptions, AdaptiveMode } from "./backend/AdaptiveBackend";
export type {
  LocalSTTBackend,
  BackendTranscriptionRequest,
  BackendTranscriptionResponse,
} from "./backend/backendTypes";

// Adaptive preprocessing
export { AudioQualityAnalyzer, DEFAULT_THRESHOLDS, parseFfmpegProbeOutput } from "./preprocessing/AudioQualityAnalyzer";
export type {
  AudioQualityAnalyzerOptions,
  AudioQualityThresholds,
} from "./preprocessing/AudioQualityAnalyzer";
export { preprocessAudio, DEFAULT_PREPROCESS_OPTIONS } from "./preprocessing/AdaptivePreprocessor";
export type {
  PreprocessInput,
  PreprocessOptions,
  PreprocessResult,
} from "./preprocessing/AdaptivePreprocessor";
export { resolveFfmpegPath } from "./preprocessing/ffmpegPath";
export type { FfmpegResolution } from "./preprocessing/ffmpegPath";

// Model store
export { WindowsModelStore } from "./models/WindowsModelStore";
export type { ModelManifest, ModelManifestEntry } from "./models/modelManifest";

// Device profiling
export { getWindowsDeviceProfile } from "./device/getWindowsDeviceProfile";

// Binary management
export { ensureBinary, getInstalledVariant, chooseBinaryVariant, hasCudaRuntime } from "./binary/binaryManager";
export type { BinaryVariant, EnsureBinaryResult } from "./binary/binaryManager";

// Errors
export {
  ModelNotInstalledError,
  ModelFileNotFoundError,
  BackendBinaryMissingError,
  BackendExecutionError,
  OutputParseError,
  UnsupportedRequestError,
} from "./errors";

// Internals exported for testing / advanced use
export { buildWhisperArgs } from "./backend/buildWhisperArgs";
export { parseWhisperJsonString } from "./backend/parseWhisperOutput";
export { resolveModelPath } from "./models/resolveModelPath";
export { getAppDataRoot, getModelsDir, getBinDir, getFeedbackDir, getFeedbackFilePath } from "./utils/pathUtils";

// Feedback store
export { WindowsFeedbackStore } from "./feedback/WindowsFeedbackStore";
export type { WindowsFeedbackStoreOptions } from "./feedback/WindowsFeedbackStore";
