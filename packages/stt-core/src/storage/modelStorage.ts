import type { STTModelMetadata } from "../types";

/**
 * Contract for persisting model registry state and tracking which models are
 * downloaded on-device. Platform bridges implement this; stt-core depends only
 * on the interface.
 */
export interface ModelStorage {
  /** Returns ids of models whose weight files are present on-device. */
  getInstalledModelIds(): Promise<string[]>;

  /** Marks a model as installed (called by the platform bridge after download). */
  markInstalled(modelId: string, meta: STTModelMetadata): Promise<void>;

  /** Removes a model's local files and installation record. */
  uninstall(modelId: string): Promise<void>;

  /** Returns the stored metadata for an installed model, or null. */
  getInstalledModelMeta(modelId: string): Promise<STTModelMetadata | null>;
}
