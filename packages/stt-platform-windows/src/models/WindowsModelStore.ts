import * as path from "path";
import {
  getManifestPath,
  getModelDir,
  getModelsDir,
} from "../utils/pathUtils";
import {
  ensureDir,
  fileExists,
  fileSizeMB,
  readJsonFile,
  writeJsonFile,
} from "../utils/fsUtils";
import {
  emptyManifest,
  ModelManifest,
  ModelManifestEntry,
} from "./modelManifest";
import { resolveModelPath } from "./resolveModelPath";

/**
 * Manages locally installed model files on Windows.
 * All state is persisted in a manifest.json alongside the model directories.
 */
export class WindowsModelStore {
  private manifestCache: ModelManifest | null = null;

  async listInstalledModels(): Promise<ModelManifestEntry[]> {
    const manifest = await this.loadManifest();
    const valid: ModelManifestEntry[] = [];
    for (const entry of manifest.entries) {
      const modelPath = entry.fullPath ?? path.join(getModelDir(entry.modelId), entry.fileName);
      if (await fileExists(modelPath)) {
        valid.push(entry);
      }
    }
    return valid;
  }

  async isInstalled(modelId: string): Promise<boolean> {
    const entries = await this.listInstalledModels();
    return entries.some((e) => e.modelId === modelId);
  }

  async getModelPath(modelId: string): Promise<string> {
    const entry = await this.getEntry(modelId);
    if (entry?.fullPath) return entry.fullPath;
    return resolveModelPath(modelId, entry ?? undefined);
  }

  async getInstalledModelMetadata(
    modelId: string
  ): Promise<ModelManifestEntry | null> {
    return this.getEntry(modelId);
  }

  /**
   * Registers an already-downloaded model file into the manifest.
   * The file must already be present at the given absolute path.
   */
  async registerModel(
    modelId: string,
    absoluteFilePath: string,
    displayName?: string
  ): Promise<void> {
    const exists = await fileExists(absoluteFilePath);
    if (!exists) {
      throw new Error(`Model file not found: ${absoluteFilePath}`);
    }

    const targetDir = getModelDir(modelId);
    const fileName = path.basename(absoluteFilePath);
    await ensureDir(targetDir);

    const sizeMB = await fileSizeMB(absoluteFilePath);
    const entry: ModelManifestEntry = {
      modelId,
      fileName,
      fullPath: absoluteFilePath,
      installedAt: new Date().toISOString(),
      sizeMB: Math.round(sizeMB),
      displayName,
    };

    const manifest = await this.loadManifest();
    const existingIdx = manifest.entries.findIndex(
      (e) => e.modelId === modelId
    );
    if (existingIdx >= 0) {
      manifest.entries[existingIdx] = entry;
    } else {
      manifest.entries.push(entry);
    }

    await this.saveManifest(manifest);
  }

  async unregisterModel(modelId: string): Promise<void> {
    const manifest = await this.loadManifest();
    manifest.entries = manifest.entries.filter((e) => e.modelId !== modelId);
    await this.saveManifest(manifest);
  }

  /** Returns the expected directory where a model's files should live. */
  getExpectedModelDir(modelId: string): string {
    return getModelDir(modelId);
  }

  /** Returns the base models directory. */
  getModelsRoot(): string {
    return getModelsDir();
  }

  private async getEntry(
    modelId: string
  ): Promise<ModelManifestEntry | null> {
    const manifest = await this.loadManifest();
    return manifest.entries.find((e) => e.modelId === modelId) ?? null;
  }

  private async loadManifest(): Promise<ModelManifest> {
    if (this.manifestCache) return this.manifestCache;

    const manifestPath = getManifestPath();
    if (!(await fileExists(manifestPath))) {
      this.manifestCache = emptyManifest();
      return this.manifestCache;
    }

    try {
      this.manifestCache = await readJsonFile<ModelManifest>(manifestPath);
    } catch {
      this.manifestCache = emptyManifest();
    }
    return this.manifestCache;
  }

  private async saveManifest(manifest: ModelManifest): Promise<void> {
    this.manifestCache = manifest;
    await writeJsonFile(getManifestPath(), manifest);
  }

  /** Clears the in-memory manifest cache, forcing a re-read next access. */
  invalidateCache(): void {
    this.manifestCache = null;
  }
}
