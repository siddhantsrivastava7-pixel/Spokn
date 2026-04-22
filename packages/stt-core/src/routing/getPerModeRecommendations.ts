import type { DeviceProfile, TranscriptionMode } from "../types";
import type { UserSpeechProfile, ModelSelectionResult } from "../types";
import { chooseModel } from "./chooseModel";
import { mergeWithDefaults } from "../settings/validateSettings";

export interface PerModeRecommendations {
  fast: ModelSelectionResult;
  balanced: ModelSelectionResult;
  best_accuracy: ModelSelectionResult;
  /** What the router would auto-pick for this specific user — the model to download first. */
  auto: ModelSelectionResult;
}

/**
 * Run the full routing pipeline for every explicit mode without filtering by
 * installed models, so the result reflects the ideal download target for each
 * mode given this user's device and language context.
 *
 * Pass the user's selected language codes as `primaryLanguages` in the profile
 * so that multilingual need is scored correctly.
 */
export function getPerModeRecommendations(
  device: DeviceProfile,
  language: string,
  profile?: UserSpeechProfile
): PerModeRecommendations {
  const MODES: TranscriptionMode[] = ["fast", "balanced", "best_accuracy", "auto"];

  const results = {} as PerModeRecommendations;

  for (const mode of MODES) {
    const settings = mergeWithDefaults({ mode, language: language as import("../types").SupportedLanguage, offlineOnly: true });
    results[mode] = chooseModel({
      settings,
      device,
      userSpeechProfile: profile,
      // Deliberately no installedModelIds — recommend from full catalog
    });
  }

  return results;
}
