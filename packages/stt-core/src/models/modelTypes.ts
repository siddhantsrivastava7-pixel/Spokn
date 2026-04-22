import type { STTModelMetadata } from "../types";

/** Subset of metadata used when listing models in a UI or selection step */
export interface ModelSummary {
  id: string;
  displayName: string;
  sizeMB: number;
  latencyTier: STTModelMetadata["capabilities"]["latencyTier"];
  batteryImpact: STTModelMetadata["capabilities"]["batteryImpact"];
}
