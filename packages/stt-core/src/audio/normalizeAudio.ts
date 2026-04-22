import type { NormalizationOptions } from "./audioTypes";
import { DEFAULT_NORMALIZATION } from "./audioTypes";

/**
 * Returns the normalization parameters that should be applied to an audio file
 * before handing it to the runtime adapter.
 *
 * stt-core does not perform actual DSP — the runtime bridge is responsible for
 * applying these parameters before calling the model. This function provides
 * the contract (what the model needs) so each bridge knows what to produce.
 */
export function getNormalizationTarget(
  override?: Partial<NormalizationOptions>
): NormalizationOptions {
  return { ...DEFAULT_NORMALIZATION, ...override };
}

/**
 * Returns true if the described audio already meets normalization requirements.
 * Avoids unnecessary re-encoding by the runtime bridge.
 */
export function isAlreadyNormalized(
  actual: { sampleRate?: number; channelCount?: number },
  target: NormalizationOptions = DEFAULT_NORMALIZATION
): boolean {
  if (actual.sampleRate !== undefined && actual.sampleRate !== target.targetSampleRate) {
    return false;
  }
  if (actual.channelCount !== undefined && actual.channelCount !== target.targetChannels) {
    return false;
  }
  return true;
}
