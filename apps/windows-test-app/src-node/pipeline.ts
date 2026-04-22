import {
  transcribeFile,
  chooseModel,
  mergeWithDefaults,
  getPerModeRecommendations,
  deriveAdaptiveRules,
  getAllModels,
  incompatibilityReason,
} from "@stt/core";
import type {
  TranscriptionSettings,
  UserSpeechProfile,
  DeviceProfile,
  ModelSelectionResult,
  TranscriptionResult,
  PerModeRecommendations,
  ProcessingMode,
  PostProcessingOptions,
  AdaptiveRules,
  FeedbackEntry,
} from "@stt/core";
import {
  MultiBackendWindowsAdapter,
  WhisperCppBackend,
  AdaptiveBackend,
  WindowsFeedbackStore,
  getDeviceProfile,
  ensureBinary,
  getInstalledVariant,
} from "@stt/platform-windows";
import type { BinaryVariant } from "@stt/platform-windows";

// Singletons — created once, reused across requests.
let _adapter: MultiBackendWindowsAdapter | null = null;
let _deviceProfile: DeviceProfile | null = null;
let _binaryVariant: BinaryVariant | null = null;
let _feedbackStore: WindowsFeedbackStore | null = null;
let _adaptiveRules: AdaptiveRules | null = null;
let _adaptiveRulesLoadedAt = 0;

export function feedbackStore(): WindowsFeedbackStore {
  if (!_feedbackStore) _feedbackStore = new WindowsFeedbackStore();
  return _feedbackStore;
}

/**
 * Returns the current adaptive rules, refreshing from the feedback store on
 * first call and after every successful append. A single in-memory snapshot
 * is shared across requests (derivation is O(entries) — cheap).
 */
export async function currentAdaptiveRules(): Promise<AdaptiveRules | undefined> {
  if (_adaptiveRules) return _adaptiveRules;
  try {
    const entries = await feedbackStore().list();
    _adaptiveRules = deriveAdaptiveRules(entries);
    _adaptiveRulesLoadedAt = Date.now();
    return _adaptiveRules;
  } catch {
    return undefined;
  }
}

/**
 * Invalidate the adaptive rules cache. Called after appending or clearing
 * the feedback store so the next request picks up the change.
 */
export function invalidateAdaptiveRules(): void {
  _adaptiveRules = null;
  _adaptiveRulesLoadedAt = 0;
}

export function getAdaptiveRulesLoadedAt(): number {
  return _adaptiveRulesLoadedAt;
}

/**
 * Wrap a whisper backend with adaptive preprocessing. If ffmpeg is missing
 * at runtime the wrapper degrades to pass-through, so this is always safe.
 */
function withAdaptivePreprocessing(inner: WhisperCppBackend): AdaptiveBackend {
  return new AdaptiveBackend(inner, { mode: "adaptive" });
}

function adapter(): MultiBackendWindowsAdapter {
  if (!_adapter) {
    _adapter = new MultiBackendWindowsAdapter({
      whisperCppBackend: withAdaptivePreprocessing(new WhisperCppBackend()),
    });
  }
  return _adapter;
}

async function deviceProfile(): Promise<DeviceProfile> {
  if (!_deviceProfile) _deviceProfile = await getDeviceProfile();
  return _deviceProfile;
}

export interface TranscribeParams {
  audioPath: string;
  durationMs?: number;
  settings: Partial<TranscriptionSettings>;
  userSpeechProfile?: UserSpeechProfile;
  /** Processing mode preset. Defaults to "balanced". */
  processingMode?: ProcessingMode;
  /** Fine-grained overrides for post-processing stages. */
  postProcessing?: PostProcessingOptions;
  /** Optional callback invoked for partial transcripts (v1, v2). */
  onPartial?: (partial: import("@stt/core").Transcript) => void;
}

export interface TranscribeOutput extends TranscriptionResult {
  routing: ModelSelectionResult;
}

export async function runTranscription(
  params: TranscribeParams
): Promise<TranscribeOutput> {
  const dev = await deviceProfile();
  const ad = adapter();

  const mergedSettings = mergeWithDefaults(params.settings);
  const installedModelIds = await ad.getAvailableModelIds();

  // Run routing separately so we can surface the debug info to the UI.
  // transcribeFile() will run the same routing internally — results are identical.
  const routing = chooseModel({
    settings: mergedSettings,
    device: dev,
    userSpeechProfile: params.userSpeechProfile,
    installedModelIds,
  });

  const adaptiveRules = await currentAdaptiveRules();

  const result = await transcribeFile({
    input: {
      audioPath: params.audioPath,
      durationMs: params.durationMs,
    },
    settings: params.settings as TranscriptionSettings,
    deviceProfile: dev,
    runtimeAdapter: ad,
    userSpeechProfile: params.userSpeechProfile,
    processingMode: params.processingMode ?? "balanced",
    postProcessing: params.postProcessing,
    adaptiveRules,
    onPartial: params.onPartial,
  });

  return { ...result, routing };
}

