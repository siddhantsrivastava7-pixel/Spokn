import * as path from "path";
import * as os from "os";

// ── App-data root resolution ──────────────────────────────────────────────────
//
// Naming history: this module lives under `stt-platform-windows` for legacy
// reasons (the Windows port was built first), but the logic here is
// platform-aware and used by both Windows and macOS runtimes. A cleaner
// rename to `stt-platform-local` is possible but intentionally deferred —
// it would touch every import without changing behaviour.
//
// Resolution priority:
//   1. `STT_DATA_ROOT` env var — explicit override, used by tests and
//      packaged installers that want an app-specific location.
//   2. macOS → `~/Library/Application Support/spokn/` (Apple's guidance).
//   3. Windows → `%LOCALAPPDATA%/stt-platform-windows/` (back-compat; the
//      directory name is preserved so existing installs keep working).
//   4. Any other POSIX → `~/.local/share/spokn/` (XDG-style fallback).
//   5. Last resort → `./stt-platform-data/` in cwd.
//
// Rule: the path must be absolute and survive process restarts. No /tmp.
//
// Note on Windows legacy dir name: before macOS support, this package stored
// everything under `%LOCALAPPDATA%/stt-platform-windows/`. Windows users who
// installed earlier builds have state under that exact directory. Changing
// the name on Windows would orphan their models + feedback + installed
// binaries, so the Windows branch keeps it. The macOS branch picks a clean
// name (`spokn`) because there are no existing installs to preserve.

const MACOS_APP_DIR = "spokn";
const WINDOWS_LEGACY_APP_DIR = "stt-platform-windows";
const LINUX_APP_DIR = "spokn";

export function getAppDataRoot(): string {
  // 1. Explicit override
  const override = process.env["STT_DATA_ROOT"];
  if (override && override.length > 0) {
    return override;
  }

  const home = os.homedir();

  // 2. macOS
  if (process.platform === "darwin") {
    const base = home
      ? path.join(home, "Library", "Application Support")
      : path.join(".");
    return path.join(base, MACOS_APP_DIR);
  }

  // 3. Windows
  if (process.platform === "win32") {
    const localAppData =
      process.env["LOCALAPPDATA"] ??
      (home ? path.join(home, "AppData", "Local") : path.join("."));
    return path.join(localAppData, WINDOWS_LEGACY_APP_DIR);
  }

  // 4. Linux / other POSIX — XDG-style
  if (home) {
    const xdg = process.env["XDG_DATA_HOME"];
    const base = xdg && xdg.length > 0 ? xdg : path.join(home, ".local", "share");
    return path.join(base, LINUX_APP_DIR);
  }

  // 5. Last resort
  return path.join(".", "stt-platform-data");
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
