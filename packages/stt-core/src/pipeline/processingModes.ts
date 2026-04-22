import type { ProcessingMode } from "../types";

/**
 * Preset for a processing mode. The pipeline reads these flags once at the
 * top of transcribeFile(); explicit per-call postProcessing.* fields still
 * override individual flags at runtime.
 */
export interface ProcessingModePreset {
  preprocessing: "never" | "adaptive" | "always";
  selectiveReprocess: boolean;
  /** light = base cleanup + light-mode intent formatting only. full = everything. */
  postProcessingDepth: "light" | "full";
  latencyBudgetMs: number;
}

export const PROCESSING_MODES: Record<ProcessingMode, ProcessingModePreset> = {
  instant: {
    preprocessing: "never",
    selectiveReprocess: false,
    postProcessingDepth: "light",
    latencyBudgetMs: 600,
  },
  balanced: {
    preprocessing: "adaptive",
    selectiveReprocess: true,
    postProcessingDepth: "full",
    latencyBudgetMs: 1200,
  },
  accuracy: {
    preprocessing: "always",
    selectiveReprocess: true,
    postProcessingDepth: "full",
    latencyBudgetMs: 4000,
  },
};

export function presetFor(mode: ProcessingMode | undefined): ProcessingModePreset {
  return PROCESSING_MODES[mode ?? "balanced"];
}
