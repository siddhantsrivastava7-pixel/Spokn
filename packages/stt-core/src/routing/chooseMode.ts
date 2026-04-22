import type { TranscriptionMode, DeviceProfile } from "../types";
import type { UserSpeechProfile } from "../types/userSpeechProfile";
import type { ResolvedMode, ResolvedTranscriptionMode } from "../types/routingTypes";
import { computeMultilingualNeed } from "./languageProfile";
import type { TranscriptionSettings } from "../types";

/**
 * Resolves "auto" to a concrete transcription mode using device traits,
 * user speech profile, and language complexity signals.
 *
 * Returns the input mode unchanged (with a reason) when the caller already
 * picked a concrete mode — this allows `resolveMode` to always be called
 * in the pipeline regardless of whether mode is "auto".
 */
export function resolveMode(
  mode: TranscriptionMode,
  device: DeviceProfile,
  settings?: TranscriptionSettings,
  profile?: UserSpeechProfile
): ResolvedMode {
  // ── Non-auto: respect the user's explicit choice ─────────────────────────
  if (mode !== "auto") {
    const resolved = mode as ResolvedTranscriptionMode;

    // Downgrade best_accuracy on low-end devices with a clear reason
    if (resolved === "best_accuracy" && device.cpuTier === "low" && device.ramMB < 1024) {
      return {
        mode: "balanced",
        reason: `Requested "best_accuracy" downgraded to "balanced" — device is low-end (${device.cpuTier} CPU, ${device.ramMB} MB RAM)`,
      };
    }

    return {
      mode: resolved,
      reason: `User explicitly selected "${resolved}"`,
    };
  }

  // ── Auto: resolve from context ────────────────────────────────────────────

  // 1. Device power constraints take top priority
  if (device.batterySaverActive || device.lowPowerMode) {
    return { mode: "fast", reason: `"auto" → "fast": device battery saver / low-power mode is active` };
  }

  // 2. Low-end hardware can't support balanced/accurate models
  if (device.cpuTier === "low") {
    return { mode: "fast", reason: `"auto" → "fast": low-end CPU tier` };
  }

  // 3. User's onboarding preference (optional — not always set)
  if (profile?.preferredMode && profile.preferredMode !== "auto") {
    const preferred = profile.preferredMode as ResolvedTranscriptionMode;
    return {
      mode: preferred,
      reason: `"auto" → "${preferred}": user's onboarding preference`,
    };
  }

  // 4. User prefers low battery → downgrade from best_accuracy
  if (profile?.prefersLowBatteryUsage) {
    return {
      mode: "balanced",
      reason: `"auto" → "balanced": user prefers low battery usage`,
    };
  }

  // 5. Language complexity — multilingual users need balanced or better
  if (settings) {
    const need = computeMultilingualNeed(settings, profile, profile?.countryCode);
    if (need >= 0.7) {
      return {
        mode: "balanced",
        reason: `"auto" → "balanced": high multilingual need (${need.toFixed(2)}) — accuracy matters for mixed-language input`,
      };
    }
  }

  // 6. High-end device → best accuracy
  // RAM >= 16 GB and/or dedicated GPU with 4 GB+ VRAM are reliable high-end signals.
  // CPU tier is a secondary check; tier detection can be unreliable on Windows (speed = 0).
  const hasCapableGpu = (device.gpuVramMB ?? 0) >= 4_096 &&
    (device.gpuVendor === "nvidia" || device.gpuVendor === "amd");
  const isHighEnd =
    device.ramMB >= 16_384 ||
    hasCapableGpu ||
    (device.cpuTier === "high" && device.ramMB >= 6_144);
  if (isHighEnd) {
    const reason = hasCapableGpu
      ? `${device.gpuVendor?.toUpperCase()} GPU (${Math.round((device.gpuVramMB ?? 0) / 1024)} GB VRAM)`
      : `${Math.round(device.ramMB / 1024)} GB RAM`;
    return {
      mode: "best_accuracy",
      reason: `"auto" → "best_accuracy": high-end device — ${reason}`,
    };
  }

  // 7. Mid-tier with decent RAM → balanced
  if (device.ramMB >= 4_096) {
    return {
      mode: "balanced",
      reason: `"auto" → "balanced": mid-tier device (${Math.round(device.ramMB / 1024)} GB RAM)`,
    };
  }

  // 8. Fallback: fast for constrained devices
  return {
    mode: "fast",
    reason: `"auto" → "fast": constrained device (${Math.round(device.ramMB / 1024)} GB RAM)`,
  };
}
