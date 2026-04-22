import * as path from "path";
import * as os from "os";

const APP_NAME = "stt-platform-windows";

/**
 * Returns the root directory where this SDK stores all persistent data.
 * Prefers %LOCALAPPDATA% on Windows; falls back to home dir for dev/test.
 */
export function getAppDataRoot(): string {
  const localAppData =
    process.env["LOCALAPPDATA"] ??
    path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, APP_NAME);
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
