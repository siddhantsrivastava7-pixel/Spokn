import * as path from "path";
import * as os from "os";

// Spokn's macOS app data lives under the user's Library dir. Matches Apple's
// guidance for app support data (model weights, manifests, feedback JSONL).
// The path intentionally uses the product bundle id fragment "spokn" rather
// than the package name so the folder is shared across any future sibling
// apps that bundle this adapter.
const APP_DIR = "spokn";

/**
 * Returns the root directory where this SDK stores all persistent data on
 * macOS. Matches Apple's recommendation: `~/Library/Application Support/<App>`.
 *
 * Falls back to `~/.spokn` only when `os.homedir()` is somehow unavailable
 * (dev / test contexts) — never writes to `/tmp` or the current working
 * directory by accident.
 */
export function getAppDataRoot(): string {
  const home = os.homedir();
  if (!home) return path.join(".", APP_DIR);
  return path.join(home, "Library", "Application Support", APP_DIR);
}

export function getModelsDir(): string {
  return path.join(getAppDataRoot(), "models");
}

export function getModelDir(modelId: string): string {
  return path.join(getModelsDir(), sanitizeModelId(modelId));
}

export function getBinDir(): string {
  return path.join(getAppDataRoot(), "bin");
}

export function getTempDir(): string {
  return path.join(getAppDataRoot(), "tmp");
}

export function getFeedbackDir(): string {
  return path.join(getAppDataRoot(), "feedback");
}

export function getFeedbackFilePath(): string {
  return path.join(getFeedbackDir(), "entries.jsonl");
}

/** Strips characters unsafe for directory names. */
export function sanitizeModelId(modelId: string): string {
  return modelId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function getManifestPath(): string {
  return path.join(getModelsDir(), "manifest.json");
}
