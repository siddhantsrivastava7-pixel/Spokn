import type { STTModelMetadata, DeviceProfile, BatteryImpact, MemoryProfile } from "../types";
import type { UserSpeechProfile } from "../types/userSpeechProfile";

// ─── Battery preference ────────────────────────────────────────────────────────

/**
 * Battery impact penalties (in score points).
 * Applied only when the user or device signals battery concern.
 * Penalties never block a model — they only reorder compatible candidates.
 */
const BATTERY_PENALTY: Record<BatteryImpact, number> = {
  minimal: 0,
  low:     0,
  medium: -5,
  high:   -10,
};

export function scoreBatteryFit(
  model: STTModelMetadata,
  device: DeviceProfile,
  profile: UserSpeechProfile | undefined
): { score: number; reasons: string[] } {
  const wantLow =
    device.batterySaverActive ||
    device.lowPowerMode ||
    profile?.prefersLowBatteryUsage === true;

  if (!wantLow) return { score: 0, reasons: [] };

  const penalty = BATTERY_PENALTY[model.capabilities.batteryImpact];
  const reasons: string[] = [];

  if (penalty < 0) {
    reasons.push(
      `Battery-conscious context — "${model.capabilities.batteryImpact}" impact model penalized (${penalty} pts)`
    );
  }

  return { score: penalty, reasons };
}

// ─── Storage preference ────────────────────────────────────────────────────────

/**
 * Storage size penalties (in score points).
 * Applied only when the user signals storage concern.
 */
const STORAGE_PENALTY: Record<MemoryProfile, number> = {
  tiny:   0,
  small:  0,
  medium: -5,
  large: -10,
};

export function scoreStorageFit(
  model: STTModelMetadata,
  profile: UserSpeechProfile | undefined
): { score: number; reasons: string[] } {
  const wantSmall = profile?.prefersLowStorageUsage === true;

  if (!wantSmall) return { score: 0, reasons: [] };

  const penalty = STORAGE_PENALTY[model.capabilities.memoryProfile];
  const reasons: string[] = [];

  if (penalty < 0) {
    reasons.push(
      `Storage-conscious preference — "${model.capabilities.memoryProfile}" model penalized (${penalty} pts)`
    );
  }

  return { score: penalty, reasons };
}