/**
 * Persist a user-edited transcript as a feedback event and invalidate the
 * in-memory adaptive-rules cache so the next transcription picks it up.
 */
export async function appendFeedback(entry: FeedbackEntry): Promise<void> {
  await feedbackStore().append(entry);
  invalidateAdaptiveRules();
}

export async function clearFeedback(): Promise<void> {
  await feedbackStore().clear();
  invalidateAdaptiveRules();
}

export async function listFeedback(limit?: number): Promise<FeedbackEntry[]> {
  return feedbackStore().list(limit);
}

export async function getInstalledModels(): Promise<string[]> {
  return adapter().getAvailableModelIds();
}

export async function getDevice(): Promise<DeviceProfile> {
  return deviceProfile();
}

export async function isBackendAvailable(): Promise<boolean> {
  return adapter().getWhisperBackend().isAvailable();
}

/**
 * Downloads and installs the right whisper-cli binary for this device if not
 * already present. Should be called once at server startup.
 * Returns the variant installed ("cpu" | "vulkan" | "cuda").
 */
export async function initBinary(
  onProgress?: (msg: string) => void
): Promise<BinaryVariant> {
  const dev = await deviceProfile();
  const result = await ensureBinary(dev, onProgress);
  _binaryVariant = result.variant;

  // Rebuild adapter with the correct binary path, wrapped in AdaptiveBackend.
  _adapter = new MultiBackendWindowsAdapter({
    whisperCppBackend: withAdaptivePreprocessing(
      new WhisperCppBackend({ binaryPath: result.binaryPath }),
    ),
  });

  return result.variant;
}

export async function getBinaryVariant(): Promise<BinaryVariant | null> {
  if (_binaryVariant) return _binaryVariant;
  return getInstalledVariant();
}

export async function registerModel(
  modelId: string,
  filePath: string,
  displayName?: string
): Promise<void> {
  await adapter().getModelStore().registerModel(modelId, filePath, displayName);
  // Force health re-read next time
  adapter().getModelStore().invalidateCache();
}

export async function unregisterModel(modelId: string): Promise<void> {
  await adapter().getModelStore().unregisterModel(modelId);
  adapter().getModelStore().invalidateCache();
}

/**
 * Returns the best model for each mode based on the user's device and language
 * selection. Does NOT filter by installed models — used for download recommendations.
 */
export async function getRecommendations(
  langs: string[],
  profile?: UserSpeechProfile
): Promise<PerModeRecommendations> {
  const dev = await deviceProfile();
  // Derive a single whisper language code: one lang → use it, many → auto
  const realLangs = langs.filter((l) => l !== "auto" && l !== "multilingual" && l !== "hinglish");
  const language = realLangs.length === 1 ? realLangs[0]! : "auto";

  // Pass all selected languages as primaryLanguages so multilingual need is scored correctly
  const enrichedProfile: UserSpeechProfile = {
    ...profile,
    primaryLanguages: langs.filter((l) => l !== "auto" && l !== "multilingual"),
    mixesLanguages: langs.length > 1 && !langs.includes("auto"),
  };

  return getPerModeRecommendations(dev, language, enrichedProfile);
}

/**
 * Per-model device-compatibility entry. `compatible: false` means the model
 * would exceed the device's RAM / storage / CPU-tier budget and is therefore
 * hard-filtered from download in the UI.
 */
export interface ModelCompatibilityEntry {
  modelId: string;
  displayName: string;
  sizeMB: number;
  compatible: boolean;
  /** Human-readable reason when `compatible` is false; null otherwise. */
  reason: string | null;
}

/**
 * Returns every stt-core-registered model paired with a hard device-compat
 * check (RAM / storage / CPU tier). Used by the Model Manager "All models"
 * tab to gate the Download button.
 */
export async function getModelCatalogCompatibility(): Promise<ModelCompatibilityEntry[]> {
  const dev = await deviceProfile();
  return getAllModels().map((model) => {
    const reason = incompatibilityReason(model, dev);
    return {
      modelId: model.id,
      displayName: model.displayName,
      sizeMB: model.sizeMB,
      compatible: reason === null,
      reason,
    };
  });
}

export function getBackendPath(): string {
  let whisperBackend: unknown = adapter().getWhisperBackend();
  // Unwrap AdaptiveBackend if present.
  if (
    whisperBackend &&
    typeof whisperBackend === "object" &&
    "getInner" in whisperBackend &&
    typeof (whisperBackend as Record<string, unknown>).getInner === "function"
  ) {
    whisperBackend = (whisperBackend as { getInner(): unknown }).getInner();
  }
  if (
    whisperBackend &&
    typeof whisperBackend === "object" &&
    "getBinaryPath" in whisperBackend &&
    typeof (whisperBackend as Record<string, unknown>).getBinaryPath === "function"
  ) {
    return (whisperBackend as { getBinaryPath(): string }).getBinaryPath();
  }
  return "unknown";
}
