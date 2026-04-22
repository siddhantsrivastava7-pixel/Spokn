import type {
  STTModelMetadata,
  DeviceProfile,
  SupportedLanguage,
  TranscriptionMode,
  CpuTier,
} from "../types";

const CPU_TIER_RANK: Record<CpuTier, number> = { low: 0, mid: 1, high: 2 };

/** Returns true if the model can run on the given device. */
export function isCompatibleWithDevice(
  model: STTModelMetadata,
  device: DeviceProfile
): boolean {
  const caps = model.capabilities;

  if (device.ramMB < caps.minRamMB) return false;
  if (device.storageAvailableMB < caps.minStorageMB) return false;
  if (CPU_TIER_RANK[device.cpuTier] < CPU_TIER_RANK[caps.minCpuTier]) return false;

  return true;
}

/** Returns a human-readable string explaining why the model is incompatible, or null if compatible. */
export function incompatibilityReason(
  model: STTModelMetadata,
  device: DeviceProfile
): string | null {
  const caps = model.capabilities;

  if (device.ramMB < caps.minRamMB) {
    return `${model.displayName} requires ${caps.minRamMB} MB RAM (device has ${device.ramMB} MB)`;
  }
  if (device.storageAvailableMB < caps.minStorageMB) {
    return `${model.displayName} requires ${caps.minStorageMB} MB storage (device has ${device.storageAvailableMB} MB available)`;
  }
  if (CPU_TIER_RANK[device.cpuTier] < CPU_TIER_RANK[caps.minCpuTier]) {
    return `${model.displayName} requires a ${caps.minCpuTier} CPU tier (device is ${device.cpuTier})`;
  }

  return null;
}

/** Returns true if the model supports the requested language. */
export function supportsLanguage(
  model: STTModelMetadata,
  language: SupportedLanguage
): boolean {
  const langs = model.capabilities.supportedLanguages;
  // "multilingual" or "auto" in the model's list means it handles everything
  if (langs.includes("multilingual") || langs.includes("auto")) return true;
  return langs.includes(language);
}

/** Returns true if the model recommends the given mode. */
export function supportsMode(
  model: STTModelMetadata,
  mode: TranscriptionMode
): boolean {
  // "auto" mode is always accepted — routing decides the actual mode
  if (mode === "auto") return true;
  return model.capabilities.recommendedModes.includes(mode);
}
