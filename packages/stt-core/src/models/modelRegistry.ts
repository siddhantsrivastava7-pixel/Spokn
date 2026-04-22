import type {
  STTModelMetadata,
  DeviceProfile,
  Platform,
  SupportedLanguage,
  TranscriptionMode,
  BackendId,
} from "../types";
import {
  isCompatibleWithDevice,
  supportsLanguage,
  supportsMode,
} from "./modelCapabilities";

// ─── Platform sets ───────────────────────────────────────────────────────────
// whisper-cpp: GGUF weights + native binary — works on all native platforms
const WHISPER_CPP_PLATFORMS: Platform[] = ["windows", "macos", "linux", "android", "ios"];
// transformers-js: ONNX Runtime (Node.js + browser) — not React Native without extra work
const TRANSFORMERS_JS_PLATFORMS: Platform[] = ["windows", "macos", "linux", "web"];

// ─── Seed Registry ────────────────────────────────────────────────────────────
// Realistic placeholder entries. Inference is NOT implemented here —
// these are metadata records only. Actual weights are loaded by the runtime adapter.

const REGISTRY: STTModelMetadata[] = [
  // ── Whisper.cpp family (ggml weights, offline, multilingual) ─────────────
  // backendId: "whisper-cpp" on all entries below
  {
    id: "whisper-tiny",
    backendId: "whisper-cpp" as BackendId,
    supportedPlatforms: WHISPER_CPP_PLATFORMS,
    displayName: "Whisper Tiny",
    sizeMB: 77,
    version: "v3",
    releaseDate: "2022-09-21",
    description: "Smallest whisper model. Runs on any hardware. Low accuracy but near-instant.",
    capabilities: {
      supportsStreaming: false,
      supportsOffline: true,
      supportsTimestamps: true,
      supportedLanguages: ["multilingual"],
      minRamMB: 256,
      minStorageMB: 90,
      minCpuTier: "low",
      recommendedModes: ["fast", "auto"],
      latencyTier: "realtime",
      batteryImpact: "minimal",
      memoryProfile: "tiny",
    },
  },
  {
    id: "whisper-base",
    backendId: "whisper-cpp" as BackendId,
    supportedPlatforms: WHISPER_CPP_PLATFORMS,
    displayName: "Whisper Base",
    sizeMB: 148,
    version: "v3",
    releaseDate: "2022-09-21",
    description: "Compact multilingual model. Good for simple speech on low-end devices.",
    capabilities: {
      supportsStreaming: false,
      supportsOffline: true,
      supportsTimestamps: true,
      supportedLanguages: ["multilingual"],
      minRamMB: 512,
      minStorageMB: 170,
      minCpuTier: "low",
      recommendedModes: ["fast", "auto"],
      latencyTier: "realtime",
      batteryImpact: "low",
      memoryProfile: "tiny",
    },
  },
  {
    id: "whisper-small",
    backendId: "whisper-cpp" as BackendId,
    supportedPlatforms: WHISPER_CPP_PLATFORMS,
    displayName: "Whisper Small",
    sizeMB: 488,
    version: "v3",
    releaseDate: "2022-09-21",
    description: "Strong accuracy across all languages. Best choice for 2–4 GB RAM devices.",
    capabilities: {
      supportsStreaming: false,
      supportsOffline: true,
      supportsTimestamps: true,
      supportedLanguages: ["multilingual"],
      minRamMB: 1024,
      minStorageMB: 520,
      minCpuTier: "low",
      recommendedModes: ["fast", "balanced", "auto"],
      latencyTier: "fast",
      batteryImpact: "low",
      memoryProfile: "small",
    },
  },
  {
    id: "whisper-medium",
    backendId: "whisper-cpp" as BackendId,
    supportedPlatforms: WHISPER_CPP_PLATFORMS,
    displayName: "Whisper Medium",
    sizeMB: 1530,
    version: "v3",
    releaseDate: "2022-09-21",
    description: "High accuracy for all languages including South Asian and European. Ideal for 4–8 GB RAM.",
    capabilities: {
      supportsStreaming: false,
      supportsOffline: true,
      supportsTimestamps: true,
      supportedLanguages: ["multilingual"],
      minRamMB: 2048,
      minStorageMB: 1600,
      minCpuTier: "mid",
      recommendedModes: ["balanced", "best_accuracy", "auto"],
      latencyTier: "normal",
      batteryImpact: "medium",
      memoryProfile: "medium",
    },
  },
  {
    id: "whisper-large-v3-turbo",
    backendId: "whisper-cpp" as BackendId,
    supportedPlatforms: WHISPER_CPP_PLATFORMS,
    displayName: "Whisper Large v3 Turbo",
    sizeMB: 1620,
    version: "v3-turbo",
    releaseDate: "2024-09-30",
    description: "Distilled large-v3 — near large-v3 accuracy at 2× the speed. Best for multilingual and Asian languages.",
    capabilities: {
      supportsStreaming: false,
      supportsOffline: true,
      supportsTimestamps: true,
      supportedLanguages: ["multilingual"],
      minRamMB: 4096,
      minStorageMB: 1700,
      minCpuTier: "mid",
      recommendedModes: ["balanced", "best_accuracy", "auto"],
      latencyTier: "fast",
      batteryImpact: "medium",
      memoryProfile: "large",
    },
  },
  {
    id: "whisper-turbo",
    backendId: "whisper-cpp" as BackendId,
    supportedPlatforms: WHISPER_CPP_PLATFORMS,
    displayName: "Whisper Turbo",
    sizeMB: 809,
    version: "20240930",
    releaseDate: "2024-09-30",
    description: "Fast multilingual model optimized for speed on consumer hardware.",
    capabilities: {
      supportsStreaming: false,
      supportsOffline: true,
      supportsTimestamps: true,
      supportedLanguages: ["multilingual"],
      minRamMB: 1024,
      minStorageMB: 850,
      minCpuTier: "mid",
      recommendedModes: ["fast", "balanced", "auto"],
      latencyTier: "fast",
      batteryImpact: "medium",
      memoryProfile: "medium",
    },
  },
  {
    id: "whisper-large-v3",
    backendId: "whisper-cpp" as BackendId,
    supportedPlatforms: WHISPER_CPP_PLATFORMS,
    displayName: "Whisper Large v3",
    sizeMB: 2880,
    version: "v3",
    releaseDate: "2023-11-06",
    description: "Highest-accuracy multilingual Whisper model.",
    capabilities: {
      supportsStreaming: false,
      supportsOffline: true,
      supportsTimestamps: true,
      supportedLanguages: ["multilingual"],
      minRamMB: 4096,
      minStorageMB: 3000,
      minCpuTier: "high",
      recommendedModes: ["best_accuracy", "balanced", "auto"],
      latencyTier: "slow",
      batteryImpact: "high",
      memoryProfile: "large",
    },
  },
  {
    id: "parakeet-v3",
    backendId: "whisper-cpp" as BackendId,
    supportedPlatforms: WHISPER_CPP_PLATFORMS,
    displayName: "Parakeet v3",
    sizeMB: 490,
    version: "3.0",
    releaseDate: "2024-06-01",
    description: "High-accuracy English-only model from NVIDIA NeMo. Low latency.",
    capabilities: {
      supportsStreaming: true,
      supportsOffline: true,
      supportsTimestamps: true,
      supportedLanguages: ["en"],
      minRamMB: 512,
      minStorageMB: 520,
      minCpuTier: "low",
      recommendedModes: ["fast", "balanced", "best_accuracy", "auto"],
      latencyTier: "realtime",
      batteryImpact: "low",
      memoryProfile: "small",
    },
  },
  {
    id: "moonshine-base",
    backendId: "whisper-cpp" as BackendId,
    supportedPlatforms: WHISPER_CPP_PLATFORMS,
    displayName: "Moonshine Base",
    sizeMB: 195,
    version: "1.0",
    releaseDate: "2024-10-15",
    description: "Ultra-compact English model designed for always-on edge devices.",
    capabilities: {
      supportsStreaming: true,
      supportsOffline: true,
      supportsTimestamps: false,
      supportedLanguages: ["en"],
      minRamMB: 256,
      minStorageMB: 210,
      minCpuTier: "low",
      recommendedModes: ["fast", "auto"],
      latencyTier: "realtime",
      batteryImpact: "minimal",
      memoryProfile: "tiny",
    },
  },

  // ── Transformers.js family (ONNX, HuggingFace auto-download, no Python) ──────
  // backendId: "transformers-js" on all entries below
  {
    id: "sense-voice-small",
    backendId: "transformers-js" as BackendId,
    supportedPlatforms: TRANSFORMERS_JS_PLATFORMS,
    huggingFaceId: "FunAudioLLM/SenseVoiceSmall",
    displayName: "SenseVoice Small",
    sizeMB: 270,
    version: "1.0",
    releaseDate: "2024-07-04",
    description: "Alibaba ONNX model. Excellent for Chinese, Japanese, Korean, Cantonese, and English. Emotion & event detection.",
    capabilities: {
      supportsStreaming: false,
      supportsOffline: true,
      supportsTimestamps: true,
      supportedLanguages: ["multilingual"],
      minRamMB: 512,
      minStorageMB: 300,
      minCpuTier: "low",
      recommendedModes: ["fast", "balanced", "auto"],
      latencyTier: "fast",
      batteryImpact: "low",
      memoryProfile: "small",
      confidenceScale: "none",
    },
  },
  {
    id: "whisper-large-v3-turbo-transformers",
    backendId: "transformers-js" as BackendId,
    supportedPlatforms: TRANSFORMERS_JS_PLATFORMS,
    huggingFaceId: "onnx-community/whisper-large-v3-turbo",
    displayName: "Whisper Large v3 Turbo (ONNX)",
    sizeMB: 1620,
    version: "v3-turbo",
    releaseDate: "2024-09-30",
    description: "ONNX version of Whisper Large v3 Turbo — runs via Transformers.js, no whisper-cli required.",
    capabilities: {
      supportsStreaming: false,
      supportsOffline: true,
      supportsTimestamps: true,
      supportedLanguages: ["multilingual"],
      minRamMB: 4096,
      minStorageMB: 1700,
      minCpuTier: "mid",
      recommendedModes: ["balanced", "best_accuracy", "auto"],
      latencyTier: "fast",
      batteryImpact: "medium",
      memoryProfile: "large",
      confidenceScale: "none",
    },
  },
];

