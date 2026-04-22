import { spawn } from "child_process";

/**
 * Resolves the ffmpeg executable path.
 *
 * Precedence:
 *   1. Explicit `ffmpegPath` option (e.g. Tauri-resolved resource path).
 *   2. Probe `ffmpeg -version` on PATH.
 *   3. Return `undefined` — the calling backend will degrade to a no-op.
 *
 * Results are cached per-process so we don't re-probe on every call.
 */
export interface FfmpegResolution {
  /** Executable to invoke, or undefined if no ffmpeg is available. */
  path: string | undefined;
  /** Source of the resolution. */
  source: "explicit" | "path" | "not_found";
}

let cachedPathProbe: Promise<string | undefined> | undefined;

export async function resolveFfmpegPath(explicit?: string): Promise<FfmpegResolution> {
  if (explicit && explicit.trim().length > 0) {
    return { path: explicit, source: "explicit" };
  }
  const fromPath = await probePathForFfmpeg();
  if (fromPath) return { path: fromPath, source: "path" };
  return { path: undefined, source: "not_found" };
}

/**
 * Clears the PATH probe cache. Useful in tests; otherwise a process installs
 * ffmpeg exactly once.
 */
export function _resetFfmpegPathCache(): void {
  cachedPathProbe = undefined;
}

function probePathForFfmpeg(): Promise<string | undefined> {
  if (!cachedPathProbe) {
    cachedPathProbe = new Promise<string | undefined>((resolve) => {
      try {
        const child = spawn("ffmpeg", ["-version"], {
          windowsHide: true,
          shell: false,
        });
        child.on("error", () => resolve(undefined));
        child.on("close", (code) => {
          resolve(code === 0 ? "ffmpeg" : undefined);
        });
      } catch {
        resolve(undefined);
      }
    });
  }
  return cachedPathProbe;
}
