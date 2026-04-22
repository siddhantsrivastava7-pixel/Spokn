import * as path from "path";
import { getModelDir } from "../utils/pathUtils";
import { fileExists } from "../utils/fsUtils";
import { ModelFileNotFoundError } from "../errors";
import type { ModelManifestEntry } from "./modelManifest";

/** GGUF is the default whisper.cpp model format. */
const SUPPORTED_EXTENSIONS = [".gguf", ".bin"];

/**
 * Resolves the absolute path to a model's weight file.
 * Checks manifest entry first, then falls back to extension scan.
 */
export async function resolveModelPath(
  modelId: string,
  entry?: ModelManifestEntry
): Promise<string> {
  if (entry) {
    const candidate = path.join(getModelDir(modelId), entry.fileName);
    if (await fileExists(candidate)) return candidate;
  }

  const dir = getModelDir(modelId);
  for (const ext of SUPPORTED_EXTENSIONS) {
    // Conventional naming: ggml-<modelId>.gguf
    const candidates = [
      path.join(dir, `ggml-${modelId}${ext}`),
      path.join(dir, `${modelId}${ext}`),
      path.join(dir, `model${ext}`),
    ];
    for (const p of candidates) {
      if (await fileExists(p)) return p;
    }
  }

  throw new ModelFileNotFoundError(modelId, dir);
}