// ─── Registry accessors ───────────────────────────────────────────────────────

/** Returns a snapshot of all registered models. */
export function getAllModels(): STTModelMetadata[] {
  return [...REGISTRY];
}

/** Returns a model by id, or undefined if not found. */
export function getModelById(id: string): STTModelMetadata | undefined {
  return REGISTRY.find((m) => m.id === id);
}

/** Returns all models that recommend the given transcription mode. */
export function getModelsByMode(mode: TranscriptionMode): STTModelMetadata[] {
  return REGISTRY.filter((m) => supportsMode(m, mode));
}

/** Returns all models compatible with the given device profile. */
export function getModelsCompatibleWithDevice(
  device: DeviceProfile
): STTModelMetadata[] {
  return REGISTRY.filter((m) => isCompatibleWithDevice(m, device));
}

/** Returns all models that support the requested language. */
export function getModelsCompatibleWithLanguage(
  language: SupportedLanguage
): STTModelMetadata[] {
  return REGISTRY.filter((m) => supportsLanguage(m, language));
}

/**
 * Compound filter: returns models that are compatible with the device,
 * support the language, and recommend the mode.
 */
export function queryModels(params: {
  device?: DeviceProfile;
  language?: SupportedLanguage;
  mode?: TranscriptionMode;
  offlineOnly?: boolean;
}): STTModelMetadata[] {
  let candidates = [...REGISTRY];

  if (params.offlineOnly) {
    candidates = candidates.filter((m) => m.capabilities.supportsOffline);
  }
  if (params.device) {
    candidates = candidates.filter((m) =>
      isCompatibleWithDevice(m, params.device!)
    );
  }
  if (params.language) {
    candidates = candidates.filter((m) =>
      supportsLanguage(m, params.language!)
    );
  }
  if (params.mode && params.mode !== "auto") {
    candidates = candidates.filter((m) => supportsMode(m, params.mode!));
  }

  return candidates;
}

/**
 * Register a custom model at runtime.
 * Useful for platform bridges that ship bundled models not in the default registry.
 */
export function registerModel(model: STTModelMetadata): void {
  const existing = REGISTRY.findIndex((m) => m.id === model.id);
  if (existing !== -1) {
    REGISTRY[existing] = model;
  } else {
    REGISTRY.push(model);
  }
}
