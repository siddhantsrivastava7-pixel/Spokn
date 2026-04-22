/**
 * Manifest file format stored in the models directory.
 * Tracks which model files are present and their metadata.
 */
export interface ModelManifestEntry {
  modelId: string;
  fileName: string;
  /** Absolute path to the model file on disk. Takes priority over fileName-based lookup. */
  fullPath?: string;
  installedAt: string; // ISO 8601
  sizeMB: number;
  /** Optional display name sourced from registry at install time */
  displayName?: string;
}

export interface ModelManifest {
  version: 1;
  entries: ModelManifestEntry[];
}

export function emptyManifest(): ModelManifest {
  return { version: 1, entries: [] };
}
